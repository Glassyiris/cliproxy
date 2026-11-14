use std::{
    collections::HashMap,
    hash::{BuildHasher, Hasher},
};

use super::{
    Error, Result,
    source::{Cursor, Source, Span},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Kind {
    Object,
    Array,
    String,
    Number,
    Bool,
    Null,
}

/// A JSON value index contains coordinates and topology, never decoded payloads.
#[derive(Clone, Copy, Debug)]
pub struct Node {
    pub kind: Kind,
    pub span: Span,
    pub key: Option<Span>,
    pub first: Option<usize>,
    pub next: Option<usize>,
}

#[derive(Clone, Copy)]
enum Expect {
    ObjectFirst,
    Key,
    Colon,
    Value,
    ArrayFirst,
    ArrayValue,
    Comma,
}
struct Frame {
    node: usize,
    expect: Expect,
    key: Option<Span>,
    last: Option<usize>,
}
struct Key {
    span: Span,
    previous: Option<usize>,
}
#[derive(Clone, Copy)]
enum Mode {
    Idle,
    String { start: u64, escaped: bool, key: bool },
    Atom { start: u64 },
}

/// Incremental strict JSON scanner. `advance` reads only newly appended input.
///
/// Duplicate keys compare decoded strings, including escape-equivalent spellings.
/// Metadata and nesting are bounded; strings/numbers/unknown values remain spans.
/// Any error poisons the scanner. `finish` is mandatory at the body boundary.
pub struct Scanner {
    nodes: Vec<Node>,
    frames: Vec<Frame>,
    keys: Vec<Key>,
    key_heads: HashMap<(usize, u64), usize>,
    hash: std::collections::hash_map::RandomState,
    mode: Mode,
    offset: u64,
    source_id: Option<u64>,
    max_bytes: u64,
    metadata: ck_stream::MetadataPermit,
    failed: bool,
    finished: bool,
    utf8: Utf8,
}

impl Scanner {
    pub fn new(owner: &mut ck_stream::Writer, max_bytes: u64) -> Result<Self> {
        Ok(Self {
            nodes: Vec::new(),
            frames: Vec::new(),
            keys: Vec::new(),
            key_heads: HashMap::new(),
            hash: Default::default(),
            mode: Mode::Idle,
            offset: 0,
            source_id: None,
            max_bytes,
            metadata: owner.reserve_metadata(0)?,
            failed: false,
            finished: false,
            utf8: Utf8::default(),
        })
    }

    pub fn nodes(&self) -> &[Node] {
        &self.nodes
    }
    pub fn is_finished(&self) -> bool {
        self.finished
    }

    /// Reject pairing validated locations with another or subsequently extended source.
    pub fn validate_source(&self, source: &Source) -> Result<()> {
        source.check_live()?;
        if source.stream_id() != self.metadata.stream_id() {
            return Err(Error::Position);
        }
        if self.source_id != Some(source.id()) || self.offset != source.len() {
            return Err(Error::Position);
        }
        if !self.finished {
            return Err(Error::Truncated);
        }
        Ok(())
    }

    pub fn advance(&mut self, source: &Source) -> Result<()> {
        if self.failed || self.finished {
            return Err(Error::Closed);
        }
        let result = self.scan(source);
        if result.is_err() {
            self.failed = true;
        }
        result
    }

    fn scan(&mut self, source: &Source) -> Result<()> {
        if source.stream_id() != self.metadata.stream_id() || self.source_id.is_some_and(|id| id != source.id()) {
            return Err(Error::Position);
        }
        self.source_id = Some(source.id());
        if source.len() < self.offset {
            return Err(Error::Position);
        }
        if source.len() > self.max_bytes {
            return Err(Error::EventTooLarge);
        }
        let mut cursor = source.cursor(Span {
            start: self.offset,
            end: source.len(),
        })?;
        while let Some(byte) = cursor.next_byte()? {
            let at = self.offset;
            self.utf8.push(byte)?;
            self.offset += 1;
            self.byte(source, at, byte)?;
        }
        Ok(())
    }

    fn byte(&mut self, source: &Source, at: u64, byte: u8) -> Result<()> {
        match self.mode {
            Mode::String { start, escaped, key } => {
                if byte < 0x20 {
                    return Err(Error::Json);
                }
                if escaped {
                    self.mode = Mode::String {
                        start,
                        escaped: false,
                        key,
                    };
                } else if byte == b'\\' {
                    self.mode = Mode::String {
                        start,
                        escaped: true,
                        key,
                    };
                } else if byte == b'"' {
                    let span = Span { start, end: at + 1 };
                    let mut decoded = Decoded::new(source, span)?;
                    while decoded.next_scalar()?.is_some() {}
                    self.mode = Mode::Idle;
                    if key {
                        self.key(source, span)?;
                    } else {
                        self.value(Kind::String, span)?;
                    }
                }
                return Ok(());
            }
            Mode::Atom { start } => {
                if !matches!(byte, b' ' | b'\t' | b'\r' | b'\n' | b',' | b']' | b'}') {
                    return Ok(());
                }
                self.atom(source, Span { start, end: at })?;
                self.mode = Mode::Idle;
            }
            Mode::Idle => {}
        }
        if matches!(byte, b' ' | b'\t' | b'\r' | b'\n') {
            return Ok(());
        }
        let expect = self.frames.last().map(|frame| frame.expect);
        match byte {
            b'}' | b']' => {
                let frame = self.frames.last().ok_or(Error::Json)?;
                let kind = self.nodes[frame.node].kind;
                let valid = match kind {
                    Kind::Object => byte == b'}' && matches!(frame.expect, Expect::ObjectFirst | Expect::Comma),
                    Kind::Array => byte == b']' && matches!(frame.expect, Expect::ArrayFirst | Expect::Comma),
                    _ => false,
                };
                if !valid {
                    return Err(Error::Json);
                }
                self.nodes[frame.node].span.end = at + 1;
                self.frames.pop();
            }
            b',' => {
                let frame = self.frames.last_mut().ok_or(Error::Json)?;
                if !matches!(frame.expect, Expect::Comma) {
                    return Err(Error::Json);
                }
                frame.expect = if self.nodes[frame.node].kind == Kind::Object {
                    Expect::Key
                } else {
                    Expect::ArrayValue
                };
            }
            b':' => {
                let frame = self.frames.last_mut().ok_or(Error::Json)?;
                if !matches!(frame.expect, Expect::Colon) {
                    return Err(Error::Json);
                }
                frame.expect = Expect::Value;
            }
            b'"' if matches!(expect, Some(Expect::ObjectFirst | Expect::Key)) => {
                self.mode = Mode::String {
                    start: at,
                    escaped: false,
                    key: true,
                };
            }
            _ => {
                if !matches!(
                    expect,
                    None | Some(Expect::Value | Expect::ArrayFirst | Expect::ArrayValue)
                ) || (expect.is_none() && !self.nodes.is_empty())
                {
                    return Err(Error::Json);
                }
                match byte {
                    b'{' | b'[' => {
                        if self.frames.len() >= 128 {
                            return Err(Error::Limit);
                        }
                        let kind = if byte == b'{' { Kind::Object } else { Kind::Array };
                        let node = self.value(kind, Span { start: at, end: 0 })?;
                        self.reserve(0, 1, 0)?;
                        self.frames.push(Frame {
                            node,
                            expect: if byte == b'{' {
                                Expect::ObjectFirst
                            } else {
                                Expect::ArrayFirst
                            },
                            key: None,
                            last: None,
                        });
                    }
                    b'"' => {
                        self.mode = Mode::String {
                            start: at,
                            escaped: false,
                            key: false,
                        }
                    }
                    b'-' | b'0'..=b'9' | b't' | b'f' | b'n' => self.mode = Mode::Atom { start: at },
                    _ => return Err(Error::Json),
                }
            }
        }
        Ok(())
    }

    fn reserve(&mut self, nodes: usize, frames: usize, keys: usize) -> Result<()> {
        let n = capacity(self.nodes.len() + nodes, self.nodes.capacity());
        let f = capacity(self.frames.len() + frames, self.frames.capacity());
        let k = capacity(self.keys.len() + keys, self.keys.capacity());
        // Hash-table capacity includes control bytes and spare buckets; reserve a
        // conservative four buckets per key before asking the allocator to grow.
        let bytes = n
            .checked_mul(std::mem::size_of::<Node>())
            .and_then(|v| v.checked_add(f * std::mem::size_of::<Frame>()))
            .and_then(|v| v.checked_add(k * (std::mem::size_of::<Key>() + 4 * 32)))
            .ok_or(Error::Limit)?;
        self.metadata.resize(bytes)?;
        if n > self.nodes.capacity() {
            self.nodes
                .try_reserve_exact(n - self.nodes.len())
                .map_err(|_| Error::Limit)?;
        }
        if f > self.frames.capacity() {
            self.frames
                .try_reserve_exact(f - self.frames.len())
                .map_err(|_| Error::Limit)?;
        }
        if k > self.keys.capacity() {
            self.keys
                .try_reserve_exact(k - self.keys.len())
                .map_err(|_| Error::Limit)?;
            self.key_heads
                .try_reserve(k - self.key_heads.len())
                .map_err(|_| Error::Limit)?;
        }
        Ok(())
    }

    fn key(&mut self, source: &Source, span: Span) -> Result<()> {
        let parent = self.frames.last().ok_or(Error::Json)?.node;
        let mut hash = self.hash.build_hasher();
        let mut decoded = Decoded::new(source, span)?;
        while let Some(scalar) = decoded.next_scalar()? {
            hash.write_u32(scalar as u32);
        }
        let key = (parent, hash.finish());
        let previous = self.key_heads.get(&key).copied();
        let mut cursor = previous;
        while let Some(index) = cursor {
            if string_eq(source, span, self.keys[index].span)? {
                return Err(Error::DuplicateKey);
            }
            cursor = self.keys[index].previous;
        }
        self.reserve(0, 0, 1)?;
        self.key_heads.insert(key, self.keys.len());
        self.keys.push(Key { span, previous });
        let frame = self.frames.last_mut().unwrap();
        frame.key = Some(span);
        frame.expect = Expect::Colon;
        Ok(())
    }

    fn value(&mut self, kind: Kind, span: Span) -> Result<usize> {
        self.reserve(1, 0, 0)?;
        let index = self.nodes.len();
        let key = if let Some(frame) = self.frames.last_mut() {
            if let Some(last) = frame.last {
                self.nodes[last].next = Some(index);
            } else {
                self.nodes[frame.node].first = Some(index);
            }
            frame.last = Some(index);
            frame.expect = Expect::Comma;
            frame.key.take()
        } else {
            None
        };
        self.nodes.push(Node {
            kind,
            span,
            key,
            first: None,
            next: None,
        });
        Ok(index)
    }

    fn atom(&mut self, source: &Source, span: Span) -> Result<()> {
        let kind = if source.equals(span, b"true")? || source.equals(span, b"false")? {
            Kind::Bool
        } else if source.equals(span, b"null")? {
            Kind::Null
        } else {
            number(source, span)?;
            Kind::Number
        };
        self.value(kind, span)?;
        Ok(())
    }

    pub fn finish(&mut self, source: &Source) -> Result<()> {
        self.advance(source)?;
        let result = (|| {
            if let Mode::Atom { start } = self.mode {
                self.atom(
                    source,
                    Span {
                        start,
                        end: self.offset,
                    },
                )?;
                self.mode = Mode::Idle;
            }
            self.utf8.finish()?;
            if !matches!(self.mode, Mode::Idle) || !self.frames.is_empty() || self.nodes.is_empty() {
                return Err(Error::Truncated);
            }
            Ok(())
        })();
        if result.is_err() {
            self.failed = true;
        } else {
            self.finished = true;
        }
        result
    }

    pub fn member(&self, source: &Source, object: usize, name: &str) -> Result<Option<usize>> {
        self.validate_source(source)?;
        if self.nodes.get(object).is_none_or(|node| node.kind != Kind::Object) {
            return Err(Error::Json);
        }
        let mut child = self.nodes[object].first;
        while let Some(index) = child {
            if string_is(source, self.nodes[index].key.ok_or(Error::Json)?, name)? {
                return Ok(Some(index));
            }
            child = self.nodes[index].next;
        }
        Ok(None)
    }
}

fn capacity(needed: usize, current: usize) -> usize {
    if needed > current {
        needed.max(8).next_power_of_two()
    } else {
        current
    }
}

fn number(source: &Source, span: Span) -> Result<()> {
    let mut cursor = source.cursor(span)?;
    let mut byte = cursor.next_byte()?;
    if byte == Some(b'-') {
        byte = cursor.next_byte()?;
    }
    match byte {
        Some(b'0') => byte = cursor.next_byte()?,
        Some(b'1'..=b'9') => {
            while matches!(byte, Some(b'0'..=b'9')) {
                byte = cursor.next_byte()?;
            }
        }
        _ => return Err(Error::Json),
    }
    if byte == Some(b'.') {
        byte = cursor.next_byte()?;
        if !matches!(byte, Some(b'0'..=b'9')) {
            return Err(Error::Json);
        }
        while matches!(byte, Some(b'0'..=b'9')) {
            byte = cursor.next_byte()?;
        }
    }
    if matches!(byte, Some(b'e' | b'E')) {
        byte = cursor.next_byte()?;
        if matches!(byte, Some(b'+' | b'-')) {
            byte = cursor.next_byte()?;
        }
        if !matches!(byte, Some(b'0'..=b'9')) {
            return Err(Error::Json);
        }
        while matches!(byte, Some(b'0'..=b'9')) {
            byte = cursor.next_byte()?;
        }
    }
    if byte.is_some() {
        return Err(Error::Json);
    }
    Ok(())
}

pub fn string_is(source: &Source, span: Span, text: &str) -> Result<bool> {
    let mut decoded = Decoded::new(source, span)?;
    for scalar in text.chars() {
        if decoded.next_scalar()? != Some(scalar) {
            return Ok(false);
        }
    }
    Ok(decoded.next_scalar()?.is_none())
}

fn string_eq(source: &Source, left: Span, right: Span) -> Result<bool> {
    let mut left = Decoded::new(source, left)?;
    let mut right = Decoded::new(source, right)?;
    loop {
        let a = left.next_scalar()?;
        if a != right.next_scalar()? {
            return Ok(false);
        }
        if a.is_none() {
            return Ok(true);
        }
    }
}

/// Decode one scalar at a time, including surrogate pairs, without a String.
pub struct Decoded<'a> {
    cursor: Cursor<'a>,
}
impl<'a> Decoded<'a> {
    pub fn new(source: &'a Source, span: Span) -> Result<Self> {
        if span.len() < 2
            || !source.equals(
                Span {
                    start: span.start,
                    end: span.start + 1,
                },
                b"\"",
            )?
            || !source.equals(
                Span {
                    start: span.end - 1,
                    end: span.end,
                },
                b"\"",
            )?
        {
            return Err(Error::Json);
        }
        Ok(Self {
            cursor: source.cursor(Span {
                start: span.start + 1,
                end: span.end - 1,
            })?,
        })
    }

    fn hex(&mut self) -> Result<u32> {
        let mut value = 0;
        for _ in 0..4 {
            let byte = self.cursor.next_byte()?.ok_or(Error::Json)?;
            value = value * 16
                + match byte {
                    b'0'..=b'9' => u32::from(byte - b'0'),
                    b'a'..=b'f' => u32::from(byte - b'a' + 10),
                    b'A'..=b'F' => u32::from(byte - b'A' + 10),
                    _ => return Err(Error::Json),
                };
        }
        Ok(value)
    }

    pub fn next_scalar(&mut self) -> Result<Option<char>> {
        let Some(byte) = self.cursor.next_byte()? else {
            return Ok(None);
        };
        let scalar = if byte == b'\\' {
            match self.cursor.next_byte()?.ok_or(Error::Json)? {
                b'"' => '"',
                b'\\' => '\\',
                b'/' => '/',
                b'b' => '\u{8}',
                b'f' => '\u{c}',
                b'n' => '\n',
                b'r' => '\r',
                b't' => '\t',
                b'u' => {
                    let mut code = self.hex()?;
                    if (0xd800..=0xdbff).contains(&code) {
                        if self.cursor.next_byte()? != Some(b'\\') || self.cursor.next_byte()? != Some(b'u') {
                            return Err(Error::Json);
                        }
                        let low = self.hex()?;
                        if !(0xdc00..=0xdfff).contains(&low) {
                            return Err(Error::Json);
                        }
                        code = 0x10000 + ((code - 0xd800) << 10) + low - 0xdc00;
                    }
                    char::from_u32(code).ok_or(Error::Json)?
                }
                _ => return Err(Error::Json),
            }
        } else if byte < 0x80 {
            if byte < 0x20 || byte == b'"' {
                return Err(Error::Json);
            }
            byte as char
        } else {
            let len = match byte {
                0xc2..=0xdf => 2,
                0xe0..=0xef => 3,
                0xf0..=0xf4 => 4,
                _ => return Err(Error::Utf8),
            };
            let mut bytes = [0; 4];
            bytes[0] = byte;
            for slot in &mut bytes[1..len] {
                *slot = self.cursor.next_byte()?.ok_or(Error::Utf8)?;
            }
            std::str::from_utf8(&bytes[..len])
                .map_err(|_| Error::Utf8)?
                .chars()
                .next()
                .ok_or(Error::Utf8)?
        };
        Ok(Some(scalar))
    }
}

#[derive(Default)]
pub(crate) struct Utf8 {
    remaining: u8,
    min: u8,
    max: u8,
}
impl Utf8 {
    pub(crate) fn push(&mut self, byte: u8) -> Result<()> {
        if self.remaining != 0 {
            if byte < self.min || byte > self.max {
                return Err(Error::Utf8);
            }
            self.remaining -= 1;
            self.min = 0x80;
            self.max = 0xbf;
        } else {
            let (remaining, min, max) = match byte {
                0..=0x7f => (0, 0, 0),
                0xc2..=0xdf => (1, 0x80, 0xbf),
                0xe0 => (2, 0xa0, 0xbf),
                0xe1..=0xec | 0xee..=0xef => (2, 0x80, 0xbf),
                0xed => (2, 0x80, 0x9f),
                0xf0 => (3, 0x90, 0xbf),
                0xf1..=0xf3 => (3, 0x80, 0xbf),
                0xf4 => (3, 0x80, 0x8f),
                _ => return Err(Error::Utf8),
            };
            self.remaining = remaining;
            self.min = min;
            self.max = max;
        }
        Ok(())
    }
    pub(crate) fn finish(&self) -> Result<()> {
        if self.remaining == 0 { Ok(()) } else { Err(Error::Utf8) }
    }
}
