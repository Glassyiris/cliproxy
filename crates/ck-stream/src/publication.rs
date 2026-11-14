use std::{
    collections::VecDeque,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    task::Poll,
    time::Duration,
};

use parking_lot::{Mutex, MutexGuard};
use tokio::sync::Notify;

use crate::{
    Error, FRAME_BYTES, Limits, Position, Record, Terminal,
    cache::{Inner, Retention},
    pool::Pool,
};

mod scratch;
pub use scratch::{MetadataPermit, ScratchLease, ScratchReservation};

pub(crate) const READER_BYTES: usize = std::mem::size_of::<Reader>();

pub(crate) struct Frame {
    pool: Option<u32>,
    leases: u32,
    retained: bool,
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
    pub last_read: Duration,
}

#[repr(align(128))]
pub(crate) struct Stream {
    pub id: u64,
    slot: u32,
    pool: Arc<Pool>,
    retention: Arc<Retention>,
    limits: Limits,
    pub state: Mutex<State>,
    invalidated: AtomicBool,
    notify: Notify,
    stopped: Notify,
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
            slot,
            pool,
            retention,
            limits,
            notify: Notify::new(),
            stopped: Notify::new(),
            invalidated: AtomicBool::new(false),
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
                last_read: now,
            }),
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
        self.pool
            .header(self.slot)
            .committed
            .store(state.end, Ordering::Release);
    }

    pub(crate) fn finish(&self, terminal: Terminal) {
        if terminal == Terminal::Gone {
            self.invalidate();
            return;
        }
        let mut state = self.state.lock();
        if state.terminal.is_none() {
            state.terminal = Some(terminal);
        }
        drop(state);
        self.notify.notify_waiters();
        self.stopped.notify_waiters();
    }

    /// Frames that invalidation would return to the pool now: owned and unleased.
    pub(crate) fn reclaimable(&self, state: &State) -> usize {
        state
            .frames
            .iter()
            .filter(|frame| frame.pool.is_some() && frame.leases == 0)
            .count()
    }

    pub(crate) fn invalidate(&self) {
        self.invalidate_locked(&mut self.state.lock());
    }

    pub(crate) fn invalidate_locked(&self, state: &mut State) -> u32 {
        let mut released = 0;
        self.invalidated.store(true, Ordering::Release);
        state.terminal = Some(Terminal::Gone);
        for frame in &mut state.frames {
            frame.retained = false;
            if frame.leases == 0
                && let Some(index) = frame.pool.take()
            {
                self.pool.release(index);
                released += 1;
            }
        }
        state.records.clear();
        self.notify.notify_waiters();
        self.stopped.notify_waiters();
        released
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
        self.pool.release_slot(self.slot);
    }
}

/// Exclusive stream producer. A disconnect must drop a reader, not this producer.
pub struct Writer {
    inner: Arc<Inner>,
    stream: Arc<Stream>,
}

impl Writer {
    pub(crate) fn new(inner: Arc<Inner>, stream: Arc<Stream>) -> Self {
        Self { inner, stream }
    }
    pub fn id(&self) -> u64 {
        self.stream.id
    }
    pub fn committed(&self) -> Position {
        Position::at(
            self.id(),
            self.stream
                .pool
                .header(self.stream.slot)
                .committed
                .load(Ordering::Acquire),
        )
    }

    /// Wait for the producer to stop, including expiry, eviction, cancellation and shutdown.
    /// The owned, cancellation-safe future does not borrow the writer and also resolves
    /// immediately after a terminal has already been published, including normal completion.
    pub fn cancelled(&self) -> impl Future<Output = Terminal> + Send + 'static {
        let stream = self.stream.clone();
        async move {
            loop {
                let notified = stream.stopped.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if let Some(terminal) = stream.state.lock().terminal {
                    return terminal;
                }
                notified.await;
            }
        }
    }

    /// Reserve the whole record before writing. `aligned` excludes tail padding from the record.
    /// The caller's codec must finish its framing before committing this reservation.
    /// Invalid length/alignment is rejected without terminating the stream; storage failures are terminal.
    pub fn begin_record(
        &mut self,
        len: usize,
        aligned: bool,
        kind: u32,
        correlation: u32,
    ) -> Result<Reservation<'_>, Error> {
        let (record, index, old_count, state) = self.reserve(len, aligned, kind, correlation)?;
        drop(state);
        Ok(Reservation {
            writer: self,
            record,
            index,
            old_count,
            written: 0,
            committed: false,
        })
    }

    fn reserve(
        &self,
        len: usize,
        aligned: bool,
        kind: u32,
        correlation: u32,
    ) -> Result<(Record, Index, usize, MutexGuard<'_, State>), Error> {
        let result = self.reserve_locked(len, aligned, kind, correlation);
        if matches!(result, Err(Error::StorageExhausted | Error::Io(_))) {
            self.stream.finish(Terminal::StorageExhausted);
        }
        result
    }

    fn reserve_locked(
        &self,
        len: usize,
        aligned: bool,
        kind: u32,
        correlation: u32,
    ) -> Result<(Record, Index, usize, MutexGuard<'_, State>), Error> {
        if len == 0 || len > self.inner.limits.max_event_bytes || (aligned && len > FRAME_BYTES) {
            return Err(Error::InvalidRecord);
        }
        let mut state = self.stream.state.lock();
        if self.stream.invalidated.load(Ordering::Acquire) {
            return Err(Error::Gone);
        }
        if state.terminal.is_some() {
            return Err(Error::Closed);
        }
        let start = if aligned {
            state
                .end
                .div_ceil(FRAME_BYTES as u64)
                .checked_mul(FRAME_BYTES as u64)
                .ok_or(Error::StorageExhausted)?
        } else {
            state.end
        };
        let end = start.checked_add(len as u64).ok_or(Error::StorageExhausted)?;
        let needed = usize::try_from(end.div_ceil(FRAME_BYTES as u64) - state.base_frame)
            .map_err(|_| Error::StorageExhausted)?;
        let old_count = state.frames.len();
        let extra = needed.saturating_sub(old_count);
        if extra > 0
            && state.frames.iter().filter(|frame| frame.pool.is_some()).count() + state.scratch_frames + extra
                > self.inner.limits.max_frames as usize
        {
            return Err(Error::StorageExhausted);
        }
        let record = Record {
            sequence: state.next_sequence,
            start: Position::at(self.id(), start),
            end: Position::at(self.id(), end),
            kind,
            correlation,
        };
        let index = Index {
            start,
            sequence: record.sequence,
            next_sequence: record.sequence.checked_add(1).ok_or(Error::StorageExhausted)?,
            len: len as u64,
            stride: if aligned { FRAME_BYTES as u64 } else { len as u64 },
            kind,
            correlation,
        };
        let extends = state.records.back().is_some_and(|last| last.extends(&index));
        let records = state.records.len() + usize::from(!extends);
        let reader_bytes = state.readers * READER_BYTES + state.external_metadata;
        let frame_budget = self
            .inner
            .limits
            .max_metadata_bytes
            .saturating_sub(state.records.capacity().max(records) * std::mem::size_of::<Index>() + reader_bytes);
        reserve_metadata(&mut state.frames, needed, frame_budget)?;
        let record_budget = self
            .inner
            .limits
            .max_metadata_bytes
            .saturating_sub(state.frames.capacity() * std::mem::size_of::<Frame>() + reader_bytes);
        reserve_metadata(&mut state.records, records, record_budget)?;
        if Stream::metadata(&state) > self.inner.limits.max_metadata_bytes {
            return Err(Error::StorageExhausted);
        }
        for taken in 0..extra {
            // Allocation may evict another stream. Never enter cache ownership with metadata locked.
            drop(state);
            let frame = match self.inner.allocate(self.id(), extra - taken) {
                Ok(frame) => frame,
                Err(error) => {
                    self.rollback(old_count);
                    return Err(error);
                }
            };
            state = self.stream.state.lock();
            if self.stream.invalidated.load(Ordering::Acquire) || state.terminal.is_some() {
                self.inner.pool.release(frame);
                drop(state);
                self.rollback(old_count);
                return Err(Error::Gone);
            }
            state.frames.push_back(Frame {
                pool: Some(frame),
                leases: 0,
                retained: true,
            });
        }
        Ok((record, index, old_count, state))
    }

    fn rollback(&self, old_count: usize) {
        let mut state = self.stream.state.lock();
        while state.frames.len() > old_count {
            if let Some(frame) = state.frames.pop_back().unwrap().pool {
                self.inner.pool.release(frame);
            }
        }
    }

    pub fn append(&mut self, bytes: &[u8]) -> Result<Record, Error> {
        let (record, index, old_count, mut state) = self.reserve(bytes.len(), false, 0, 0)?;
        if let Err(error) = self.stream.write_reserved(&state, record.start, bytes) {
            drop(state);
            self.rollback(old_count);
            return Err(error);
        }
        self.stream.publish(&mut state, index);
        drop(state);
        self.stream.notify.notify_waiters();
        Ok(record)
    }

    pub fn finish(&mut self, terminal: Terminal) {
        self.stream.finish(terminal);
    }

    /// Release a non-resumable canonical prefix. Response records must never use this API.
    /// Independent scratch leases release on drop. Frame and record numbers are never recycled.
    pub fn release_before(&mut self, position: Position) -> Result<(), Error> {
        let end = position.byte(self.id())?;
        let mut state = self.stream.state.lock();
        if end > state.end {
            return Err(Error::InvalidPosition);
        }
        while let Some(run) = state.records.front_mut() {
            let first_end = run.start + run.len;
            if end < first_end {
                break;
            }
            let removed = ((end - first_end) / run.stride + 1).min(run.next_sequence - run.sequence);
            if removed == run.next_sequence - run.sequence {
                state.base_sequence = run.next_sequence;
                state.records.pop_front();
            } else {
                // Retained records were checked at append; this advances within that run.
                run.start += removed * run.stride;
                run.sequence += removed;
                state.base_sequence = run.sequence;
                break;
            }
        }
        let boundary = state.records.front().map_or(position.frame, |record| {
            position.frame.min(record.start / FRAME_BYTES as u64)
        });
        let count = boundary.saturating_sub(state.base_frame) as usize;
        for frame in state.frames.iter_mut().take(count) {
            frame.retained = false;
            if frame.leases == 0
                && let Some(index) = frame.pool.take()
            {
                self.inner.pool.release(index);
            }
        }
        while state.frames.front().is_some_and(|frame| frame.pool.is_none()) {
            state.frames.pop_front();
            state.base_frame += 1;
        }
        Ok(())
    }
}

impl Drop for Writer {
    fn drop(&mut self) {
        self.stream.finish(Terminal::Cancelled);
    }
}

/// An unpublished reservation; drop rolls back its newly allocated frames.
pub struct Reservation<'a> {
    writer: &'a mut Writer,
    record: Record,
    index: Index,
    old_count: usize,
    written: usize,
    committed: bool,
}

impl Reservation<'_> {
    pub fn write(&mut self, bytes: &[u8]) -> Result<(), Error> {
        if bytes.len() > self.record.len() as usize - self.written {
            return Err(Error::InvalidPosition);
        }
        let stream = &self.writer.stream;
        let state = stream.state.lock();
        if stream.invalidated.load(Ordering::Acquire) {
            return Err(Error::Gone);
        }
        if state.terminal.is_some() {
            return Err(Error::Closed);
        }
        stream.write_reserved(
            &state,
            Position::at(stream.id, self.index.start + self.written as u64),
            bytes,
        )?;
        self.written += bytes.len();
        Ok(())
    }

    pub fn commit(mut self) -> Result<Record, Error> {
        if self.written != self.record.len() as usize {
            return Err(Error::IncompleteRecord);
        }
        let stream = &self.writer.stream;
        let mut state = stream.state.lock();
        if stream.invalidated.load(Ordering::Acquire) {
            return Err(Error::Gone);
        }
        if state.terminal.is_some() {
            return Err(Error::Closed);
        }
        stream.publish(&mut state, self.index);
        self.committed = true;
        drop(state);
        stream.notify.notify_waiters();
        Ok(self.record)
    }
}

impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        if !self.committed {
            self.writer.rollback(self.old_count);
        }
    }
}

pub enum Read {
    Record(Lease),
    Terminal(Terminal),
}

/// Independent complete-record cursor. A terminal is delivered once, followed by EOF.
pub struct Reader {
    stream: Arc<Stream>,
    next: u64,
    available: u64,
    committed: u64,
    terminal_seen: bool,
}

impl Reader {
    pub(crate) fn new(stream: Arc<Stream>, after: u64) -> Result<Self, Error> {
        let result = stream.retention.reading(&stream, |state| {
            if stream.invalidated.load(Ordering::Acquire) || after < state.base_sequence {
                return (Err(Error::Gone), false);
            }
            if after > state.next_sequence {
                return (Err(Error::InvalidPosition), false);
            }
            if READER_BYTES > stream.limits.max_metadata_bytes.saturating_sub(Stream::metadata(state)) {
                return (Err(Error::StorageExhausted), false);
            }
            state.readers += 1;
            (Ok(()), true)
        });
        if matches!(result, Err(Error::StorageExhausted)) {
            stream.finish(Terminal::StorageExhausted);
        }
        result?;
        Ok(Self {
            stream,
            next: after,
            available: 0,
            committed: 0,
            terminal_seen: false,
        })
    }

    pub fn try_next(&mut self) -> Poll<Option<Read>> {
        if self.terminal_seen {
            return Poll::Ready(None);
        }
        let stream = &self.stream;
        stream.retention.reading(stream, |state| {
            if stream.invalidated.load(Ordering::Acquire) || self.next < state.base_sequence {
                self.terminal_seen = true;
                return (Poll::Ready(Some(Read::Terminal(Terminal::Gone))), false);
            }
            // Cache only a prefix acquired from the mapped publication header under this lock.
            if self.next >= self.available {
                self.committed = stream.pool.header(stream.slot).committed.load(Ordering::Acquire);
                self.available = state.next_sequence;
            }
            let index = state.records.partition_point(|run| run.next_sequence <= self.next);
            if let Some(record) = state
                .records
                .get(index)
                .and_then(|run| run.record(stream.id, self.next))
                && record.end.byte(stream.id).is_ok_and(|end| end <= self.committed)
            {
                for number in record.start.frame..=last_frame(record) {
                    let index = (number - state.base_frame) as usize;
                    if state.frames[index].pool.is_none() {
                        self.terminal_seen = true;
                        return (Poll::Ready(Some(Read::Terminal(Terminal::Gone))), false);
                    }
                    if state.frames[index].leases == u32::MAX {
                        self.terminal_seen = true;
                        return (Poll::Ready(Some(Read::Terminal(Terminal::StorageExhausted))), false);
                    }
                }
                for number in record.start.frame..=last_frame(record) {
                    let index = (number - state.base_frame) as usize;
                    state.frames[index].leases += 1;
                }
                self.next += 1;
                return (
                    Poll::Ready(Some(Read::Record(Lease {
                        stream: stream.clone(),
                        record,
                        first_frame: state.frames[(record.start.frame - state.base_frame) as usize]
                            .pool
                            .unwrap(),
                        acknowledged: false,
                    }))),
                    true,
                );
            }
            if let Some(terminal) = state.terminal {
                self.terminal_seen = true;
                return (Poll::Ready(Some(Read::Terminal(terminal))), false);
            }
            (Poll::Pending, true)
        })
    }

    pub async fn next(&mut self) -> Option<Read> {
        if self.terminal_seen {
            return None;
        }
        if self.next < self.available
            && let Poll::Ready(value) = self.try_next()
        {
            return value;
        }
        loop {
            let stream = self.stream.clone();
            let notified = stream.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Poll::Ready(value) = self.try_next() {
                return value;
            }
            notified.await;
            if let Poll::Ready(value) = self.try_next() {
                return value;
            }
        }
    }
}

impl Drop for Reader {
    fn drop(&mut self) {
        self.stream.retention.reading(&self.stream, |state| {
            state.readers -= 1;
            ((), true)
        });
    }
}

fn last_frame(record: Record) -> u64 {
    if record.end.offset == 0 {
        record.end.frame - 1
    } else {
        record.end.frame
    }
}

/// Pins immutable published frames, including after invalidation. New access then returns Gone.
pub struct Lease {
    stream: Arc<Stream>,
    record: Record,
    first_frame: u32,
    acknowledged: bool,
}

impl Lease {
    pub fn record(&self) -> Record {
        self.record
    }

    /// Borrow one frame span at a checked position. The borrow cannot outlive this lease.
    pub fn chunk(&self, position: Position) -> Result<&[u8], Error> {
        let byte = position.byte(self.stream.id)?;
        let begin = self.record.start.byte(self.stream.id)?;
        let end = self.record.end.byte(self.stream.id)?;
        if byte < begin || byte >= end {
            return Err(Error::InvalidPosition);
        }
        if self.stream.invalidated.load(Ordering::Acquire) {
            return Err(Error::Gone);
        }
        let frame = if position.frame == self.record.start.frame {
            self.first_frame
        } else {
            let state = self.stream.state.lock();
            state.frames[(position.frame - state.base_frame) as usize]
                .pool
                .ok_or(Error::Gone)?
        };
        let len = (end - byte).min((FRAME_BYTES - position.offset as usize) as u64) as usize;
        // SAFETY: this lease pins all record frames until Drop. Publication made this span
        // immutable before lease registration; the pool Arc outlives the returned borrow.
        Ok(unsafe { self.stream.pool.slice(frame, position.offset as usize, len) })
    }

    pub fn visit(&self, mut visitor: impl FnMut(&[u8])) -> Result<(), Error> {
        let mut byte = self.record.start.byte(self.stream.id)?;
        let end = self.record.end.byte(self.stream.id)?;
        while byte < end {
            let chunk = self.chunk(Position::at(self.stream.id, byte))?;
            visitor(chunk);
            byte += chunk.len() as u64;
        }
        Ok(())
    }

    pub fn acknowledge(mut self) {
        self.acknowledged = true;
    }

    fn release(&self, state: &mut State) {
        for number in self.record.start.frame..=last_frame(self.record) {
            let index = (number - state.base_frame) as usize;
            let frame = &mut state.frames[index];
            frame.leases -= 1;
            if frame.leases == 0
                && !frame.retained
                && let Some(index) = frame.pool.take()
            {
                self.stream.pool.release(index);
            }
        }
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        if self.acknowledged {
            self.stream.retention.reading(&self.stream, |state| {
                self.release(state);
                ((), true)
            });
        } else {
            self.release(&mut self.stream.state.lock());
        }
    }
}
