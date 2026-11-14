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
    pub data: Text,
    pub encoding: Encoding,
    pub kind: &'static str,
    pub mime: Option<usize>,
}

struct Entry {
    media: Media,
    lineage: [Option<(usize, u64)>; 128],
    chunks: Option<super::table::Table<Text>>,
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
        let Some(entry) = self.entries.iter().find(|entry| entry.media.node == node) else {
            return Ok(None);
        };
        if lineage(doc, node)? != entry.lineage {
            return Err(Error::Position);
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
            data,
            encoding,
            kind,
            mime,
        };
        doc.replace(node, Value::Object)?;
        doc.set(node, "type", Value::Text("x_ck_media"))?;
        doc.set(node, "media_id", Value::Id(id))?;
        doc.set(
            node,
            "value_kind",
            Value::Text(match encoding {
                Encoding::Base64 | Encoding::DataUri { .. } => "bytes",
                Encoding::Utf8 => "utf8",
            }),
        )?;
        self.entries.push(Entry {
            media,
            lineage: lineage(doc, node)?,
            chunks: None,
        });
        Ok(media)
    }
    pub fn entries(&self) -> impl Iterator<Item = Media> + '_ {
        self.entries.iter().map(|entry| entry.media)
    }
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }
    pub(crate) fn at(&self, index: usize) -> Media {
        self.entries[index].media
    }

    pub(crate) fn retain(
        &mut self,
        doc: &mut Document,
        index: usize,
        owner: &mut Writer,
        reader: &mut ck_stream::Reader,
    ) -> Result<()> {
        let mut chunks = super::table::Table::new(owner)?;
        let (kind, _) = super::internal::next(owner, reader)?;
        if kind != Kind::MediaStart {
            return Err(Error::Schema);
        }
        loop {
            let (kind, event) = super::internal::next(owner, reader)?;
            if kind == Kind::MediaEnd {
                break;
            }
            if kind != Kind::Data {
                return Err(Error::Schema);
            }
            let node = event.required(event.root(), "bytes")?;
            let Value::String(text) = event.node(node)?.value else {
                return Err(Error::Schema);
            };
            chunks.push(doc.retain_text(event, text)?)?;
        }
        self.entries[index].chunks = Some(chunks);
        Ok(())
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
            for text in chunks.iter() {
                e.string_fragment(doc.source(*text)?, text.span)?;
            }
            e.bytes(b"\"")
        } else {
            e.span(doc.source(entry.media.data)?, entry.media.data.span)
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
    let mut decoded = Decoded::new(doc.source(media.data)?, media.data.span)?;
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
    emitter.emit(
        owner,
        Kind::MediaStart,
        scope,
        |e| {
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
        },
        |_| Ok(()),
    )?;
    let mut chunk = [0u8; 36_864];
    let mut len = 0;
    let mut index = 0;
    let mut offset = 0;
    let mut ceiling = emitter.data_capacity(scope, index, offset)?;
    let mut flush = |chunk: &[u8]| -> Result<usize> {
        use base64::Engine;
        let mut encoded = [0u8; 49_152];
        let count = base64::engine::general_purpose::STANDARD
            .encode_slice(chunk, &mut encoded)
            .map_err(|_| Error::Schema)?;
        emitter.emit(
            owner,
            Kind::Data,
            scope,
            |e| {
                e.bytes(b",\"index\":")?;
                e.unsigned(index)?;
                e.bytes(b",\"offset\":")?;
                e.unsigned(offset)?;
                e.bytes(b",\"bytes\":\"")?;
                e.bytes(&encoded[..count])?;
                e.bytes(b"\"")
            },
            |_| Ok(()),
        )?;
        index += 1;
        offset += chunk.len() as u64;
        emitter.data_capacity(scope, index, offset)
    };
    let mut collect = |bytes: &[u8]| {
        for &byte in bytes {
            chunk[len] = byte;
            len += 1;
            if len == ceiling {
                ceiling = flush(&chunk[..len])?;
                len = 0;
            }
        }
        Ok(())
    };
    if let Some(fragment) = fragment {
        fragment.push(doc, media.data, &mut collect)?;
    } else {
        bytes(doc, media, &mut collect)?;
    }
    if len != 0 {
        flush(&chunk[..len])?;
    }
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
    emitter.emit(
        owner,
        Kind::MediaEnd,
        scope,
        |e| {
            e.bytes(b",\"bytes\":")?;
            e.unsigned(offset)?;
            e.bytes(b",\"status\":\"completed\"")
        },
        |_| Ok(()),
    )?;
    Ok(())
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
    use base64::Engine;
    let mut carry = [0; 3];
    let mut used = 0;
    for child in doc.children(node)? {
        let Value::String(text) = doc.node(child)?.value else {
            return Err(Error::Schema);
        };
        decode_base64(doc, text, |bytes| {
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

#[derive(Default)]
pub(crate) struct Base64Fragments {
    quartet: [u8; 4],
    count: usize,
}

impl Base64Fragments {
    pub(crate) fn complete(&self) -> bool {
        self.count == 0
    }

    fn push(&mut self, doc: &Document, text: Text, mut emit: impl FnMut(&[u8]) -> Result<()>) -> Result<()> {
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
