use std::{
    collections::VecDeque,
    sync::{Arc, Mutex, atomic::Ordering},
    task::Poll,
    time::Duration,
};

use tokio::sync::Notify;

use crate::{Error, FRAME_BYTES, Limits, Position, Record, Terminal, cache::Inner, pool::Pool};

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
    gone: bool,
    readers: usize,
    pub last_read: Duration,
}

#[repr(align(128))]
pub(crate) struct Stream {
    pub id: u64,
    slot: u32,
    pool: Arc<Pool>,
    limits: Limits,
    pub state: Mutex<State>,
    notify: Notify,
}

impl Stream {
    pub(crate) fn new(id: u64, slot: u32, pool: Arc<Pool>, limits: Limits, now: Duration) -> Self {
        Self {
            id,
            slot,
            pool,
            limits,
            notify: Notify::new(),
            state: Mutex::new(State {
                frames: VecDeque::new(),
                base_frame: 0,
                records: VecDeque::new(),
                base_sequence: 0,
                next_sequence: 0,
                end: 0,
                terminal: None,
                gone: false,
                readers: 0,
                last_read: now,
            }),
        }
    }

    fn metadata(state: &State) -> usize {
        state.frames.capacity() * std::mem::size_of::<Frame>()
            + state.records.capacity() * std::mem::size_of::<Index>()
            + state.readers * READER_BYTES
    }

    pub(crate) fn finish(&self, terminal: Terminal) {
        if terminal == Terminal::Gone {
            self.invalidate();
            return;
        }
        let mut state = self.state.lock().unwrap();
        if state.terminal.is_none() {
            state.terminal = Some(terminal);
            self.pool.header(self.slot).generation.fetch_add(1, Ordering::Release);
        }
        drop(state);
        self.notify.notify_waiters();
    }

    pub(crate) fn invalidate(&self) {
        self.invalidate_locked(&mut self.state.lock().unwrap());
    }

    pub(crate) fn invalidate_locked(&self, state: &mut State) -> u32 {
        let mut released = 0;
        state.gone = true;
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
        self.pool.header(self.slot).generation.fetch_add(1, Ordering::Release);
        self.notify.notify_waiters();
        released
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        let state = self.state.get_mut().unwrap();
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
        let result = self.reserve(len, aligned, kind, correlation);
        if matches!(result, Err(Error::StorageExhausted | Error::Io(_))) {
            self.stream.finish(Terminal::StorageExhausted);
        }
        let (record, index, old_count) = result?;
        Ok(Reservation {
            writer: self,
            record,
            index,
            old_count,
            written: 0,
            committed: false,
        })
    }

    fn reserve(&self, len: usize, aligned: bool, kind: u32, correlation: u32) -> Result<(Record, Index, usize), Error> {
        if len == 0 || len > self.inner.limits.max_event_bytes || (aligned && len > FRAME_BYTES) {
            return Err(Error::InvalidRecord);
        }
        let mut state = self.stream.state.lock().unwrap();
        if state.gone {
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
            && state.frames.iter().filter(|frame| frame.pool.is_some()).count() + extra
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
        let reader_bytes = state.readers * READER_BYTES;
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
        // Allocation may evict another stream. Never enter cache ownership with metadata locked.
        drop(state);
        for _ in 0..extra {
            let frame = match self.inner.allocate(self.id()) {
                Ok(frame) => frame,
                Err(error) => {
                    self.rollback(old_count);
                    return Err(error);
                }
            };
            let mut state = self.stream.state.lock().unwrap();
            if state.gone || state.terminal.is_some() {
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
        Ok((record, index, old_count))
    }

    fn rollback(&self, old_count: usize) {
        let mut state = self.stream.state.lock().unwrap();
        while state.frames.len() > old_count {
            if let Some(frame) = state.frames.pop_back().unwrap().pool {
                self.inner.pool.release(frame);
            }
        }
    }

    pub fn append(&mut self, bytes: &[u8]) -> Result<Record, Error> {
        let mut reservation = self.begin_record(bytes.len(), false, 0, 0)?;
        reservation.write(bytes)?;
        reservation.commit()
    }

    pub fn finish(&mut self, terminal: Terminal) {
        self.stream.finish(terminal);
    }

    /// Release a non-resumable request/scratch prefix. Response records must never use this API.
    /// Frame numbers and record sequence numbers are never recycled.
    pub fn release_before(&mut self, position: Position) -> Result<(), Error> {
        let end = position.byte(self.id())?;
        let mut state = self.stream.state.lock().unwrap();
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
    pub fn write(&mut self, mut bytes: &[u8]) -> Result<(), Error> {
        if bytes.len() > self.record.len() as usize - self.written {
            return Err(Error::InvalidPosition);
        }
        let stream = &self.writer.stream;
        let state = stream.state.lock().unwrap();
        if state.gone {
            return Err(Error::Gone);
        }
        if state.terminal.is_some() {
            return Err(Error::Closed);
        }
        while !bytes.is_empty() {
            let byte = self.record.start.byte(stream.id)? + self.written as u64;
            let frame_number = byte / FRAME_BYTES as u64;
            let offset = byte as usize % FRAME_BYTES;
            let len = bytes.len().min(FRAME_BYTES - offset);
            let frame = state.frames[(frame_number - state.base_frame) as usize]
                .pool
                .ok_or(Error::Gone)?;
            // SAFETY: the sole Writer reserved this frame; the locked state prevents invalidation,
            // and this span is strictly after the immutable published end and within the frame.
            unsafe {
                stream.pool.write(frame, offset, &bytes[..len]);
            }
            self.written += len;
            bytes = &bytes[len..];
        }
        Ok(())
    }

    pub fn commit(mut self) -> Result<Record, Error> {
        if self.written != self.record.len() as usize {
            return Err(Error::IncompleteRecord);
        }
        let stream = &self.writer.stream;
        let mut state = stream.state.lock().unwrap();
        if state.gone {
            return Err(Error::Gone);
        }
        if state.terminal.is_some() {
            return Err(Error::Closed);
        }
        if let Some(last) = state.records.back_mut().filter(|last| last.extends(&self.index)) {
            last.next_sequence = self.index.next_sequence;
        } else {
            state.records.push_back(self.index);
        }
        state.next_sequence = self.index.next_sequence;
        state.end = self.record.end.byte(stream.id)?;
        stream
            .pool
            .header(stream.slot)
            .committed
            .store(state.end, Ordering::Release);
        stream
            .pool
            .header(stream.slot)
            .generation
            .fetch_add(1, Ordering::Release);
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
    inner: Arc<Inner>,
    stream: Arc<Stream>,
    next: u64,
    terminal_seen: bool,
}

impl Reader {
    pub(crate) fn new(inner: Arc<Inner>, stream: Arc<Stream>, after: u64) -> Result<Self, Error> {
        {
            let mut state = stream.state.lock().unwrap();
            if state.gone || after < state.base_sequence {
                return Err(Error::Gone);
            }
            if after > state.next_sequence {
                return Err(Error::InvalidPosition);
            }
            if Stream::metadata(&state) + READER_BYTES > stream.limits.max_metadata_bytes {
                return Err(Error::StorageExhausted);
            }
            state.readers += 1;
        }
        Ok(Self {
            inner,
            stream,
            next: after,
            terminal_seen: false,
        })
    }

    pub fn try_next(&mut self) -> Poll<Option<Read>> {
        if self.terminal_seen {
            return Poll::Ready(None);
        }
        let inner = &self.inner;
        let stream = &self.stream;
        inner.reading(stream, |state| {
            if state.gone || self.next < state.base_sequence {
                self.terminal_seen = true;
                return (Poll::Ready(Some(Read::Terminal(Terminal::Gone))), false);
            }
            // The header is the publication authority; state supplies complete-record boundaries.
            let committed = stream.pool.header(stream.slot).committed.load(Ordering::Acquire);
            let index = state.records.partition_point(|run| run.next_sequence <= self.next);
            if let Some(record) = state
                .records
                .get(index)
                .and_then(|run| run.record(stream.id, self.next))
                && record.end.byte(stream.id).is_ok_and(|end| end <= committed)
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
                        inner: inner.clone(),
                        stream: stream.clone(),
                        record,
                    }))),
                    true,
                );
            }
            if let Some(terminal) = state.terminal {
                self.terminal_seen = true;
                return (Poll::Ready(Some(Read::Terminal(terminal))), false);
            }
            (Poll::Pending, false)
        })
    }

    pub async fn next(&mut self) -> Option<Read> {
        loop {
            let stream = self.stream.clone();
            let notified = stream.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Poll::Ready(value) = self.try_next() {
                return value;
            }
            notified.await;
        }
    }
}

impl Drop for Reader {
    fn drop(&mut self) {
        self.stream.state.lock().unwrap().readers -= 1;
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
    inner: Arc<Inner>,
    stream: Arc<Stream>,
    record: Record,
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
        let state = self.stream.state.lock().unwrap();
        if state.gone {
            return Err(Error::Gone);
        }
        let frame = state.frames[(position.frame - state.base_frame) as usize]
            .pool
            .ok_or(Error::Gone)?;
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

    pub fn acknowledge(self) {
        self.inner.touch(&self.stream);
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        let mut state = self.stream.state.lock().unwrap();
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
