use std::sync::atomic::{AtomicU64, Ordering};

use ck_stream::{ByteSpan, Lease, Position};

use super::{Error, Result};

/// Byte offsets into one `Source`, not pointers into the mmap mapping.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Span {
    pub start: u64,
    pub end: u64,
}

impl Span {
    pub fn len(self) -> u64 {
        self.end.saturating_sub(self.start)
    }

    pub fn is_empty(self) -> bool {
        self.start == self.end
    }
}

struct Segment {
    start: u64,
    span: std::ops::Range<Position>,
    lease: Lease,
}

static NEXT_SOURCE: AtomicU64 = AtomicU64::new(1);

fn next_source_id() -> u64 {
    let mut current = NEXT_SOURCE.load(Ordering::Relaxed);
    loop {
        let next = current.checked_add(1).expect("source identity exhausted");
        match NEXT_SOURCE.compare_exchange_weak(current, next, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => return current,
            Err(observed) => current = observed,
        }
    }
}

/// Leased input fragments. Only coordinates and leases are held on the heap.
///
/// The caller owns publication and the exchange quota. Ingress must store network
/// bytes before adding a lease; incomplete input is never a semantic event.
/// The metadata allowance includes allocated segment capacity, not just length.
pub struct Source {
    id: u64,
    segments: Vec<Segment>,
    len: u64,
    max_metadata: usize,
}

impl Source {
    pub fn new(max_metadata: usize) -> Self {
        Self {
            id: next_source_id(),
            segments: Vec::new(),
            len: 0,
            max_metadata,
        }
    }

    pub(crate) fn id(&self) -> u64 {
        self.id
    }

    pub(crate) fn check_live(&self) -> Result<()> {
        if let Some(segment) = self.segments.first() {
            ByteSpan::new(&segment.lease, segment.span.clone())?;
        }
        Ok(())
    }

    pub fn len(&self) -> u64 {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn metadata_bytes(&self) -> usize {
        self.segments.capacity() * std::mem::size_of::<Segment>()
    }

    /// Retain a complete mapped record, or a validated subspan of it.
    pub fn push(&mut self, lease: Lease, range: std::ops::Range<Position>) -> Result<Span> {
        let bytes = ByteSpan::new(&lease, range.clone())?.len();
        if self
            .segments
            .first()
            .is_some_and(|segment| segment.span.start.generation != range.start.generation)
        {
            return Err(Error::Position);
        }
        let end = self.len.checked_add(bytes).ok_or(Error::Limit)?;
        if bytes != 0 {
            if self.segments.len() == self.segments.capacity() {
                let capacity = self.segments.capacity().max(4).checked_mul(2).ok_or(Error::Limit)?;
                if capacity
                    .checked_mul(std::mem::size_of::<Segment>())
                    .ok_or(Error::Limit)?
                    > self.max_metadata
                {
                    return Err(Error::Limit);
                }
                self.segments
                    .try_reserve_exact(capacity - self.segments.len())
                    .map_err(|_| Error::Limit)?;
            }
            self.segments.push(Segment {
                start: self.len,
                span: range,
                lease,
            });
        }
        let span = Span { start: self.len, end };
        self.len = end;
        Ok(span)
    }

    pub fn whole(&self) -> Span {
        Span {
            start: 0,
            end: self.len,
        }
    }

    pub fn cursor(&self, span: Span) -> Result<Cursor<'_>> {
        self.check_live()?;
        if span.start > span.end || span.end > self.len {
            return Err(Error::Position);
        }
        Ok(Cursor {
            source: self,
            offset: span.start,
            end: span.end,
            chunk: &[],
        })
    }

    pub fn visit(&self, span: Span, mut visit: impl FnMut(&[u8]) -> Result<()>) -> Result<()> {
        let mut cursor = self.cursor(span)?;
        while cursor.offset < span.end {
            let chunk = self.chunk(cursor.offset, span.end)?;
            visit(chunk)?;
            cursor.offset += chunk.len() as u64;
        }
        Ok(())
    }

    pub fn equals(&self, span: Span, bytes: &[u8]) -> Result<bool> {
        if span.len() != bytes.len() as u64 {
            return Ok(false);
        }
        let mut cursor = self.cursor(span)?;
        for &byte in bytes {
            if cursor.next_byte()? != Some(byte) {
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// Resolve a source offset to its owning stream generation and frame.
    pub fn position(&self, offset: u64) -> Result<Position> {
        if offset >= self.len {
            return Err(Error::Position);
        }
        let index = self.segments.partition_point(|segment| segment.start <= offset) - 1;
        let segment = &self.segments[index];
        advance(segment.span.start, offset - segment.start)
    }

    fn chunk(&self, offset: u64, end: u64) -> Result<&[u8]> {
        let index = self.segments.partition_point(|segment| segment.start <= offset) - 1;
        let segment = &self.segments[index];
        let position = advance(segment.span.start, offset - segment.start)?;
        let bytes = ByteSpan::new(&segment.lease, segment.span.clone())?.chunk(position)?;
        Ok(&bytes[..bytes.len().min((end - offset) as usize)])
    }
}

fn advance(position: Position, bytes: u64) -> Result<Position> {
    let offset = u64::from(position.offset).checked_add(bytes).ok_or(Error::Position)?;
    Ok(Position {
        generation: position.generation,
        frame: position
            .frame
            .checked_add(offset / ck_stream::FRAME_BYTES as u64)
            .ok_or(Error::Position)?,
        offset: (offset % ck_stream::FRAME_BYTES as u64) as u32,
    })
}

/// A cursor caches only a temporary borrowed frame span under `Source`'s lease.
pub struct Cursor<'a> {
    source: &'a Source,
    pub(crate) offset: u64,
    end: u64,
    chunk: &'a [u8],
}

impl Cursor<'_> {
    pub fn offset(&self) -> u64 {
        self.offset
    }

    pub fn next_byte(&mut self) -> Result<Option<u8>> {
        if self.offset == self.end {
            return Ok(None);
        }
        if self.chunk.is_empty() {
            self.chunk = self.source.chunk(self.offset, self.end)?;
        }
        let byte = self.chunk[0];
        self.chunk = &self.chunk[1..];
        self.offset += 1;
        Ok(Some(byte))
    }
}
