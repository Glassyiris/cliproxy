use std::{
    collections::{BTreeSet, HashMap},
    io,
    sync::{
        Arc, Condvar, Mutex, RwLock, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

use crate::{Config, Error, Limits, Reader, Terminal, Writer, pool::Pool, publication::Stream};

/// Monotonic elapsed time. Implementations must never move backwards.
pub trait Clock: Send + Sync + 'static {
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

#[derive(Default)]
pub(crate) struct Cache {
    streams: HashMap<u64, Arc<Stream>>,
    order: BTreeSet<(Duration, u64)>,
}

#[repr(align(128))]
pub(crate) struct Inner {
    pub pool: Arc<Pool>,
    pub limits: Limits,
    pub clock: Arc<dyn Clock>,
    cache: RwLock<Cache>,
    closed: AtomicBool,
    reclaim_error: Mutex<Option<io::Error>>,
}

impl Inner {
    pub(crate) fn touch(&self, stream: &Stream) {
        let _retention = self.cache.read().unwrap();
        let mut state = stream.state.lock().unwrap();
        state.last_read = self.clock.now();
    }

    pub(crate) fn evict_one(&self, exclude: u64) -> bool {
        let mut cache = self.cache.write().unwrap();
        while let Some(key) = cache.order.iter().find(|(_, id)| *id != exclude).copied() {
            let stream = cache.streams[&key.1].clone();
            let mut state = stream.state.lock().unwrap();
            cache.order.remove(&key);
            // Queue timestamps are lower bounds. Refresh stale heads before choosing a victim.
            if state.last_read != key.0 {
                cache.order.insert((state.last_read, key.1));
                continue;
            }
            cache.streams.remove(&key.1);
            if stream.invalidate_locked(&mut state) > 0 {
                return true;
            }
        }
        false
    }
    pub(crate) fn reading<R>(
        &self,
        stream: &Stream,
        read: impl FnOnce(&mut crate::publication::State) -> (R, bool),
    ) -> R {
        let _retention = self.cache.read().unwrap();
        let mut state = stream.state.lock().unwrap();
        let (result, acquired) = read(&mut state);
        if acquired {
            state.last_read = self.clock.now();
        }
        result
    }

    fn tick(&self) -> io::Result<()> {
        let now = self.clock.now();
        {
            let mut cache = self.cache.write().unwrap();
            while let Some(&(read, id)) = cache.order.first() {
                if now.saturating_sub(read) <= self.limits.cache_ttl {
                    break;
                }
                let stream = cache.streams[&id].clone();
                let mut state = stream.state.lock().unwrap();
                cache.order.remove(&(read, id));
                if state.last_read != read {
                    cache.order.insert((state.last_read, id));
                    continue;
                }
                cache.streams.remove(&id);
                stream.invalidate_locked(&mut state);
            }
        }
        self.pool.decay()
    }

    pub(crate) fn allocate(&self, exclude: u64) -> Result<u32, Error> {
        loop {
            match self.pool.allocate() {
                Ok(frame) => return Ok(frame),
                Err(error) if error.kind() == io::ErrorKind::OutOfMemory && error.raw_os_error().is_none() => {
                    if !self.evict_one(exclude) {
                        return Err(Error::StorageExhausted);
                    }
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
        )?);
        let inner = Arc::new(Inner {
            pool,
            limits,
            clock,
            cache: RwLock::new(Cache::default()),
            closed: AtomicBool::new(false),
            reclaim_error: Mutex::new(None),
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
                    if let Err(error) = inner.tick() {
                        *inner.reclaim_error.lock().unwrap() = Some(error);
                    }
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
        let mut cache = self.inner.cache.write().unwrap();
        if self.inner.closed.load(Ordering::Acquire) {
            return Err(Error::Closed);
        }
        let id = checked_add(&NEXT_ID, 1).ok_or(Error::StorageExhausted)?;
        let slot = self.inner.pool.claim_slot().ok_or(Error::StorageExhausted)?;
        let now = self.inner.clock.now();
        let stream = Arc::new(Stream::new(id, slot, self.inner.pool.clone(), self.inner.limits, now));
        cache.order.insert((now, id));
        cache.streams.insert(id, stream.clone());
        Ok(Writer::new(self.inner.clone(), stream))
    }

    /// Attach at the number of complete records already consumed. Authorization belongs to the caller.
    pub fn reader(&self, id: u64, after: u64) -> Result<Reader, Error> {
        let stream = self
            .inner
            .cache
            .read()
            .unwrap()
            .streams
            .get(&id)
            .cloned()
            .ok_or(Error::Gone)?;
        Reader::new(self.inner.clone(), stream, after)
    }

    /// Expire with the injected clock and perform one decay pass; errors remain visible.
    pub fn tick(&self) -> io::Result<()> {
        self.inner.tick()
    }

    pub fn take_reclaim_error(&self) -> Option<io::Error> {
        self.inner.reclaim_error.lock().unwrap().take()
    }

    /// Stop admission, publish cancellation, join maintenance, then release cache retention.
    /// Existing leases retain their mapping until their own drop.
    pub fn shutdown(&mut self) -> io::Result<()> {
        self.inner.closed.store(true, Ordering::Release);
        {
            let mut cache = self.inner.cache.write().unwrap();
            for stream in cache.streams.values() {
                stream.finish(Terminal::Shutdown);
            }
            cache.order.clear();
            cache.streams.clear();
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
        if let Err(error) = self.shutdown() {
            eprintln!("stream maintenance failed: {error}");
        }
    }
}
