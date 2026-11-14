#[path = "document_pending.rs"]
pub(crate) mod pending;

use ck_stream::{MetadataPermit, Writer};

use super::{
    Error, Result,
    encode::Encoder,
    json,
    source::{Source, Span},
};

#[derive(Clone, Copy, Debug)]
pub struct Text {
    pub source: usize,
    pub span: Span,
}

#[derive(Clone, Copy, Debug)]
pub enum Name {
    Mapped(Text),
    Pointer(Text),
    Static(&'static str),
}

#[derive(Clone, Copy, Debug)]
pub enum Value {
    Object,
    Array,
    Fragments,
    Base64Fragments,
    Utf8Media,
    String(Text),
    Number(Text),
    Bool(bool),
    Null,
    Text(&'static str),
    Unsigned(u64),
    Id(super::event::LocalId),
}

#[derive(Clone, Copy, Debug)]
pub struct Node {
    pub name: Option<Name>,
    pub value: Value,
    pub first: Option<usize>,
    pub next: Option<usize>,
    pub parent: Option<usize>,
    pub revision: u64,
    last: Option<usize>,
    origin: Option<(usize, Option<&'static str>)>,
    origin_next: Option<usize>,
    origins: Option<usize>,
    last_origin: Option<usize>,
    published: bool,
    input_key: Option<Span>,
}

/// Mutable normalized topology; payloads remain under mapped leases.
/// Borrowing this document for a capability token prevents subsequent mutation.
pub struct Document {
    sources: Vec<Source>,
    nodes: Vec<Node>,
    metadata: MetadataPermit,
    root: usize,
}

impl Document {
    pub(crate) fn id(&self) -> u64 {
        self.sources[0].id()
    }
    pub fn parse(owner: &mut Writer, source: Source, max_bytes: u64) -> Result<Self> {
        source.check_owner(owner)?;
        let mut scanner = json::Scanner::new(owner, max_bytes)?;
        scanner.finish(&source)?;
        Self::from_scanned(owner, source, scanner)
    }

    pub fn from_scanned(owner: &mut Writer, source: Source, scanner: json::Scanner) -> Result<Self> {
        source.check_owner(owner)?;
        let mut doc = Self {
            sources: Vec::new(),
            nodes: Vec::new(),
            metadata: owner.reserve_metadata(0)?,
            root: 0,
        };
        doc.import(source, &scanner)?;
        Ok(doc)
    }

    pub(crate) fn streaming(owner: &mut Writer) -> Result<Self> {
        let mut doc = Self {
            sources: Vec::new(),
            nodes: Vec::new(),
            metadata: owner.reserve_metadata(0)?,
            root: 0,
        };
        doc.reserve(1, 1)?;
        doc.sources.push(Source::new(owner)?);
        doc.add(None, Value::Object)?;
        Ok(doc)
    }

    pub(crate) fn input(&self) -> &Source {
        &self.sources[0]
    }

    pub(crate) fn push_input(&mut self, owner: &mut Writer, bytes: &[u8]) -> Result<()> {
        self.sources[0].push_bytes(owner, bytes)?;
        Ok(())
    }

    /// Import only a completed subtree; the input lease remains owned by this document.
    pub(crate) fn import_completed(&mut self, scanner: &json::Scanner, index: usize) -> Result<usize> {
        let node = scanner.completed_node(self.input(), index)?.ok_or(Error::Truncated)?;
        let text = Text {
            source: 0,
            span: node.span,
        };
        let value = match node.kind {
            json::Kind::Object => Value::Object,
            json::Kind::Array => Value::Array,
            json::Kind::String => Value::String(text),
            json::Kind::Number => Value::Number(text),
            json::Kind::Bool => Value::Bool(self.input().equals(node.span, b"true")?),
            json::Kind::Null => Value::Null,
        };
        let target = self.add(node.key.map(|span| Name::Mapped(Text { source: 0, span })), value)?;
        let mut child = node.first;
        while let Some(index) = child {
            child = scanner.pending_node(self.input(), index)?.next;
            let imported = self.import_completed(scanner, index)?;
            self.append(target, imported)?;
        }
        Ok(target)
    }

    fn reserve(&mut self, nodes: usize, sources: usize) -> Result<()> {
        let n = (self.nodes.len() + nodes)
            .max(self.nodes.capacity())
            .max(8)
            .checked_next_power_of_two()
            .ok_or(Error::Limit)?;
        let s = (self.sources.len() + sources)
            .max(self.sources.capacity())
            .max(2)
            .checked_next_power_of_two()
            .ok_or(Error::Limit)?;
        self.metadata.resize(
            n.checked_mul(std::mem::size_of::<Node>())
                .and_then(|v| v.checked_add(s * std::mem::size_of::<Source>()))
                .ok_or(Error::Limit)?,
        )?;
        if n > self.nodes.capacity() {
            self.nodes
                .try_reserve_exact(n - self.nodes.len())
                .map_err(|_| Error::Limit)?;
        }
        if s > self.sources.capacity() {
            self.sources
                .try_reserve_exact(s - self.sources.len())
                .map_err(|_| Error::Limit)?;
        }
        self.metadata.resize(
            self.nodes.capacity() * std::mem::size_of::<Node>()
                + self.sources.capacity() * std::mem::size_of::<Source>(),
        )?;
        Ok(())
    }

    fn import(&mut self, source: Source, scanner: &json::Scanner) -> Result<usize> {
        scanner.validate_source(&source)?;
        if source.stream_id() != self.stream_id() {
            return Err(Error::Position);
        }
        self.reserve(scanner.nodes().len(), 1)?;
        let part = self.sources.len();
        let base = self.nodes.len();
        for n in scanner.nodes() {
            let text = Text {
                source: part,
                span: n.span,
            };
            let value = match n.kind {
                json::Kind::Object => Value::Object,
                json::Kind::Array => Value::Array,
                json::Kind::String => Value::String(text),
                json::Kind::Number => Value::Number(text),
                json::Kind::Bool => Value::Bool(source.equals(n.span, b"true")?),
                json::Kind::Null => Value::Null,
            };
            self.nodes.push(Node {
                name: n.key.map(|span| Name::Mapped(Text { source: part, span })),
                value,
                first: n.first.map(|i| i + base),
                next: n.next.map(|i| i + base),
                parent: None,
                revision: 0,
                last: None,
                origin: None,
                origin_next: None,
                origins: None,
                last_origin: None,
                published: false,
                input_key: if part == 0 { n.key } else { None },
            });
        }
        for parent in base..self.nodes.len() {
            let mut child = self.nodes[parent].first;
            while let Some(index) = child {
                self.nodes[index].parent = Some(parent);
                self.nodes[parent].last = Some(index);
                child = self.nodes[index].next;
            }
        }
        self.sources.push(source);
        Ok(base)
    }

    pub fn import_json(&mut self, owner: &mut Writer, lease: ck_stream::ScratchLease) -> Result<usize> {
        self.check_owner(owner)?;
        let mut source = Source::new(owner)?;
        source.push_scratch(lease)?;
        let mut scanner = json::Scanner::new(owner, source.len())?;
        scanner.finish(&source)?;
        self.import(source, &scanner)
    }

    pub fn absorb(&mut self, mut other: Document) -> Result<usize> {
        self.check_live()?;
        other.check_live()?;
        if self.stream_id() != other.stream_id() {
            return Err(Error::Position);
        }
        self.reserve(other.nodes.len(), other.sources.len())?;
        let base = self.nodes.len();
        let source_base = self.sources.len();
        for mut node in other.nodes.drain(..) {
            if let Some(Name::Mapped(text) | Name::Pointer(text)) = &mut node.name {
                text.source += source_base;
            }
            if let Value::String(text) | Value::Number(text) = &mut node.value {
                text.source += source_base;
            }
            node.first = node.first.map(|i| i + base);
            node.next = node.next.map(|i| i + base);
            node.parent = node.parent.map(|i| i + base);
            node.last = node.last.map(|i| i + base);
            node.origin = node.origin.map(|(parent, carrier)| (parent + base, carrier));
            node.origin_next = node.origin_next.map(|i| i + base);
            node.origins = node.origins.map(|i| i + base);
            node.last_origin = node.last_origin.map(|i| i + base);
            self.nodes.push(node);
        }
        self.sources.append(&mut other.sources);
        Ok(base + other.root)
    }

    pub fn names_equal(&self, a: Name, b: Name) -> Result<bool> {
        let mut a = self.name_chars(a)?;
        let mut b = self.name_chars(b)?;
        loop {
            let c = a.next_scalar()?;
            if c != b.next_scalar()? {
                return Ok(false);
            }
            if c.is_none() {
                return Ok(true);
            }
        }
    }

    pub fn stream_id(&self) -> u64 {
        self.metadata.stream_id()
    }
    pub fn check_live(&self) -> Result<()> {
        self.metadata.check_live()?;
        Ok(())
    }
    pub fn check_owner(&self, owner: &Writer) -> Result<()> {
        self.check_live()?;
        if owner.id() != self.stream_id() {
            return Err(Error::Position);
        }
        Ok(())
    }
    pub fn root(&self) -> usize {
        self.root
    }
    pub fn node(&self, index: usize) -> Result<Node> {
        self.check_live()?;
        self.nodes.get(index).copied().ok_or(Error::Position)
    }
    pub(crate) fn published(&self, index: usize) -> Result<bool> {
        Ok(self.node(index)?.published)
    }
    pub(crate) fn mark_published(&mut self, index: usize) {
        self.nodes[index].published = true;
    }

    pub(crate) fn release_input_before(&mut self, offset: u64) -> Result<()> {
        self.sources[0].release_before(offset)
    }
    pub(crate) fn release_input_range(&mut self, span: Span) -> Result<()> {
        self.sources[0].release_range(span)
    }

    pub(crate) fn rebind_keys(&mut self, scanner: &mut json::Scanner) -> Result<()> {
        for index in 0..self.nodes.len() {
            let node = self.nodes[index];
            if let (Some(span), Some(name)) = (node.input_key, node.name) {
                if !scanner.needs_key(span) {
                    self.nodes[index].input_key = None;
                    continue;
                }
                if matches!(name, Name::Mapped(Text { source: 0, .. })) {
                    continue;
                }
                if self.names_equal(Name::Mapped(Text { source: 0, span }), name)? {
                    scanner.bind_key(span, name);
                    self.nodes[index].input_key = None;
                }
            }
        }
        Ok(())
    }

    pub(crate) fn raw_floor(&self, index: usize, mut floor: u64) -> Result<u64> {
        let node = self.node(index)?;
        if let Some(Name::Mapped(Text { source: 0, span })) = node.name {
            floor = floor.min(span.start);
        }
        if let Value::String(Text { source: 0, span }) | Value::Number(Text { source: 0, span }) = node.value {
            floor = floor.min(span.start);
        }
        for child in self.children(index)? {
            floor = self.raw_floor(child, floor)?;
        }
        Ok(floor)
    }
    pub fn source(&self, text: Text) -> Result<&Source> {
        self.sources.get(text.source).ok_or(Error::Position)
    }
    pub fn children(&self, parent: usize) -> Result<Children<'_>> {
        Ok(Children {
            doc: self,
            next: self.node(parent)?.first,
        })
    }
    pub fn name_is(&self, name: Name, value: &str) -> Result<bool> {
        let mut chars = self.name_chars(name)?;
        for expected in value.chars() {
            if chars.next_scalar()? != Some(expected) {
                return Ok(false);
            }
        }
        Ok(chars.next_scalar()?.is_none())
    }
    pub fn name_chars(&self, name: Name) -> Result<Characters<'_>> {
        match name {
            Name::Static(s) => Ok(Characters::Static(s.chars())),
            Name::Mapped(t) => Ok(Characters::Mapped(json::Decoded::new(self.source(t)?, t.span)?)),
            Name::Pointer(t) => {
                let mut chars = json::Decoded::new(self.source(t)?, t.span)?;
                let mut skip = 0;
                let mut length = 0;
                while let Some(c) = chars.next_scalar()? {
                    length += 1;
                    if c == '/' {
                        skip = length;
                    }
                }
                let mut chars = json::Decoded::new(self.source(t)?, t.span)?;
                for _ in 0..skip {
                    chars.next_scalar()?;
                }
                Ok(Characters::Pointer(chars))
            }
        }
    }

    pub(crate) fn bind_field(&mut self, node: usize, mut event: Document) -> Result<()> {
        let pointer = event.required(event.root(), "pointer")?;
        let value = event.required(event.root(), "value")?;
        let Value::String(mut pointer) = event.node(pointer)?.value else {
            return Err(Error::Schema);
        };
        let mut value = event.node(value)?.value;
        let base = self.adopt_sources(&mut event)?;
        pointer.source += base;
        if let Value::String(text) | Value::Number(text) = &mut value {
            text.source += base;
        }
        if self.nodes[node].name.is_some() {
            self.nodes[node].name = Some(Name::Pointer(pointer));
        }
        if !matches!(value, Value::Object | Value::Array) {
            self.nodes[node].value = value;
        }
        Ok(())
    }

    pub(crate) fn retain_text(&mut self, mut event: Document, mut text: Text) -> Result<Text> {
        text.source += self.adopt_sources(&mut event)?;
        Ok(text)
    }

    fn adopt_sources(&mut self, event: &mut Document) -> Result<usize> {
        if self.stream_id() != event.stream_id() {
            return Err(Error::Position);
        }
        self.reserve(0, event.sources.len())?;
        let base = self.sources.len();
        self.sources.append(&mut event.sources);
        Ok(base)
    }

    pub(crate) fn retire_scratch(&mut self) -> Result<()> {
        for source in &mut self.sources {
            source.retire_scratch()?;
        }
        Ok(())
    }
    pub fn member(&self, parent: usize, name: &str) -> Result<Option<usize>> {
        if !matches!(self.node(parent)?.value, Value::Object) {
            return Err(Error::Schema);
        }
        for child in self.children(parent)? {
            if self.name_is(self.node(child)?.name.ok_or(Error::Schema)?, name)? {
                return Ok(Some(child));
            }
        }
        Ok(None)
    }
    pub fn required(&self, parent: usize, name: &str) -> Result<usize> {
        self.member(parent, name)?.ok_or(Error::Schema)
    }
    pub fn string_is(&self, index: usize, value: &str) -> Result<bool> {
        let mut chars = self.chars(index)?;
        for expected in value.chars() {
            if chars.next_scalar()? != Some(expected) {
                return Ok(false);
            }
        }
        Ok(chars.next_scalar()?.is_none())
    }
    pub fn chars(&self, index: usize) -> Result<Characters<'_>> {
        self.check_live()?;
        match &self.nodes.get(index).ok_or(Error::Position)?.value {
            Value::String(t) => Ok(Characters::Mapped(json::Decoded::new(self.source(*t)?, t.span)?)),
            Value::Text(s) => Ok(Characters::Static(s.chars())),
            Value::Id(id) => Ok(Characters::Static(id.as_str().chars())),
            Value::Utf8Media => Ok(Characters::Encoded(EncodedCharacters {
                doc: self,
                next: self.nodes[index].first,
                decoded: None,
                bytes: [0; 3],
                used: 0,
                length: 0,
            })),
            _ => Err(Error::Schema),
        }
    }
    pub fn equal_strings(&self, left: usize, right: usize) -> Result<bool> {
        let mut left = self.chars(left)?;
        let mut right = self.chars(right)?;
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
    pub fn unsigned(&self, index: usize) -> Result<u64> {
        match self.node(index)?.value {
            Value::Unsigned(n) => Ok(n),
            Value::Number(t) => {
                let mut cursor = self.source(t)?.cursor(t.span)?;
                let mut value = 0u64;
                let mut any = false;
                while let Some(b) = cursor.next_byte()? {
                    if !b.is_ascii_digit() {
                        return Err(Error::Schema);
                    }
                    value = value
                        .checked_mul(10)
                        .and_then(|v| v.checked_add(u64::from(b - b'0')))
                        .ok_or(Error::Schema)?;
                    any = true;
                }
                if any { Ok(value) } else { Err(Error::Schema) }
            }
            _ => Err(Error::Schema),
        }
    }
    /// Bind trusted provenance to a stable node, independently of its array position.
    /// JSON imports never create these associations; absorb remaps their node indexes.
    pub fn bind_origin(&mut self, entry: usize, parent: usize, carrier: Option<&'static str>) -> Result<()> {
        self.node(parent)?;
        let old = self.node(entry)?.origin;
        if old == Some((parent, carrier)) {
            return Ok(());
        }
        if let Some((old_parent, _)) = old {
            let mut at = self.nodes[old_parent].origins;
            let mut previous: Option<usize> = None;
            while let Some(index) = at {
                let next = self.nodes[index].origin_next;
                if index == entry {
                    if let Some(previous) = previous {
                        self.nodes[previous].origin_next = next;
                    } else {
                        self.nodes[old_parent].origins = next;
                    }
                    if self.nodes[old_parent].last_origin == Some(entry) {
                        self.nodes[old_parent].last_origin = previous;
                    }
                    break;
                }
                previous = Some(index);
                at = next;
            }
        }
        self.nodes[entry].origin = Some((parent, carrier));
        self.nodes[entry].origin_next = None;
        if let Some(last) = self.nodes[parent].last_origin {
            self.nodes[last].origin_next = Some(entry);
        } else {
            self.nodes[parent].origins = Some(entry);
        }
        self.nodes[parent].last_origin = Some(entry);
        Ok(())
    }

    pub fn origin(&self, entry: usize) -> Result<Option<(usize, Option<&'static str>)>> {
        Ok(self.node(entry)?.origin)
    }

    pub(crate) fn origins(&self, parent: usize) -> Result<Origins<'_>> {
        Ok(Origins {
            doc: self,
            next: self.node(parent)?.origins,
        })
    }

    pub(crate) fn clone_tree(&mut self, node: usize) -> Result<usize> {
        let source = self.node(node)?;
        let target = self.add(source.name, source.value)?;
        let mut child = source.first;
        while let Some(index) = child {
            child = self.node(index)?.next;
            let copy = self.clone_tree(index)?;
            self.append(target, copy)?;
        }
        Ok(target)
    }

    pub fn add(&mut self, name: Option<Name>, value: Value) -> Result<usize> {
        self.reserve(1, 0)?;
        let index = self.nodes.len();
        self.nodes.push(Node {
            name,
            value,
            first: None,
            next: None,
            last: None,
            parent: None,
            revision: 0,
            origin: None,
            origin_next: None,
            origins: None,
            last_origin: None,
            published: false,
            input_key: match name {
                Some(Name::Mapped(Text { source: 0, span })) => Some(span),
                _ => None,
            },
        });
        Ok(index)
    }
    pub fn append(&mut self, parent: usize, child: usize) -> Result<()> {
        if !matches!(
            self.node(parent)?.value,
            Value::Object | Value::Array | Value::Fragments | Value::Base64Fragments | Value::Utf8Media
        ) || self.node(child)?.next.is_some()
            || self.node(child)?.parent.is_some()
        {
            return Err(Error::Schema);
        }
        if let Some(last) = self.nodes[parent].last {
            self.nodes[last].next = Some(child);
        } else {
            self.nodes[parent].first = Some(child);
        }
        self.nodes[parent].last = Some(child);
        self.nodes[child].parent = Some(parent);
        self.nodes[child].revision = self.nodes[child].revision.checked_add(1).ok_or(Error::Limit)?;
        Ok(())
    }
    pub fn detach(&mut self, parent: usize, child: usize) -> Result<()> {
        self.check_live()?;
        let mut at = self.node(parent)?.first;
        let mut previous: Option<usize> = None;
        while let Some(i) = at {
            if i == child {
                let next = self.nodes[i].next;
                if let Some(p) = previous {
                    self.nodes[p].next = next;
                } else {
                    self.nodes[parent].first = next;
                }
                self.nodes[i].next = None;
                if self.nodes[parent].last == Some(i) {
                    self.nodes[parent].last = previous;
                }
                self.nodes[i].parent = None;
                self.nodes[i].revision = self.nodes[i].revision.checked_add(1).ok_or(Error::Limit)?;
                return Ok(());
            }
            previous = Some(i);
            at = self.nodes[i].next;
        }
        Err(Error::Position)
    }
    pub fn remove(&mut self, parent: usize, name: &str) -> Result<Option<usize>> {
        let child = self.member(parent, name)?;
        if let Some(child) = child {
            self.detach(parent, child)?;
        }
        Ok(child)
    }
    pub fn rename(&mut self, index: usize, name: &'static str) -> Result<()> {
        self.check_live()?;
        let node = self.nodes.get_mut(index).ok_or(Error::Position)?;
        node.name = Some(Name::Static(name));
        node.revision = node.revision.checked_add(1).ok_or(Error::Limit)?;
        Ok(())
    }
    pub fn replace(&mut self, index: usize, value: Value) -> Result<()> {
        self.check_live()?;
        let n = self.nodes.get_mut(index).ok_or(Error::Position)?;
        n.value = value;
        n.first = None;
        n.last = None;
        n.revision = n.revision.checked_add(1).ok_or(Error::Limit)?;
        Ok(())
    }
    pub fn set(&mut self, parent: usize, name: &'static str, value: Value) -> Result<usize> {
        if let Some(i) = self.member(parent, name)? {
            self.replace(i, value)?;
            Ok(i)
        } else {
            let i = self.add(Some(Name::Static(name)), value)?;
            self.append(parent, i)?;
            Ok(i)
        }
    }
    pub fn transplant(&mut self, target: usize, from: usize) -> Result<()> {
        let value = self.node(from)?;
        let node = self.nodes.get_mut(target).ok_or(Error::Position)?;
        node.value = value.value;
        node.first = value.first;
        node.last = value.last;
        node.revision = node.revision.checked_add(1).ok_or(Error::Limit)?;
        let mut child = value.first;
        while let Some(i) = child {
            self.nodes[i].parent = Some(target);
            self.nodes[i].revision = self.nodes[i].revision.checked_add(1).ok_or(Error::Limit)?;
            child = self.nodes[i].next;
        }
        Ok(())
    }
    pub fn write_name(&self, name: Name, e: &mut Encoder<'_, '_>) -> Result<()> {
        e.bytes(b"\"")?;
        let mut chars = self.name_chars(name)?;
        while let Some(c) = chars.next_scalar()? {
            e.escaped(c.encode_utf8(&mut [0; 4]))?;
        }
        e.bytes(b"\"")
    }
    pub fn write(&self, index: usize, e: &mut Encoder<'_, '_>) -> Result<()> {
        let n = self.node(index)?;
        match n.value {
            Value::Object | Value::Array => {
                let object = matches!(n.value, Value::Object);
                e.bytes(if object { b"{" } else { b"[" })?;
                let mut first = true;
                for child in self.children(index)? {
                    if !first {
                        e.bytes(b",")?;
                    }
                    first = false;
                    if object {
                        self.write_name(self.node(child)?.name.ok_or(Error::Schema)?, e)?;
                        e.bytes(b":")?;
                    }
                    self.write(child, e)?;
                }
                e.bytes(if object { b"}" } else { b"]" })
            }
            Value::Fragments | Value::Base64Fragments | Value::Utf8Media => {
                e.bytes(b"\"")?;
                self.write_contents(index, e)?;
                e.bytes(b"\"")
            }
            Value::String(t) | Value::Number(t) => e.span(self.source(t)?, t.span),
            Value::Text(s) => e.string(s),
            Value::Unsigned(n) => e.unsigned(n),
            Value::Id(id) => e.string(id.as_str()),
            Value::Bool(b) => e.bytes(if b { b"true" } else { b"false" }),
            Value::Null => e.bytes(b"null"),
        }
    }
    pub fn write_contents(&self, index: usize, e: &mut Encoder<'_, '_>) -> Result<()> {
        match self.node(index)?.value {
            Value::String(t) => e.string_fragment(self.source(t)?, t.span),
            Value::Text(s) => e.escaped(s),
            Value::Utf8Media => {
                let mut chars = self.chars(index)?;
                while let Some(c) = chars.next_scalar()? {
                    e.escaped(c.encode_utf8(&mut [0; 4]))?;
                }
                Ok(())
            }
            Value::Base64Fragments => super::media::write_base64_fragments(self, index, e),
            Value::Fragments => {
                for child in self.children(index)? {
                    self.write_contents(child, e)?;
                }
                Ok(())
            }
            _ => Err(Error::Schema),
        }
    }
}

pub struct Children<'a> {
    doc: &'a Document,
    next: Option<usize>,
}
impl Iterator for Children<'_> {
    type Item = usize;
    fn next(&mut self) -> Option<usize> {
        let i = self.next?;
        self.next = self.doc.nodes[i].next;
        Some(i)
    }
}

pub(crate) struct Origins<'a> {
    doc: &'a Document,
    next: Option<usize>,
}
impl Iterator for Origins<'_> {
    type Item = usize;
    fn next(&mut self) -> Option<usize> {
        let index = self.next?;
        self.next = self.doc.nodes[index].origin_next;
        Some(index)
    }
}

#[derive(Clone)]
pub enum Characters<'a> {
    Mapped(json::Decoded<'a>),
    Pointer(json::Decoded<'a>),
    Static(std::str::Chars<'a>),
    Encoded(EncodedCharacters<'a>),
}
impl Characters<'_> {
    pub fn next_scalar(&mut self) -> Result<Option<char>> {
        match self {
            Self::Mapped(d) => d.next_scalar(),
            Self::Static(s) => Ok(s.next()),
            Self::Encoded(s) => s.next_scalar(),
            Self::Pointer(d) => match d.next_scalar()? {
                Some('~') => match d.next_scalar()? {
                    Some('0') => Ok(Some('~')),
                    Some('1') => Ok(Some('/')),
                    _ => Err(Error::Schema),
                },
                value => Ok(value),
            },
        }
    }
}

#[derive(Clone)]
pub struct EncodedCharacters<'a> {
    doc: &'a Document,
    next: Option<usize>,
    decoded: Option<json::Decoded<'a>>,
    bytes: [u8; 3],
    used: usize,
    length: usize,
}

impl EncodedCharacters<'_> {
    fn next_byte(&mut self) -> Result<Option<u8>> {
        use base64::Engine;
        loop {
            if self.used < self.length {
                let byte = self.bytes[self.used];
                self.used += 1;
                return Ok(Some(byte));
            }
            if let Some(decoded) = &mut self.decoded {
                let mut quartet = [0; 4];
                if let Some(c) = decoded.next_scalar()? {
                    if !c.is_ascii() {
                        return Err(Error::Schema);
                    }
                    quartet[0] = c as u8;
                    for slot in &mut quartet[1..] {
                        let c = decoded.next_scalar()?.ok_or(Error::Schema)?;
                        if !c.is_ascii() {
                            return Err(Error::Schema);
                        }
                        *slot = c as u8;
                    }
                    self.length = base64::engine::general_purpose::STANDARD
                        .decode_slice(quartet, &mut self.bytes)
                        .map_err(|_| Error::Schema)?;
                    self.used = 0;
                    continue;
                }
            }
            let Some(node) = self.next else {
                return Ok(None);
            };
            let node = self.doc.node(node)?;
            self.next = node.next;
            let Value::String(text) = node.value else {
                return Err(Error::Schema);
            };
            self.decoded = Some(json::Decoded::new(self.doc.source(text)?, text.span)?);
        }
    }

    fn next_scalar(&mut self) -> Result<Option<char>> {
        let Some(byte) = self.next_byte()? else {
            return Ok(None);
        };
        let length = match byte {
            0..=0x7f => return Ok(Some(byte as char)),
            0xc2..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf4 => 4,
            _ => return Err(Error::Utf8),
        };
        let mut bytes = [0; 4];
        bytes[0] = byte;
        for slot in &mut bytes[1..length] {
            *slot = self.next_byte()?.ok_or(Error::Utf8)?;
        }
        Ok(Some(
            std::str::from_utf8(&bytes[..length])
                .map_err(|_| Error::Utf8)?
                .chars()
                .next()
                .ok_or(Error::Utf8)?,
        ))
    }
}
