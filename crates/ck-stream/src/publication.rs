use std::{
    collections::VecDeque,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

use parking_lot::Mutex;

use crate::{Error, FRAME_BYTES, Limits, Position, Record, Terminal, cache::Retention, pool::Pool};

mod reader;
mod scratch;
mod wakeup;
mod writer;
use reader::Pinned;
pub use reader::{Lease, Read, Reader};
pub use scratch::{MetadataPermit, ScratchLease, ScratchReservation};
use wakeup::Wakeup;
pub use writer::{Reservation, Writer};

pub(crate) const READER_BYTES: usize = std::mem::size_of::<Reader>();

/// A stream's reference to a pool frame; readers' leases hold their own references.
pub(crate) struct Frame {
    pool: Option<u32>,
}

// A run represents exact record boundaries, not a byte range including padding.
#[derive(Clone, Copy)]
pub(crate) struct Index {
    start: u64,
    sequence: u64,
    next_sequence: u64,
    len: u64,
    stride: u64,
    kind: u32,
    correlation: u32,
}

impl Index {
    fn extends(&self, next: &Self) -> bool {
        self.next_sequence == next.sequence
            && self.len == next.len
            && self.stride == next.stride
            && self.kind == next.kind
            && self.correlation == next.correlation
            && (self.next_sequence - self.sequence)
                .checked_mul(self.stride)
                .and_then(|offset| self.start.checked_add(offset))
                == Some(next.start)
    }

    fn record(self, generation: u64, sequence: u64) -> Option<Record> {
        if !(self.sequence..self.next_sequence).contains(&sequence) {
            return None;
        }
        let start = (sequence - self.sequence)
            .checked_mul(self.stride)?
            .checked_add(self.start)?;
        let end = start.checked_add(self.len)?;
        Some(Record {
            sequence,
            start: Position::at(generation, start),
            end: Position::at(generation, end),
            kind: self.kind,
            correlation: self.correlation,
        })
    }
}

fn reserve_metadata<T>(entries: &mut VecDeque<T>, needed: usize, budget: usize) -> Result<(), Error> {
    if needed <= entries.capacity() {
        return Ok(());
    }
    let maximum = budget / std::mem::size_of::<T>();
    if needed > maximum {
        return Err(Error::StorageExhausted);
    }
    let capacity = needed.max(entries.capacity().saturating_mul(2)).min(maximum);
    entries
        .try_reserve_exact(capacity - entries.len())
        .map_err(|_| Error::StorageExhausted)
}

pub(crate) struct State {
    frames: VecDeque<Frame>,
    base_frame: u64,
    records: VecDeque<Index>,
    base_sequence: u64,
    next_sequence: u64,
    end: u64,
    terminal: Option<Terminal>,
    pub(crate) readers: usize,
    scratch_frames: usize,
    external_metadata: usize,
    // Taken at invalidation, so an evicted stream frees its header before its last handle drops.
    slot: Option<u32>,
}

impl State {
    /// Header slots that invalidation would return now.
    pub(crate) fn slot_count(_: &Stream, state: &Self) -> usize {
        usize::from(state.slot.is_some())
    }
}

#[repr(align(128))]
pub(crate) struct Stream {
    pub id: u64,
    pool: Arc<Pool>,
    retention: Arc<Retention>,
    limits: Limits,
    pub state: Mutex<State>,
    invalidated: AtomicBool,
    /// Clock nanoseconds of the last read. Acknowledgements store it without the state lock.
    last_read: AtomicU64,
    /// Frames the stream gave up while leases still pin them; they still count as live.
    detached: AtomicU64,
    notify: Wakeup,
    stopped: Wakeup,
}

impl Stream {
    pub(crate) fn new(
        id: u64,
        slot: u32,
        pool: Arc<Pool>,
        retention: Arc<Retention>,
        limits: Limits,
        now: Duration,
    ) -> Self {
        Self {
            id,
            pool,
            retention,
            limits,
            notify: Wakeup::new(),
            stopped: Wakeup::new(),
            invalidated: AtomicBool::new(false),
            last_read: AtomicU64::new(nanos(now)),
            detached: AtomicU64::new(0),
            state: Mutex::new(State {
                frames: VecDeque::new(),
                base_frame: 0,
                records: VecDeque::new(),
                base_sequence: 0,
                next_sequence: 0,
                end: 0,
                terminal: None,
                readers: 0,
                scratch_frames: 0,
                external_metadata: 0,
                slot: Some(slot),
            }),
        }
    }

    pub(crate) fn last_read(&self) -> Duration {
        Duration::from_nanos(self.last_read.load(Ordering::Relaxed))
    }

    pub(crate) fn touch(&self, now: Duration) {
        self.last_read.store(nanos(now), Ordering::Relaxed);
    }

    /// Frames that invalidation would return to the pool now: owned and unleased.
    pub(crate) fn reclaimable(&self, state: &State) -> usize {
        state
            .frames
            .iter()
            .filter(|frame| frame.pool.is_some_and(|index| self.pool.references(index) == 1))
            .count()
    }

    /// Frames charged to the stream quota: owned, detached but still leased, and scratch.
    pub(super) fn live_frames(&self, state: &State) -> usize {
        state.frames.iter().filter(|frame| frame.pool.is_some()).count()
            + self.detached.load(Ordering::Acquire) as usize
            + state.scratch_frames
    }

    /// Reference every frame of a published record for a new lease, or name the terminal
    /// that ends the reader instead.
    fn pin(&self, state: &State, record: Record) -> Result<Pinned, Terminal> {
        let first = (record.start.frame - state.base_frame) as usize;
        let last = (last_frame(record) - state.base_frame) as usize;
        let frames = (first..=last).map(|index| state.frames[index].pool);
        for frame in frames.clone() {
            match frame {
                None => return Err(Terminal::Gone),
                Some(index) if self.pool.saturated(index) => return Err(Terminal::StorageExhausted),
                Some(_) => {}
            }
        }
        // The stream's own references keep every frame allocated while these are added.
        let mut frames = frames.flatten();
        frames.clone().for_each(|index| self.pool.retain(index));
        Ok(if first == last {
            Pinned::One(frames.next().unwrap())
        } else {
            Pinned::Many(frames.collect())
        })
    }

    /// Give up the stream's reference to a frame; leases keep it pinned until they end.
    fn detach(&self, frame: &mut Frame) {
        if let Some(index) = frame.pool.take() {
            // Count before releasing, so a racing last lease never decrements below zero.
            self.detached.fetch_add(1, Ordering::AcqRel);
            if self.pool.release(index) {
                self.detached.fetch_sub(1, Ordering::AcqRel);
            }
        }
    }

    fn metadata(state: &State) -> usize {
        state.frames.capacity() * std::mem::size_of::<Frame>()
            + state.records.capacity() * std::mem::size_of::<Index>()
            + state.readers * READER_BYTES
            + state.external_metadata
    }

    fn write_reserved(&self, state: &State, start: Position, mut bytes: &[u8]) -> Result<(), Error> {
        let mut frame_index = (start.frame - state.base_frame) as usize;
        let mut offset = start.offset as usize;
        while !bytes.is_empty() {
            let len = bytes.len().min(FRAME_BYTES - offset);
            let frame = state.frames[frame_index].pool.ok_or(Error::Gone)?;
            // SAFETY: the sole Writer reserved this frame; the locked state prevents invalidation,
            // and this span is strictly after the immutable published end and within the frame.
            unsafe {
                self.pool.write(frame, offset, &bytes[..len]);
            }
            frame_index += 1;
            offset = 0;
            bytes = &bytes[len..];
        }
        Ok(())
    }

    fn publish(&self, state: &mut State, index: Index) {
        if let Some(last) = state.records.back_mut().filter(|last| last.extends(&index)) {
            last.next_sequence = index.next_sequence;
        } else {
            state.records.push_back(index);
        }
        state.next_sequence = index.next_sequence;
        state.end = index.start + index.len;
        // Callers publish only after checking invalidation under this lock, so the slot is held.
        if let Some(slot) = state.slot {
            self.pool.header(slot).committed.store(state.end, Ordering::Release);
        }
    }

    pub(crate) fn finish(&self, terminal: Terminal) {
        if terminal == Terminal::Gone {
            self.invalidate();
            return;
        }
        let mut state = self.state.lock();
        // Waiters registered after the first terminal see it when they recheck.
        if state.terminal.is_some() {
            return;
        }
        state.terminal = Some(terminal);
        drop(state);
        self.notify.wake();
        self.stopped.wake();
    }

    pub(crate) fn invalidate(&self) {
        let (mut state, _fence) = self.retention.lock_stable(self);
        self.invalidate_locked(&mut state);
    }

    pub(crate) fn invalidate_locked(&self, state: &mut State) {
        self.invalidated.store(true, Ordering::Release);
        state.terminal = Some(Terminal::Gone);
        for frame in &mut state.frames {
            self.detach(frame);
        }
        state.records.clear();
        if let Some(slot) = state.slot.take() {
            self.pool.release_slot(slot);
        }
        self.notify.wake();
        self.stopped.wake();
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        let state = self.state.get_mut();
        for frame in &mut state.frames {
            if let Some(index) = frame.pool.take() {
                self.pool.release(index);
            }
        }
        if let Some(slot) = state.slot.take() {
            self.pool.release_slot(slot);
        }
    }
}

fn last_frame(record: Record) -> u64 {
    if record.end.offset == 0 {
        record.end.frame - 1
    } else {
        record.end.frame
    }
}

fn nanos(time: Duration) -> u64 {
    u64::try_from(time.as_nanos()).unwrap_or(u64::MAX)
}
