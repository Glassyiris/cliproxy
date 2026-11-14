use crate::codec::{
    Error, Result,
    document::{Document, Name, Text, Value},
    event::{Kind, LocalId},
    internal,
    media::{self, Encoding, Registry},
    provenance,
    table::Table,
};
use ck_stream::{MetadataPermit, Reader, Writer};
use std::collections::HashMap;

/// One media payload's records, from its start to its end.
struct Payload {
    id: LocalId,
    kind: &'static str,
    encoding: Encoding,
    chunks: Option<Table<Text>>,
    next: u64,
    offset: u64,
    ended: bool,
}

/// Rebuild a request from trusted canonical records: its topology, provenance bindings and
/// every published media payload, registered at its reference. A reference is trusted only as
/// the entire value of a request field; the same shape inside other data stays literal.
pub fn read_request(owner: &mut Writer, reader: &mut Reader) -> Result<(Document, Registry)> {
    let mut doc = Document::streaming(owner)?;
    let mut payloads: Table<Payload> = Table::new(owner)?;
    let mut references: Table<(LocalId, usize)> = Table::new(owner)?;
    let mut counts = Counts {
        children: HashMap::new(),
        permit: owner.reserve_metadata(0)?,
    };
    let mut started = false;
    loop {
        let (kind, event) = internal::next(owner, reader)?;
        match kind {
            Kind::RequestStart if !started => started = true,
            Kind::RequestField if started => {
                let node = field(&mut doc, &mut counts, event)?;
                if let Some(id) = reference(&doc, node)? {
                    references.push((id, node))?;
                }
            }
            Kind::MediaStart if started && payloads.last().is_none_or(|open| open.ended) => {
                payloads.push(start(owner, &event)?)?;
            }
            Kind::Data | Kind::MediaEnd if started => {
                let open = payloads.last_mut().filter(|open| !open.ended).ok_or(Error::Schema)?;
                let root = event.root();
                if media::media_id(&event, event.required(root, "x_ck")?)? != open.id {
                    return Err(Error::Schema);
                }
                if kind == Kind::MediaEnd {
                    // Only a completed payload whose data records add up to its count is trusted.
                    if event.unsigned(event.required(root, "bytes")?)? != open.offset
                        || !event.string_is(event.required(root, "status")?, "completed")?
                    {
                        return Err(Error::Schema);
                    }
                    open.ended = true;
                    continue;
                }
                if event.unsigned(event.required(root, "index")?)? != open.next
                    || event.unsigned(event.required(root, "offset")?)? != open.offset
                {
                    return Err(Error::Schema);
                }
                let Value::String(text) = event.node(event.required(root, "bytes")?)?.value else {
                    return Err(Error::Schema);
                };
                let mut decoded = 0u64;
                media::decode_base64(&event, text, |bytes| {
                    decoded += bytes.len() as u64;
                    Ok(())
                })?;
                open.offset = open.offset.checked_add(decoded).ok_or(Error::Limit)?;
                let text = doc.retain_text(event, text)?;
                open.chunks.as_mut().ok_or(Error::Schema)?.push(text)?;
                open.next += 1;
            }
            Kind::RequestEnd if started => {
                provenance::restore_bindings(&mut doc)?;
                let media = register(owner, &mut doc, &mut payloads, &mut references)?;
                return Ok((doc, media));
            }
            _ => return Err(Error::Schema),
        }
    }
}

/// Child count and last child of the arrays that fields fill. Fields arrive in order, so the
/// array element a field appends or descends into is nearly always the last one.
struct Counts {
    children: HashMap<usize, (usize, Option<usize>)>,
    permit: MetadataPermit,
}

impl Counts {
    fn get(&mut self, doc: &Document, array: usize) -> Result<&mut (usize, Option<usize>)> {
        if !self.children.contains_key(&array) {
            if self.children.len() == self.children.capacity() {
                self.children
                    .try_reserve(self.children.capacity().max(4))
                    .map_err(|_| Error::Limit)?;
                // A hash table slot holds the key, the value and one control byte.
                let slot = std::mem::size_of::<(usize, (usize, Option<usize>))>() + 1;
                self.permit
                    .resize(self.children.capacity().checked_mul(slot).ok_or(Error::Limit)?)?;
            }
            let (mut count, mut last) = (0, None);
            for child in doc.children(array)? {
                count += 1;
                last = Some(child);
            }
            self.children.insert(array, (count, last));
        }
        self.children.get_mut(&array).ok_or(Error::Schema)
    }
}

/// Places one request field at its pointer and returns the node that holds its value.
fn field(doc: &mut Document, counts: &mut Counts, event: Document) -> Result<usize> {
    let root = doc.absorb(event)?;
    let pointer = doc.required(root, "pointer")?;
    let value = doc.required(root, "value")?;
    if doc.string_is(pointer, "")? {
        doc.transplant(doc.root(), value)?;
        counts.children.remove(&doc.root());
        return Ok(doc.root());
    }
    let parent = provenance::resolve_parent_indexed(doc, pointer, &mut |array, index| {
        let (count, last) = *counts.get(doc, array)?;
        Ok(last.filter(|_| index + 1 == count))
    })?;
    let name = provenance::leaf(doc, pointer)?;
    let target = if matches!(doc.node(parent)?.value, Value::Array) {
        let index = name.index()?;
        let (count, _) = *counts.get(doc, parent)?;
        if index > count {
            return Err(Error::Schema);
        }
        // Fields arrive in order, so a new element is the common case; replacing one walks.
        if index == count {
            None
        } else {
            doc.children(parent)?.nth(index)
        }
    } else {
        let mut target = None;
        for child in doc.children(parent)? {
            if name.matches(doc, doc.node(child)?.name.ok_or(Error::Schema)?)? {
                target = Some(child);
                break;
            }
        }
        target
    };
    if let Some(target) = target {
        doc.transplant(target, value)?;
        counts.children.remove(&target);
        return Ok(target);
    }
    let Value::String(pointer) = doc.node(pointer)?.value else {
        return Err(Error::Schema);
    };
    doc.detach(root, value)?;
    let node = doc.add(
        if matches!(doc.node(parent)?.value, Value::Array) {
            None
        } else {
            Some(Name::Pointer(pointer))
        },
        Value::Null,
    )?;
    doc.transplant(node, value)?;
    doc.append(parent, node)?;
    if let Some((count, last)) = counts.children.get_mut(&parent) {
        *count += 1;
        *last = Some(node);
    }
    Ok(node)
}

/// Returns the media ID of a node holding exactly a media reference.
fn reference(doc: &Document, node: usize) -> Result<Option<LocalId>> {
    if !matches!(doc.node(node)?.value, Value::Object) || doc.children(node)?.count() != 3 {
        return Ok(None);
    }
    let Some(kind) = doc.member(node, "type")? else {
        return Ok(None);
    };
    if !doc.string_is(kind, "x_ck_media")? || doc.member(node, "value_kind")?.is_none() {
        return Ok(None);
    }
    media::media_id(doc, node).map(Some)
}

/// Opens a payload from its media start; the kind and MIME presence select its encoding.
fn start(owner: &mut Writer, event: &Document) -> Result<Payload> {
    let root = event.root();
    let id = media::media_id(event, event.required(root, "x_ck")?)?;
    let kind = event.required(root, "kind")?;
    let (kind, encoding) = if event.string_is(kind, "text")? {
        ("text", Encoding::Utf8)
    } else if event.string_is(kind, "audio")? {
        ("audio", Encoding::Base64)
    } else if event.string_is(kind, "image")? {
        ("image", Encoding::DataUri { skip: 0 })
    } else if event.string_is(kind, "document")? {
        let uri = event.member(root, "mime")?.is_some();
        (
            "document",
            if uri {
                Encoding::DataUri { skip: 0 }
            } else {
                Encoding::Base64
            },
        )
    } else {
        return Err(Error::Schema);
    };
    Ok(Payload {
        id,
        kind,
        encoding,
        chunks: Some(Table::new(owner)?),
        next: 0,
        offset: 0,
        ended: false,
    })
}

/// Registers every payload, in record order, at its single surviving reference.
fn register(
    owner: &mut Writer,
    doc: &mut Document,
    payloads: &mut Table<Payload>,
    references: &mut Table<(LocalId, usize)>,
) -> Result<Registry> {
    let mut registry = Registry::new(owner)?;
    // Sorted references let each payload find its reference without a cross scan.
    references.sort_unstable_by(|a, b| a.0.as_str().cmp(b.0.as_str()));
    let mut matched = 0;
    for payload in payloads.iter_mut() {
        if !payload.ended {
            return Err(Error::Schema);
        }
        let id = payload.id.as_str();
        let first = references.partition_point(|(other, _)| other.as_str() < id);
        let mut nodes = references[first..].iter().take_while(|(other, _)| other.as_str() == id);
        let node = nodes.next().map(|(_, node)| *node);
        if nodes.next().is_some() {
            return Err(Error::Schema);
        }
        matched += usize::from(node.is_some());
        // A later field may have replaced the reference; then the payload is unreachable.
        let node = match node {
            Some(node) if reference(doc, node)? == Some(payload.id) => {
                let utf8 = doc.string_is(doc.required(node, "value_kind")?, "utf8")?;
                if utf8 != matches!(payload.encoding, Encoding::Utf8) {
                    return Err(Error::Schema);
                }
                Some(node)
            }
            _ => None,
        };
        let chunks = payload.chunks.take().ok_or(Error::Schema)?;
        registry.adopt(doc, node, (payload.id, payload.kind, payload.encoding), chunks)?;
    }
    // Every reference names a payload.
    if matched != references.len() {
        return Err(Error::Schema);
    }
    Ok(registry)
}
