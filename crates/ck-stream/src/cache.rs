use std::{
    collections::{BTreeSet, HashMap, HashSet},
    hash::{BuildHasherDefault, Hasher},
    io,
    ops::Bound::{Excluded, Unbounded},
    panic::AssertUnwindSafe,
    sync::{
        Arc, Condvar, Mutex, RwLock, RwLockReadGuard, RwLockWriteGuard, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

use parking_lot::MutexGuard;

use crate::{
    Config, Error, Limits, Reader, Terminal, Writer,
    pool::Pool,
    publication::{State, Stream},
};

mod stats;
use stats::Failures;
pub use stats::StoreStats;

/// Monotonic elapsed time. Implementations must never move backwards.
pub trait Clock: Send + Sync + 'static {
    /// Must not panic: reads and lease drops call it after taking frame references and
    /// metadata charges, and an unwind there strands both.
    fn now(&self) -> Duration;
}

pub struct MonotonicClock(Instant);
impl Default for MonotonicClock {
    fn default() -> Self {
        Self(Instant::now())
    }
}
impl Clock for MonotonicClock {
    fn now(&self) -> Duration {
        self.0.elapsed()
    }
}

/// Injectable clock for retention tests and storage measurements, not wall-clock time.
#[derive(Default)]
pub struct ManualClock(AtomicU64);
impl ManualClock {
    pub fn advance(&self, duration: Duration) {
        let nanos = u64::try_from(duration.as_nanos()).expect("clock duration fits u64");
        checked_add(&self.0, nanos).expect("clock does not overflow");
    }
}
impl Clock for ManualClock {
    fn now(&self) -> Duration {
        Duration::from_nanos(self.0.load(Ordering::Acquire))
    }
}

fn checked_add(counter: &AtomicU64, increment: u64) -> Option<u64> {
    let mut old = counter.load(Ordering::Acquire);
    loop {
        let new = old.checked_add(increment)?;
        match counter.compare_exchange_weak(old, new, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) => return Some(old),
            Err(current) => old = current,
        }
    }
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// Maintenance failures since the store opened. The crate has no logger: the runtime reads
/// these counters and the first unread error (`Store::take_reclaim_error`) and logs them.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct MaintenanceFailures {
    /// Ticks whose expiry or decay returned an I/O error.
    pub errors: u64,
    /// Ticks that panicked. The maintenance thread contains each panic and keeps running.
    pub panics: u64,
}

#[derive(Default)]
struct Maintenance {
    failures: MaintenanceFailures,
    first_error: Option<io::Error>,
}

/// Hashes stream ids by one multiplication. The store assigns ids sequentially, so no client
/// chooses the keys in the table, and a lookup skips SipHash's cost.
#[derive(Default)]
struct IdHasher(u64);

impl Hasher for IdHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.write_u64(self.0.rotate_left(8) ^ u64::from(byte));
        }
    }
    fn write_u64(&mut self, id: u64) {
        self.0 = id.wrapping_mul(0x9e37_79b9_7f4a_7c15);
    }
}

#[derive(Default)]
pub(crate) struct Cache {
    streams: HashMap<u64, Arc<Stream>, BuildHasherDefault<IdHasher>>,
    order: BTreeSet<(Duration, u64)>,
    evictions: u64,
    expiries: u64,
    /// Streams that left the cache; their readers may still hold leases.
    orphans: Vec<Weak<Stream>>,
}

impl Cache {
    fn retire(&mut self, stream: &Arc<Stream>) {
        // Pruning only when full keeps this amortized O(1) and at most twice the live orphans.
        if self.orphans.len() == self.orphans.capacity() {
            self.orphans.retain(|orphan| orphan.strong_count() > 0);
        }
        self.orphans.push(Arc::downgrade(stream));
    }
}

#[repr(align(128))]
pub(crate) struct Inner {
    pub pool: Arc<Pool>,
    pub limits: Limits,
    cache: parking_lot::Mutex<Cache>,
    retention: Arc<Retention>,
    closed: AtomicBool,
    maintenance: parking_lot::Mutex<Maintenance>,
    /// Runs once between planning victims and invalidating them.
    #[cfg(test)]
    evict_hook: parking_lot::Mutex<Option<Box<dyn FnOnce() + Send>>>,
    /// Runs once in a tick, after expiry and before decay.
    #[cfg(test)]
    tick_hook: parking_lot::Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

pub(crate) struct Retention {
    clock: Arc<dyn Clock>,
    fence: RwLock<()>,
    active: AtomicBool,
    pub(crate) failures: Failures,
}

impl Retention {
    fn retain(&self) -> RetentionGuard<'_> {
        let lock = self.fence.write().unwrap();
        self.active.store(true, Ordering::Release);
        RetentionGuard {
            _lock: lock,
            active: &self.active,
        }
    }

    /// Lock stream state once no maintenance pass that has observed this stream is running.
    /// Reads and every writer transition that lowers a stream's reclaimable frames use this,
    /// so eviction's counted gain cannot shrink before it invalidates its victims.
    pub(crate) fn lock_stable<'a>(
        &'a self,
        stream: &'a Stream,
    ) -> (MutexGuard<'a, State>, Option<RwLockReadGuard<'a, ()>>) {
        let state = stream.state.lock();
        // Maintenance sets the flag before locking stream state. Once it has observed a
        // stream, that mutex's release/acquire edge makes later callers take the fence.
        if !self.active.load(Ordering::Acquire) {
            return (state, None);
        }
        drop(state);
        let fence = self.fence.read().unwrap();
        (stream.state.lock(), Some(fence))
    }

    pub(crate) fn reading<R>(&self, stream: &Stream, read: impl FnOnce(&mut State) -> (R, bool)) -> R {
        let (mut state, _fence) = self.lock_stable(stream);
        let (result, acquired) = read(&mut state);
        if acquired {
            stream.touch(self.clock.now());
        }
        result
    }

    pub(crate) fn now(&self) -> Duration {
        self.clock.now()
    }
}

struct RetentionGuard<'a> {
    _lock: RwLockWriteGuard<'a, ()>,
    active: &'a AtomicBool,
}

impl Drop for RetentionGuard<'_> {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
    }
}

impl Inner {
    /// Invalidate the least recently read streams whose `gain` (what invalidation returns now)
    /// together covers `wanted`. Streams that would return nothing stay cached; if every
    /// candidate together cannot cover the request, nothing is invalidated and this returns false.
    fn evict(&self, exclude: Option<u64>, wanted: usize, gain: fn(&Stream, &State) -> usize) -> bool {
        let _retention = self.retention.retain();
        let mut cache = self.cache.lock();
        let mut victims = Vec::new();
        let mut found = 0;
        let mut refreshed = HashSet::new();
        let mut cursor = None;
        while found < wanted {
            let next = match cursor {
                None => cache.order.first(),
                Some(key) => cache.order.range((Excluded(key), Unbounded)).next(),
            };
            let Some(&key) = next else {
                break;
            };
            cursor = Some(key);
            if Some(key.1) == exclude {
                continue;
            }
            let stream = cache.streams[&key.1].clone();
            let state = stream.state.lock();
            // Queue timestamps are lower bounds. Once maintenance has observed a stream, the
            // fence holds off new leases, so one requeue at the real value is exact except for
            // an acknowledgement racing this pass, which then counts as arriving after it.
            let last_read = stream.last_read();
            if last_read != key.0 && refreshed.insert(key.1) {
                let real = (last_read, key.1);
                drop(state);
                cache.order.remove(&key);
                cache.order.insert(real);
                continue;
            }
            let returned = gain(&stream, &state);
            if returned > 0 {
                found += returned;
                victims.push(key);
            }
        }
        if found < wanted {
            return false;
        }
        #[cfg(test)]
        if let Some(hook) = self.evict_hook.lock().take() {
            hook();
        }
        cache.evictions += victims.len() as u64;
        for key in victims {
            let stream = cache.streams.remove(&key.1).unwrap();
            cache.order.remove(&key);
            stream.invalidate_locked(&mut stream.state.lock());
            cache.retire(&stream);
        }
        true
    }

    fn tick(&self) -> io::Result<()> {
        let now = self.retention.clock.now();
        {
            let _retention = self.retention.retain();
            let mut cache = self.cache.lock();
            while let Some(&(read, id)) = cache.order.first() {
                if now.saturating_sub(read) <= self.limits.cache_ttl {
                    break;
                }
                let stream = cache.streams[&id].clone();
                let mut state = stream.state.lock();
                cache.order.remove(&(read, id));
                // An outstanding wait is a read even without publication or another poll.
                if state.readers > 0 {
                    stream.touch(now);
                }
                let last_read = stream.last_read();
                if last_read != read {
                    cache.order.insert((last_read, id));
                    continue;
                }
                cache.streams.remove(&id);
                cache.expiries += 1;
                stream.invalidate_locked(&mut state);
                cache.retire(&stream);
            }
        }
        #[cfg(test)]
        if let Some(hook) = self.tick_hook.lock().take() {
            hook();
        }
        self.pool.decay()
    }

    /// One maintenance round, with a panicking tick contained, counted and reported.
    ///
    /// A panic in the fenced expiry section poisons the retention fence, which §6.4 keeps
    /// poisoning: every later tick and eviction then panics, so maintenance cannot recover.
    /// Only a broken internal invariant panics there. A panic after that section, in decay,
    /// is recoverable: pool locks ignore poisoning, and decay moves frames to the cold list
    /// before any punch, so the next tick expires and decays normally.
    fn maintain(&self) {
        match std::panic::catch_unwind(AssertUnwindSafe(|| self.tick())) {
            Ok(Ok(())) => {}
            Ok(Err(error)) => self.record_failure(error, false),
            Err(_) => self.record_failure(io::Error::other("stream maintenance tick panicked"), true),
        }
    }

    fn record_failure(&self, error: io::Error, panicked: bool) {
        let mut maintenance = self.maintenance.lock();
        if panicked {
            maintenance.failures.panics += 1;
        } else {
            maintenance.failures.errors += 1;
        }
        maintenance.first_error.get_or_insert(error);
    }

    /// Allocate one of the `remaining` frames a pending reservation still needs, with its
    /// first `needed` bytes populated.
    pub(crate) fn allocate(&self, exclude: u64, remaining: usize, needed: usize) -> Result<u32, Error> {
        let mut evicted_for_tmpfs = false;
        loop {
            match self.pool.allocate(needed) {
                Ok(frame) => return Ok(frame),
                Err(error) if error.kind() == io::ErrorKind::OutOfMemory && error.raw_os_error().is_none() => {
                    if !self.evict(Some(exclude), remaining, Stream::reclaimable) {
                        return Err(Error::StorageExhausted);
                    }
                }
                // tmpfs refused growth (ENOSPC) or a cold prefault (EFAULT). Evicted frames are
                // already backed, so retry once; a second refusal keeps the OS cause (G7).
                Err(error)
                    if !evicted_for_tmpfs
                        && matches!(error.raw_os_error(), Some(libc::ENOSPC | libc::EFAULT))
                        && self.evict(Some(exclude), remaining, Stream::reclaimable) =>
                {
                    evicted_for_tmpfs = true;
                }
                Err(error) => return Err(Error::Io(error)),
            }
        }
    }
}

/// Runtime owner of retention and the one-second decay thread.
/// Dropping readers or writers does not remove cached responses.
pub struct Store {
    pub(crate) inner: Arc<Inner>,
    stop: Arc<(Mutex<bool>, Condvar)>,
    worker: Option<JoinHandle<()>>,
}

impl Store {
    pub fn open(config: Config) -> io::Result<Self> {
        Self::with_clock(config, Arc::new(MonotonicClock::default()))
    }

    pub fn with_clock(config: Config, clock: Arc<dyn Clock>) -> io::Result<Self> {
        let limits = config.resolve()?;
        let pool = Arc::new(Pool::open(
            &config.directory,
            limits.pool_frames,
            config.header_slots,
            config.workers,
            limits.startup_reserve_frames,
        )?);
        let inner = Arc::new(Inner {
            pool,
            limits,
            cache: parking_lot::Mutex::new(Cache::default()),
            retention: Arc::new(Retention {
                clock,
                fence: RwLock::new(()),
                active: AtomicBool::new(false),
                failures: Failures::default(),
            }),
            closed: AtomicBool::new(false),
            maintenance: parking_lot::Mutex::new(Maintenance::default()),
            #[cfg(test)]
            evict_hook: parking_lot::Mutex::new(None),
            #[cfg(test)]
            tick_hook: parking_lot::Mutex::new(None),
        });
        let stop = Arc::new((Mutex::new(false), Condvar::new()));
        let weak: Weak<Inner> = Arc::downgrade(&inner);
        let signal = stop.clone();
        let worker = std::thread::Builder::new()
            .name("ck-stream-decay".into())
            .spawn(move || {
                let (lock, wake) = &*signal;
                loop {
                    let stopped = lock.lock().unwrap();
                    let (stopped, _) = wake
                        .wait_timeout_while(stopped, Duration::from_secs(1), |s| !*s)
                        .unwrap();
                    if *stopped {
                        break;
                    }
                    drop(stopped);
                    let Some(inner) = weak.upgrade() else {
                        break;
                    };
                    inner.maintain();
                }
            })?;
        Ok(Self {
            inner,
            stop,
            worker: Some(worker),
        })
    }

    pub fn limits(&self) -> Limits {
        self.inner.limits
    }
    pub fn capacity_frames(&self) -> u32 {
        self.inner.pool.capacity()
    }
    pub fn used_frames(&self) -> u32 {
        self.inner.pool.used()
    }
    pub fn backed_frames(&self) -> u32 {
        self.inner.pool.backed_frames()
    }

    /// Admit one exclusive producer. The returned id is an internal generation, not an auth token.
    pub fn create(&self) -> Result<Writer, Error> {
        // Header slots bound the mapping, not the cache: when none is free, evict the least
        // recently read stream exactly as under frame pressure. Invalidation frees its slot.
        let slot = loop {
            if self.inner.closed.load(Ordering::Acquire) {
                return Err(Error::Closed);
            }
            if let Some(slot) = self.inner.pool.claim_slot() {
                break slot;
            }
            if !self.inner.evict(None, 1, State::slot_count) {
                self.inner.retention.failures.record(None);
                return Err(Error::StorageExhausted);
            }
        };
        let mut cache = self.inner.cache.lock();
        let id = if self.inner.closed.load(Ordering::Acquire) {
            Err(Error::Closed)
        } else {
            checked_add(&NEXT_ID, 1).ok_or(Error::StorageExhausted)
        }
        .inspect_err(|_| self.inner.pool.release_slot(slot))?;
        let now = self.inner.retention.clock.now();
        let stream = Arc::new(Stream::new(
            id,
            slot,
            self.inner.pool.clone(),
            self.inner.retention.clone(),
            self.inner.limits,
            now,
        ));
        cache.order.insert((stream.last_read(), id));
        cache.streams.insert(id, stream.clone());
        Ok(Writer::new(self.inner.clone(), stream))
    }

    /// Attach at the number of complete records already consumed. Authorization belongs to the caller.
    pub fn reader(&self, id: u64, after: u64) -> Result<Reader, Error> {
        let stream = self.inner.cache.lock().streams.get(&id).cloned().ok_or(Error::Gone)?;
        Reader::new(stream, after)
    }

    /// Expire with the injected clock and perform one decay pass; errors remain visible.
    pub fn tick(&self) -> io::Result<()> {
        self.inner.tick()
    }

    /// The first maintenance failure since the last call; later failures only count.
    pub fn take_reclaim_error(&self) -> Option<io::Error> {
        self.inner.maintenance.lock().first_error.take()
    }

    pub fn maintenance_failures(&self) -> MaintenanceFailures {
        self.inner.maintenance.lock().failures
    }

    /// Stop admission, publish cancellation, join maintenance, then release cache retention.
    /// Existing leases retain their mapping until their own drop.
    pub fn shutdown(&mut self) -> io::Result<()> {
        self.inner.closed.store(true, Ordering::Release);
        {
            let _retention = self.inner.retention.retain();
            let mut cache = self.inner.cache.lock();
            cache.order.clear();
            for stream in std::mem::take(&mut cache.streams).into_values() {
                stream.finish(Terminal::Shutdown);
                cache.retire(&stream);
            }
        }
        *self.stop.0.lock().unwrap() = true;
        self.stop.1.notify_all();
        if let Some(worker) = self.worker.take() {
            worker
                .join()
                .map_err(|_| io::Error::other("stream maintenance thread panicked"))?;
        }
        self.take_reclaim_error().map_or(Ok(()), Err)
    }
}

impl Drop for Store {
    fn drop(&mut self) {
        // A dropped store has nowhere to report; callers that need the error call shutdown first.
        let _ = self.shutdown();
    }
}

#[cfg(test)]
mod tests;
