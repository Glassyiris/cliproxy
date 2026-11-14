use super::{
    Error, Result,
    document::{Document, Text, Value},
    encode::Encoder,
    event::{Emitter, Kind, LocalId, Scope},
    json::Decoded,
};
use ck_stream::{MetadataPermit, Writer};

#[derive(Clone, Copy)]
pub enum Encoding {
    Base64,
    DataUri { skip: u64 },
    Utf8,
}

#[derive(Clone, Copy)]
pub struct Media {
    pub node: usize,
    pub id: LocalId,
    pub data: Option<Text>,
    pub encoding: Encoding,
    pub kind: &'static str,
    pub mime: Option<usize>,
}

struct Entry {
    media: Media,
    lineage: [Option<(usize, u64)>; 128],
    chunks: Option<super::table::Table<Text>>,
    active: bool,
}

pub struct Registry {
    entries: Vec<Entry>,
    metadata: MetadataPermit,
    document: Option<u64>,
}

impl Registry {
    pub fn new(owner: &mut Writer) -> Result<Self> {
        Ok(Self {
            entries: Vec::new(),
            metadata: owner.reserve_metadata(0)?,
            document: None,
        })
    }

    pub fn validate_document(&self, doc: &Document) -> Result<()> {
        self.metadata.check_live()?;
        if doc.stream_id() != self.metadata.stream_id() || self.document.is_some_and(|id| id != doc.id()) {
            return Err(Error::Position);
        }
        Ok(())
    }
    pub fn get(&self, doc: &Document, node: usize) -> Result<Option<Media>> {
        self.validate_document(doc)?;
        let Some(entry) = self
            .entries
            .iter()
            .find(|entry| entry.active && entry.media.node == node)
        else {
            return Ok(None);
        };
        if lineage(doc, node)? != entry.lineage {
            return Err(Error::Position);
        }
        if matches!(entry.media.encoding, Encoding::Utf8) && matches!(doc.node(node)?.value, Value::Utf8Media) {
            return Ok(Some(entry.media));
        }
        let kind = doc.required(node, "type")?;
        let id = doc.required(node, "media_id")?;
        if !doc.string_is(kind, "x_ck_media")? || !doc.string_is(id, entry.media.id.as_str())? {
            return Err(Error::Position);
        }
        Ok(Some(entry.media))
    }
    pub fn register(
        &mut self,
        doc: &mut Document,
        node: usize,
        data: Text,
        encoding: Encoding,
        kind: &'static str,
        mime: Option<usize>,
    ) -> Result<Media> {
        self.validate_document(doc)?;
        self.document = Some(doc.id());
        if self.entries.len() == self.entries.capacity() {
            let capacity = self.entries.capacity().max(4).checked_mul(2).ok_or(Error::Limit)?;
            self.metadata.resize(capacity * std::mem::size_of::<Entry>())?;
            self.entries
                .try_reserve_exact(capacity - self.entries.len())
                .map_err(|_| Error::Limit)?;
            self.metadata
                .resize(self.entries.capacity() * std::mem::size_of::<Entry>())?;
        }
        let id = local_id(b'm', self.entries.len() as u64)?;
        let media = Media {
            node,
            id,
            data: Some(data),
            encoding,
            kind,
            mime,
        };
        if matches!(encoding, Encoding::Utf8) {
            doc.replace(node, Value::Utf8Media)?;
        } else {
            doc.replace(node, Value::Object)?;
            doc.set(node, "type", Value::Text("x_ck_media"))?;
            doc.set(node, "media_id", Value::Id(id))?;
            doc.set(node, "value_kind", Value::Text("bytes"))?;
        }
        self.entries.push(Entry {
            media,
            lineage: lineage(doc, node)?,
            chunks: None,
            active: true,
        });
        Ok(media)
    }
    pub fn entries(&self) -> impl Iterator<Item = Media> + '_ {
        self.entries
            .iter()
            .filter(|entry| entry.active)
            .map(|entry| entry.media)
    }
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }
    pub(crate) fn at(&self, index: usize) -> Media {
        self.entries[index].media
    }

    pub(crate) fn validate_registrations(&self, doc: &Document) -> Result<()> {
        for media in self.entries() {
            if lineage(doc, media.node)?
                .iter()
                .flatten()
                .any(|(node, _)| *node == doc.root())
            {
                self.get(doc, media.node)?.ok_or(Error::Position)?;
            }
        }
        Ok(())
    }

    /// Only ingress normalization may relocate bindings; ordinary get never refreshes lineage.
    pub(crate) fn relocate_ingress(&mut self, doc: &Document) -> Result<()> {
        self.validate_document(doc)?;
        for entry in &mut self.entries {
            if !entry.active {
                continue;
            }
            if matches!(entry.media.encoding, Encoding::Utf8)
                && !matches!(doc.node(entry.media.node)?.value, Value::Utf8Media)
            {
                entry.active = false;
            } else {
                entry.lineage = lineage(doc, entry.media.node)?;
            }
        }
        Ok(())
    }

    pub(crate) fn update_mime(&mut self, node: usize, mime: Option<usize>) {
        if let Some(entry) = self
            .entries
            .iter_mut()
            .find(|entry| entry.active && entry.media.node == node)
        {
            entry.media.mime = mime;
        }
    }

    pub(crate) fn retain(
        &mut self,
        doc: &mut Document,
        index: usize,
        owner: &mut Writer,
        reader: &mut ck_stream::Reader,
    ) -> Result<()> {
        if self.retain_record(doc, index, owner, reader)? != Kind::MediaStart {
            return Err(Error::Schema);
        }
        while self.retain_record(doc, index, owner, reader)? != Kind::MediaEnd {}
        Ok(())
    }

    pub(crate) fn retain_record(
        &mut self,
        doc: &mut Document,
        index: usize,
        owner: &mut Writer,
        reader: &mut ck_stream::Reader,
    ) -> Result<Kind> {
        let (kind, event) = super::internal::next(owner, reader)?;
        let entry = &mut self.entries[index];
        match kind {
            Kind::MediaStart => {
                entry.chunks = Some(super::table::Table::new(owner)?);
                entry.media.data = None;
            }
            Kind::Data => {
                let node = event.required(event.root(), "bytes")?;
                let Value::String(text) = event.node(node)?.value else {
                    return Err(Error::Schema);
                };
                let text = doc.retain_text(event, text)?;
                entry.chunks.as_mut().ok_or(Error::Schema)?.push(text)?;
                if matches!(entry.media.encoding, Encoding::Utf8) {
                    let child = doc.add(None, Value::String(text))?;
                    doc.append(entry.media.node, child)?;
                }
            }
            Kind::MediaEnd => (),
            _ => return Err(Error::Schema),
        }
        Ok(kind)
    }

    pub fn write_value(&self, doc: &Document, node: usize, e: &mut Encoder<'_, '_>) -> Result<()> {
        self.get(doc, node)?.ok_or(Error::Position)?;
        let entry = self
            .entries
            .iter()
            .find(|entry| entry.media.node == node)
            .ok_or(Error::Position)?;
        if let Some(chunks) = &entry.chunks {
            if matches!(entry.media.encoding, Encoding::Utf8) {
                return e.quoted_json(|e| {
                    for text in chunks.iter() {
                        decode_base64(doc, *text, |bytes| e.bytes(bytes))?;
                    }
                    Ok(())
                });
            }
            e.bytes(b"\"")?;
            if matches!(entry.media.encoding, Encoding::DataUri { .. }) {
                e.bytes(b"data:")?;
                let mime = entry.media.mime.ok_or(Error::Schema)?;
                doc.write_contents(mime, e)?;
                e.bytes(b";base64,")?;
            }
            write_encoded_chunks(doc, chunks.iter().copied(), e)?;
            e.bytes(b"\"")
        } else {
            let text = entry.media.data.ok_or(Error::Position)?;
            e.span(doc.source(text)?, text.span)
        }
    }
}

fn lineage(doc: &Document, node: usize) -> Result<[Option<(usize, u64)>; 128]> {
    let mut result = [None; 128];
    let mut at = Some(node);
    for slot in &mut result {
        let Some(index) = at else {
            return Ok(result);
        };
        let node = doc.node(index)?;
        *slot = Some((index, node.revision));
        at = node.parent;
    }
    if at.is_some() {
        return Err(Error::Limit);
    }
    Ok(result)
}

pub fn local_id(prefix: u8, mut index: u64) -> Result<LocalId> {
    let mut bytes = [0u8; 21];
    let mut start = bytes.len();
    loop {
        start -= 1;
        bytes[start] = b'0' + (index % 10) as u8;
        index /= 10;
        if index == 0 {
            break;
        }
    }
    start -= 1;
    bytes[start] = prefix;
    LocalId::new(std::str::from_utf8(&bytes[start..]).map_err(|_| Error::Schema)?)
}

/// Decodes at most one scalar/quartet at a time. Only the emitted chunk is staged on the stack.
pub fn bytes(doc: &Document, media: Media, mut emit: impl FnMut(&[u8]) -> Result<()>) -> Result<()> {
    let text = media.data.ok_or(Error::Position)?;
    let mut decoded = Decoded::new(doc.source(text)?, text.span)?;
    if let Encoding::DataUri { skip } = media.encoding {
        for _ in 0..skip {
            decoded.next_scalar()?.ok_or(Error::Schema)?;
        }
    }
    let mut quartet = [0u8; 4];
    let mut count = 0;
    let mut padded = false;
    while let Some(c) = decoded.next_scalar()? {
        match media.encoding {
            Encoding::Utf8 => emit(c.encode_utf8(&mut [0; 4]).as_bytes())?,
            Encoding::Base64 | Encoding::DataUri { .. } => {
                if padded || !c.is_ascii() {
                    return Err(Error::Schema);
                }
                quartet[count] = c as u8;
                count += 1;
                if count == 4 {
                    use base64::Engine;
                    let mut out = [0; 3];
                    let len = base64::engine::general_purpose::STANDARD
                        .decode_slice(quartet, &mut out)
                        .map_err(|_| Error::Schema)?;
                    padded = quartet.contains(&b'=');
                    emit(&out[..len])?;
                    count = 0;
                }
            }
        }
    }
    if count != 0 {
        return Err(Error::Schema);
    }
    Ok(())
}

pub fn publish(doc: &Document, media: Media, emitter: &mut Emitter, owner: &mut Writer, scope: Scope) -> Result<()> {
    publish_with_attributes(doc, media, emitter, owner, (scope, None), None, None)
}

pub(crate) struct Attributes<'a> {
    pub document: &'a Document,
    pub value: usize,
    pub mime: Option<usize>,
}

pub(crate) fn publish_with_attributes(
    doc: &Document,
    media: Media,
    emitter: &mut Emitter,
    owner: &mut Writer,
    (mut scope, fragment): (Scope, Option<&mut Base64Fragments>),
    attributes: Option<Attributes<'_>>,
    transcript: Option<usize>,
) -> Result<()> {
    scope.media_id = Some(media.id);
    let mut publisher = Publisher::start(emitter, owner, scope, |e| {
        e.bytes(b",\"kind\":")?;
        e.string(media.kind)?;
        e.bytes(b",\"encoding\":\"base64\"")?;
        if let Some(attributes) = &attributes {
            if let Some(mime) = attributes.mime {
                e.bytes(b",\"mime\":")?;
                attributes.document.write(mime, e)?;
            }
            e.bytes(b",\"attributes\":")?;
            attributes.document.write(attributes.value, e)?;
        } else if let Some(mime) = media.mime {
            e.bytes(b",\"mime\":")?;
            doc.write(mime, e)?;
        }
        Ok(())
    })?;
    publisher.collect(emitter, owner, |collect| {
        if let Some(fragment) = fragment {
            fragment.push(doc, media.data.ok_or(Error::Position)?, collect)
        } else {
            bytes(doc, media, collect)
        }
    })?;
    if let Some(transcript) = transcript {
        emitter.emit(
            owner,
            Kind::MediaTranscript,
            scope,
            |e| {
                e.bytes(b",\"text\":")?;
                doc.write(transcript, e)?;
                e.bytes(b",\"final\":true")
            },
            |_| Ok(()),
        )?;
    }
    publisher.end(emitter, owner)
}

pub fn write_reference(media: Media, e: &mut Encoder<'_, '_>) -> Result<()> {
    e.bytes(b"{\"type\":\"x_ck_media\",\"media_id\":")?;
    e.string(media.id.as_str())?;
    e.bytes(match media.encoding {
        Encoding::Base64 | Encoding::DataUri { .. } => b",\"value_kind\":\"bytes\"}",
        Encoding::Utf8 => b",\"value_kind\":\"utf8\"}",
    })
}

pub(crate) fn decode_base64(doc: &Document, text: Text, mut emit: impl FnMut(&[u8]) -> Result<()>) -> Result<()> {
    use base64::Engine;
    let mut decoded = Decoded::new(doc.source(text)?, text.span)?;
    let mut quartet = [0; 4];
    let mut count = 0;
    let mut padded = false;
    while let Some(c) = decoded.next_scalar()? {
        if padded || !c.is_ascii() {
            return Err(Error::Schema);
        }
        quartet[count] = c as u8;
        count += 1;
        if count == 4 {
            let mut bytes = [0; 3];
            let len = base64::engine::general_purpose::STANDARD
                .decode_slice(quartet, &mut bytes)
                .map_err(|_| Error::Schema)?;
            padded = quartet.contains(&b'=');
            emit(&bytes[..len])?;
            count = 0;
        }
    }
    if count == 0 { Ok(()) } else { Err(Error::Schema) }
}

pub(crate) fn write_base64_fragments(doc: &Document, node: usize, e: &mut Encoder<'_, '_>) -> Result<()> {
    let texts = doc.children(node)?.map(|child| match doc.node(child)?.value {
        Value::String(text) => Ok(text),
        _ => Err(Error::Schema),
    });
    write_encoded_chunks_checked(doc, texts, e)
}

fn write_encoded_chunks(doc: &Document, texts: impl Iterator<Item = Text>, e: &mut Encoder<'_, '_>) -> Result<()> {
    write_encoded_chunks_checked(doc, texts.map(Ok), e)
}

fn write_encoded_chunks_checked(
    doc: &Document,
    texts: impl Iterator<Item = Result<Text>>,
    e: &mut Encoder<'_, '_>,
) -> Result<()> {
    use base64::Engine;
    let mut carry = [0; 3];
    let mut used = 0;
    for text in texts {
        decode_base64(doc, text?, |bytes| {
            for &byte in bytes {
                carry[used] = byte;
                used += 1;
                if used == 3 {
                    let mut encoded = [0; 4];
                    base64::engine::general_purpose::STANDARD
                        .encode_slice(carry, &mut encoded)
                        .map_err(|_| Error::Schema)?;
                    e.bytes(&encoded)?;
                    used = 0;
                }
            }
            Ok(())
        })?;
    }
    if used != 0 {
        let mut encoded = [0; 4];
        base64::engine::general_purpose::STANDARD
            .encode_slice(&carry[..used], &mut encoded)
            .map_err(|_| Error::Schema)?;
        e.bytes(&encoded)?;
    }
    Ok(())
}

/// One media lifetime; payload is committed immediately, never retained on the heap.
pub(crate) struct Publisher {
    scope: Scope,
    index: u64,
    offset: u64,
    ended: bool,
}

impl Publisher {
    pub(crate) fn begin(doc: &Document, media: Media, emitter: &mut Emitter, owner: &mut Writer) -> Result<Self> {
        let scope = Scope {
            media_id: Some(media.id),
            ..Scope::default()
        };
        Self::start(emitter, owner, scope, |e| {
            e.bytes(b",\"kind\":")?;
            e.string(media.kind)?;
            e.bytes(b",\"encoding\":\"base64\"")?;
            if let Some(mime) = media.mime {
                e.bytes(b",\"mime\":")?;
                doc.write(mime, e)?;
            }
            Ok(())
        })
    }

    pub(crate) fn start(
        emitter: &mut Emitter,
        owner: &mut Writer,
        scope: Scope,
        fields: impl Fn(&mut Encoder<'_, '_>) -> Result<()>,
    ) -> Result<Self> {
        emitter.emit(owner, Kind::MediaStart, scope, fields, |_| Ok(()))?;
        Ok(Self {
            scope,
            index: 0,
            offset: 0,
            ended: false,
        })
    }

    pub(crate) fn append(&mut self, bytes: &[u8], emitter: &mut Emitter, owner: &mut Writer) -> Result<()> {
        use base64::Engine;
        if self.ended {
            return Err(Error::Closed);
        }
        if bytes.is_empty() {
            return Ok(());
        }
        if bytes.len() > emitter.data_capacity(self.scope, self.index, self.offset)? {
            return Err(Error::EventTooLarge);
        }
        let mut encoded = [0; 49_152];
        let count = base64::engine::general_purpose::STANDARD
            .encode_slice(bytes, &mut encoded)
            .map_err(|_| Error::Schema)?;
        emitter.emit(
            owner,
            Kind::Data,
            self.scope,
            |e| {
                e.bytes(b",\"index\":")?;
                e.unsigned(self.index)?;
                e.bytes(b",\"offset\":")?;
                e.unsigned(self.offset)?;
                e.bytes(b",\"bytes\":\"")?;
                e.bytes(&encoded[..count])?;
                e.bytes(b"\"")
            },
            |_| Ok(()),
        )?;
        self.index = self.index.checked_add(1).ok_or(Error::Limit)?;
        self.offset = self.offset.checked_add(bytes.len() as u64).ok_or(Error::Limit)?;
        Ok(())
    }

    pub(crate) fn collect(
        &mut self,
        emitter: &mut Emitter,
        owner: &mut Writer,
        decode: impl FnOnce(&mut dyn FnMut(&[u8]) -> Result<()>) -> Result<()>,
    ) -> Result<()> {
        let mut chunk = [0; 36_864];
        let mut len = 0;
        let mut ceiling = emitter.data_capacity(self.scope, self.index, self.offset)?;
        decode(&mut |bytes| {
            for &byte in bytes {
                chunk[len] = byte;
                len += 1;
                if len == ceiling {
                    self.append(&chunk[..len], emitter, owner)?;
                    len = 0;
                    ceiling = emitter.data_capacity(self.scope, self.index, self.offset)?;
                }
            }
            Ok(())
        })?;
        if len != 0 {
            self.append(&chunk[..len], emitter, owner)?;
        }
        Ok(())
    }
    pub(crate) fn end(&mut self, emitter: &mut Emitter, owner: &mut Writer) -> Result<()> {
        if self.ended {
            return Err(Error::Closed);
        }
        emitter.emit(
            owner,
            Kind::MediaEnd,
            self.scope,
            |e| {
                e.bytes(b",\"bytes\":")?;
                e.unsigned(self.offset)?;
                e.bytes(b",\"status\":\"completed\"")
            },
            |_| Ok(()),
        )?;
        self.ended = true;
        Ok(())
    }
}

pub(crate) enum DataUriPrefix {
    Incomplete,
    Plain,
    Encoded {
        encoding: Encoding,
        mime: ck_stream::ScratchLease,
    },
}

pub(crate) fn data_uri_prefix(
    owner: &mut Writer,
    source: &super::source::Source,
    span: super::source::Span,
) -> Result<DataUriPrefix> {
    let mut chars = Decoded::fragment(source, span)?;
    for expected in "data:".chars() {
        let Some(c) = chars.next_scalar()? else {
            return Ok(DataUriPrefix::Incomplete);
        };
        if !c.eq_ignore_ascii_case(&expected) {
            return Ok(DataUriPrefix::Plain);
        }
    }
    let mut count = 0u64;
    let mut suffix = ['\0'; 7];
    loop {
        let Some(c) = chars.next_scalar()? else {
            return Ok(DataUriPrefix::Incomplete);
        };
        if c == ',' {
            break;
        }
        if !c.is_ascii() || c.is_ascii_control() {
            return Err(Error::Schema);
        }
        suffix.rotate_left(1);
        suffix[6] = c;
        count = count.checked_add(1).ok_or(Error::Limit)?;
    }
    if suffix != [';', 'b', 'a', 's', 'e', '6', '4'] {
        return Err(Error::Unsupported);
    }
    let mime_chars = count.checked_sub(7).ok_or(Error::Schema)?;
    let mime = super::encode::scratch(owner, |e| {
        let mut chars = Decoded::fragment(source, span)?;
        for _ in 0..5 {
            chars.next_scalar()?;
        }
        e.bytes(b"\"")?;
        for _ in 0..mime_chars {
            e.escaped(chars.next_scalar()?.ok_or(Error::Schema)?.encode_utf8(&mut [0; 4]))?;
        }
        e.bytes(b"\"")
    })?;
    Ok(DataUriPrefix::Encoded {
        encoding: Encoding::DataUri { skip: count + 6 },
        mime,
    })
}

pub(crate) struct InputDecoder {
    encoding: Encoding,
    skip: u64,
    quartet: [u8; 4],
    count: usize,
    padded: bool,
}
impl InputDecoder {
    pub(crate) fn new(encoding: Encoding) -> Self {
        Self {
            encoding,
            skip: match encoding {
                Encoding::DataUri { skip } => skip,
                _ => 0,
            },
            quartet: [0; 4],
            count: 0,
            padded: false,
        }
    }
    pub(crate) fn complete(&self) -> bool {
        self.skip == 0 && self.count == 0
    }
    pub(crate) fn push(&mut self, c: char, mut emit: impl FnMut(&[u8]) -> Result<()>) -> Result<()> {
        use base64::Engine;
        if self.skip != 0 {
            self.skip -= 1;
            return Ok(());
        }
        if matches!(self.encoding, Encoding::Utf8) {
            return emit(c.encode_utf8(&mut [0; 4]).as_bytes());
        }
        if self.padded || !c.is_ascii() {
            return Err(Error::Schema);
        }
        self.quartet[self.count] = c as u8;
        self.count += 1;
        if self.count == 4 {
            let mut bytes = [0; 3];
            let len = base64::engine::general_purpose::STANDARD
                .decode_slice(self.quartet, &mut bytes)
                .map_err(|_| Error::Schema)?;
            self.padded = self.quartet.contains(&b'=');
            self.count = 0;
            emit(&bytes[..len])?;
        }
        Ok(())
    }
}

#[derive(Default)]
pub(crate) struct Base64Fragments {
    quartet: [u8; 4],
    count: usize,
}

impl Base64Fragments {
    pub(crate) fn complete(&self) -> bool {
        self.count == 0
    }

    pub(crate) fn validate_snapshot(&self, doc: &Document, data: usize, published: u64) -> Result<()> {
        use base64::Engine;
        if self.complete() {
            return Ok(());
        }
        let mut bytes = doc.decoded_bytes(data)?;
        for _ in 0..published {
            bytes.next_byte()?.ok_or(Error::Schema)?;
        }
        let mut block = [0; 3];
        let mut len = 0;
        for slot in &mut block {
            let Some(byte) = bytes.next_byte()? else { break };
            *slot = byte;
            len += 1;
        }
        let mut encoded = [0; 4];
        let length = base64::engine::general_purpose::STANDARD
            .encode_slice(&block[..len], &mut encoded)
            .map_err(|_| Error::Schema)?;
        if length < self.count || encoded[..self.count] != self.quartet[..self.count] {
            return Err(Error::Schema);
        }
        Ok(())
    }

    pub(crate) fn push(&mut self, doc: &Document, text: Text, mut emit: impl FnMut(&[u8]) -> Result<()>) -> Result<()> {
        use base64::Engine;
        let mut decoded = Decoded::new(doc.source(text)?, text.span)?;
        let mut padded = false;
        while let Some(c) = decoded.next_scalar()? {
            if padded || !c.is_ascii() {
                return Err(Error::Schema);
            }
            self.quartet[self.count] = c as u8;
            self.count += 1;
            if self.count == 4 {
                let mut bytes = [0; 3];
                let len = base64::engine::general_purpose::STANDARD
                    .decode_slice(self.quartet, &mut bytes)
                    .map_err(|_| Error::Schema)?;
                padded = self.quartet.contains(&b'=');
                self.count = 0;
                emit(&bytes[..len])?;
            }
        }
        Ok(())
    }
}
