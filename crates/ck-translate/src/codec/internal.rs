use super::{Error, Result, document::Document, event::Kind, source::Source};
use ck_stream::{Lease, Position, Writer};

const KINDS: &[Kind] = &[
    Kind::Chunk,
    Kind::RequestStart,
    Kind::RequestField,
    Kind::RequestEnd,
    Kind::ResponseStart,
    Kind::ItemStart,
    Kind::ItemEnd,
    Kind::BlockStart,
    Kind::BlockEnd,
    Kind::ReasoningSignature,
    Kind::ReasoningRedacted,
    Kind::ToolStart,
    Kind::ToolEnd,
    Kind::ToolResult,
    Kind::Annotation,
    Kind::Grounding,
    Kind::CodeExecution,
    Kind::UrlContext,
    Kind::Usage,
    Kind::CountTokens,
    Kind::Compact,
    Kind::MediaStart,
    Kind::Data,
    Kind::MediaTranscript,
    Kind::MediaEnd,
    Kind::Operation,
    Kind::Opaque,
    Kind::Heartbeat,
    Kind::Done,
    Kind::Error,
    Kind::Cancelled,
];

/// Decode a trusted canonical lease, retaining its bytes rather than copying SSE data.
/// Wire ingress must never call this function on externally assigned record kinds.
pub fn decode(owner: &mut Writer, lease: Lease) -> Result<(Kind, Document)> {
    let record = lease.record();
    if record.start.generation != owner.id() {
        return Err(Error::Position);
    }
    let kind = *KINDS.get(record.kind as usize).ok_or(Error::Schema)?;
    let mut header = [0u8; 96];
    let mut header_len = 0;
    let mut offset = 0u64;
    let mut data_start = None;
    let mut data_end = None;
    let mut sequence = None;
    let mut name_seen = false;
    let mut line_start = 0;
    let mut invalid = false;
    lease.visit(|chunk| {
        for &byte in chunk {
            if data_start.is_some() {
                if byte == b'\n' {
                    if let Some(end) = data_end {
                        if offset != end + 1 {
                            invalid = true;
                        }
                    } else {
                        data_end = Some(offset);
                    }
                } else if data_end.is_some() {
                    invalid = true;
                }
            } else if byte == b'\n' {
                let line = &header[..header_len];
                if let Some(name) = line.strip_prefix(b"event: ") {
                    if name_seen || kind.name().is_none_or(|expected| name != expected.as_bytes()) {
                        invalid = true;
                    }
                    name_seen = true;
                } else if let Some(id) = line.strip_prefix(b"id: ") {
                    let mut parsed = Some(0u64);
                    if id.is_empty() {
                        invalid = true;
                    }
                    for &b in id {
                        parsed = if b.is_ascii_digit() {
                            parsed
                                .and_then(|n| n.checked_mul(10))
                                .and_then(|n| n.checked_add(u64::from(b - b'0')))
                        } else {
                            None
                        };
                    }
                    if sequence.is_some() || parsed.is_none() {
                        invalid = true;
                    }
                    sequence = parsed;
                } else {
                    invalid = true;
                }
                header_len = 0;
                line_start = offset + 1;
            } else {
                if header_len == header.len() {
                    invalid = true;
                } else {
                    header[header_len] = byte;
                    header_len += 1;
                }
                if header_len == 6 && &header[..6] == b"data: " {
                    data_start = Some(line_start + 6);
                }
            }
            offset += 1;
        }
    })?;
    let start = data_start.ok_or(Error::Schema)?;
    let end = data_end.ok_or(Error::Truncated)?;
    if invalid || end + 2 != record.len() || name_seen != kind.name().is_some() {
        return Err(Error::Schema);
    }
    let mut source = Source::new(owner)?;
    source.push(lease, advance(record.start, start)?..advance(record.start, end)?)?;
    let mut doc = Document::parse(owner, source, record.len())?;
    let x = doc.required(doc.root(), "x_ck")?;
    if doc.unsigned(doc.required(x, "v")?)? != 1 || Some(doc.unsigned(doc.required(x, "seq")?)?) != sequence {
        return Err(Error::Schema);
    }
    if kind == Kind::Chunk {
        super::chat::prepare_response(&mut doc)?;
    }
    Ok((kind, doc))
}

pub(crate) fn next(owner: &mut Writer, reader: &mut ck_stream::Reader) -> Result<(Kind, Document)> {
    match reader.try_next() {
        std::task::Poll::Ready(Some(ck_stream::Read::Record(lease))) => decode(owner, lease),
        _ => Err(Error::Position),
    }
}

fn advance(position: Position, delta: u64) -> Result<Position> {
    let offset = u64::from(position.offset).checked_add(delta).ok_or(Error::Position)?;
    Ok(Position {
        generation: position.generation,
        frame: position
            .frame
            .checked_add(offset / ck_stream::FRAME_BYTES as u64)
            .ok_or(Error::Position)?,
        offset: (offset % ck_stream::FRAME_BYTES as u64) as u32,
    })
}
