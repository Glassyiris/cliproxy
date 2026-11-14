use super::*;
use crate::codec::{event::LocalId, media};

pub(super) struct Projection {
    pub(super) id: LocalId,
    document: Option<Document>,
    value: usize,
    data: usize,
    field: &'static str,
    choice: u64,
    next: u64,
    offset: u64,
}

pub(super) fn id(doc: &Document, x: usize) -> Result<LocalId> {
    let mut chars = doc.chars(doc.required(x, "media_id")?)?;
    let mut bytes = [0; 64];
    let mut len = 0;
    while let Some(c) = chars.next_scalar()? {
        if !c.is_ascii() || len == bytes.len() {
            return Err(Error::Schema);
        }
        bytes[len] = c as u8;
        len += 1;
    }
    LocalId::new(std::str::from_utf8(&bytes[..len]).map_err(|_| Error::Schema)?)
}

impl Projection {
    pub(super) fn is_open(&self) -> bool {
        self.document.is_some()
    }
    pub(super) fn start(owner: &mut Writer, mut doc: Document, x: usize) -> Result<Self> {
        let id = id(&doc, x)?;
        let choice = doc.unsigned(doc.required(x, "choice_index")?)?;
        let attributes = doc.required(doc.root(), "attributes")?;
        let name = doc.required(attributes, "field")?;
        let field = if doc.string_is(name, "audio")? {
            "audio"
        } else if doc.string_is(name, "images")? {
            "images"
        } else if doc.string_is(name, "content")? {
            "content"
        } else {
            return Err(Error::Unsupported);
        };
        let value = doc.required(attributes, "value")?;
        let data = if field == "audio" {
            doc.required(value, "data")?
        } else {
            doc.required(doc.required(value, "image_url")?, "url")?
        };
        if !matches!(doc.node(data)?.value, Value::Null) {
            return Err(Error::Schema);
        }
        let binary = if field == "audio" {
            doc.replace(data, Value::Base64Fragments)?;
            data
        } else {
            let mime = doc.required(doc.root(), "mime")?;
            let prefix = encode::scratch(owner, |e| {
                e.bytes(b"\"data:")?;
                doc.write_contents(mime, e)?;
                e.bytes(b";base64,\"")
            })?;
            let prefix = doc.import_json(owner, prefix)?;
            doc.replace(data, Value::Fragments)?;
            doc.append(data, prefix)?;
            let binary = doc.add(None, Value::Base64Fragments)?;
            doc.append(data, binary)?;
            binary
        };
        Ok(Self {
            id,
            document: Some(doc),
            value,
            data: binary,
            field,
            choice,
            next: 0,
            offset: 0,
        })
    }

    pub(super) fn data(&mut self, mut incoming: Document) -> Result<()> {
        let root = incoming.root();
        if incoming.unsigned(incoming.required(root, "index")?)? != self.next
            || incoming.unsigned(incoming.required(root, "offset")?)? != self.offset
        {
            return Err(Error::Schema);
        }
        let bytes = incoming.remove(root, "bytes")?.ok_or(Error::Schema)?;
        let Value::String(text) = incoming.node(bytes)?.value else {
            return Err(Error::Schema);
        };
        let mut count = 0u64;
        media::decode_base64(&incoming, text, |bytes| {
            count += bytes.len() as u64;
            Ok(())
        })?;
        let doc = self.document.as_mut().ok_or(Error::Closed)?;
        let base = doc.absorb(incoming)? - root;
        doc.append(self.data, base + bytes)?;
        self.next = self.next.checked_add(1).ok_or(Error::Limit)?;
        self.offset = self.offset.checked_add(count).ok_or(Error::Limit)?;
        Ok(())
    }

    pub(super) fn transcript(&mut self, mut incoming: Document) -> Result<()> {
        let root = incoming.root();
        let text = incoming.remove(root, "text")?.ok_or(Error::Schema)?;
        let doc = self.document.as_mut().ok_or(Error::Closed)?;
        if doc.member(self.value, "transcript")?.is_some() {
            return Err(Error::Schema);
        }
        let text = doc.absorb(incoming)? - root + text;
        doc.rename(text, "transcript")?;
        doc.append(self.value, text)
    }

    pub(super) fn end(&mut self, incoming: &Document) -> Result<(Document, usize, &'static str, u64)> {
        if incoming.unsigned(incoming.required(incoming.root(), "bytes")?)? != self.offset
            || !incoming.string_is(incoming.required(incoming.root(), "status")?, "completed")?
        {
            return Err(Error::Schema);
        }
        Ok((
            self.document.take().ok_or(Error::Closed)?,
            self.value,
            self.field,
            self.choice,
        ))
    }
}

impl Egress {
    pub(super) fn native_field(
        &mut self,
        owner: &mut Writer,
        mut native: Document,
        value: usize,
        field: &'static str,
        choice: u64,
    ) -> Result<Document> {
        let parent = native.node(value)?.parent.ok_or(Error::Schema)?;
        native.detach(parent, value)?;
        let native_root = native.root();
        let mut projection = mapped_document(owner, |e| {
            e.bytes(b"{")?;
            chunk_base(self.document.as_ref().ok_or(Error::Schema)?, e)?;
            e.bytes(b",\"choices\":[{\"index\":")?;
            e.unsigned(choice)?;
            e.bytes(b",\"delta\":{},\"finish_reason\":null}]}")
        })?;
        let imported = projection.absorb(native)? - native_root + value;
        let choices = projection.required(projection.root(), "choices")?;
        let choice = projection.node(choices)?.first.ok_or(Error::Schema)?;
        let delta = projection.required(choice, "delta")?;
        if field == "audio" {
            projection.rename(imported, field)?;
            projection.append(delta, imported)?;
        } else {
            let array = projection.set(delta, field, Value::Array)?;
            projection.append(array, imported)?;
        }
        Ok(projection)
    }

    pub(super) fn project(
        &mut self,
        owner: &mut Writer,
        projection: Document,
        mut output: impl FnMut(ScratchLease) -> Result<()>,
    ) -> Result<()> {
        if self.mode == BodyMode::Streaming {
            output(encode::scratch(owner, |e| {
                e.bytes(b"data: ")?;
                projection.write(projection.root(), e)?;
                e.bytes(b"\n\n")
            })?)?;
        } else {
            let aggregate = self.document.as_mut().ok_or(Error::Schema)?;
            let incoming = aggregate.absorb(projection)?;
            aggregate_chunk(aggregate, incoming)?;
        }
        Ok(())
    }
}
