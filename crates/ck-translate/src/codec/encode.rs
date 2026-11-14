use ck_stream::{Record, Reservation, Writer};

use super::{
    Error, Result,
    json::{Kind, Scanner},
    source::{Source, Span},
};

/// A counting pass or a mapped reservation. Neither mode buffers output bytes.
pub struct Encoder<'a, 'w> {
    reservation: Option<&'a mut Reservation<'w>>,
    length: usize,
}

impl Encoder<'_, '_> {
    pub fn bytes(&mut self, bytes: &[u8]) -> Result<()> {
        self.length = self.length.checked_add(bytes.len()).ok_or(Error::Limit)?;
        if let Some(reservation) = &mut self.reservation {
            reservation.write(bytes)?;
        }
        Ok(())
    }

    pub fn span(&mut self, source: &Source, span: Span) -> Result<()> {
        source.visit(span, |bytes| self.bytes(bytes))
    }

    /// Re-encode validated JSON topology, dropping only insignificant whitespace.
    pub fn json(&mut self, source: &Source, json: &Scanner, index: usize) -> Result<()> {
        json.validate_source(source)?;
        self.json_value(source, json, index)
    }

    fn json_value(&mut self, source: &Source, json: &Scanner, index: usize) -> Result<()> {
        let node = json.nodes().get(index).ok_or(Error::Position)?;
        match node.kind {
            Kind::Object | Kind::Array => {
                self.bytes(if node.kind == Kind::Object { b"{" } else { b"[" })?;
                let mut child = node.first;
                let mut first = true;
                while let Some(index) = child {
                    let member = &json.nodes()[index];
                    if !first {
                        self.bytes(b",")?;
                    }
                    if node.kind == Kind::Object {
                        self.span(source, member.key.ok_or(Error::Json)?)?;
                        self.bytes(b":")?;
                    }
                    self.json_value(source, json, index)?;
                    first = false;
                    child = member.next;
                }
                self.bytes(if node.kind == Kind::Object { b"}" } else { b"]" })
            }
            _ => self.span(source, node.span),
        }
    }

    pub fn string(&mut self, text: &str) -> Result<()> {
        self.bytes(b"\"")?;
        let mut start = 0;
        for (index, byte) in text.bytes().enumerate() {
            let escaped: Option<&[u8]> = match byte {
                b'"' => Some(b"\\\""),
                b'\\' => Some(b"\\\\"),
                b'\n' => Some(b"\\n"),
                b'\r' => Some(b"\\r"),
                b'\t' => Some(b"\\t"),
                _ => None,
            };
            if let Some(escaped) = escaped {
                self.bytes(&text.as_bytes()[start..index])?;
                self.bytes(escaped)?;
                start = index + 1;
            } else if byte < 0x20 {
                const HEX: &[u8] = b"0123456789abcdef";
                self.bytes(&text.as_bytes()[start..index])?;
                self.bytes(&[
                    b'\\',
                    b'u',
                    b'0',
                    b'0',
                    HEX[(byte >> 4) as usize],
                    HEX[(byte & 15) as usize],
                ])?;
                start = index + 1;
            }
        }
        self.bytes(&text.as_bytes()[start..])?;
        self.bytes(b"\"")
    }

    pub fn unsigned(&mut self, mut value: u64) -> Result<()> {
        let mut bytes = [0u8; 20];
        let mut start = bytes.len();
        loop {
            start -= 1;
            bytes[start] = b'0' + (value % 10) as u8;
            value /= 10;
            if value == 0 {
                break;
            }
        }
        self.bytes(&bytes[start..])
    }
}

/// Count first because ck-stream reserves complete records with a known length.
/// The closure must be deterministic and side-effect-free across both passes.
/// Publication occurs only after the entire second pass succeeds.
pub fn publish(
    output: &mut Writer,
    kind: u32,
    correlation: u32,
    encode: impl Fn(&mut Encoder<'_, '_>) -> Result<()>,
) -> Result<Record> {
    publish_record(output, kind, correlation, false, encode)
}

pub(super) fn publish_record(
    output: &mut Writer,
    kind: u32,
    correlation: u32,
    aligned: bool,
    encode: impl Fn(&mut Encoder<'_, '_>) -> Result<()>,
) -> Result<Record> {
    let mut count = Encoder {
        reservation: None,
        length: 0,
    };
    encode(&mut count)?;
    let length = count.length;
    if aligned && length > ck_stream::FRAME_BYTES {
        return Err(Error::EventTooLarge);
    }
    let mut reservation = output.begin_record(length, aligned, kind, correlation)?;
    {
        let mut encoder = Encoder {
            reservation: Some(&mut reservation),
            length: 0,
        };
        encode(&mut encoder)?;
        if encoder.length != length {
            return Err(Error::Schema);
        }
    }
    Ok(reservation.commit()?)
}
