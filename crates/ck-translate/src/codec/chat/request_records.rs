use crate::codec::{
    Error, Result,
    document::{Document, Name, Value},
    event::Kind,
    internal,
};
use ck_stream::{Reader, Writer};

/// Reconstruct request topology and provenance from trusted canonical records.
/// Media payload registrations remain the responsibility of the media consumer.
pub fn read_document(owner: &mut Writer, reader: &mut Reader) -> Result<Document> {
    let mut doc = Document::streaming(owner)?;
    let mut started = false;
    loop {
        let (kind, event) = internal::next(owner, reader)?;
        match kind {
            Kind::RequestStart if !started => started = true,
            Kind::RequestField if started => {
                let root = doc.absorb(event)?;
                let pointer = doc.required(root, "pointer")?;
                let value = doc.required(root, "value")?;
                if doc.string_is(pointer, "")? {
                    doc.transplant(doc.root(), value)?;
                    continue;
                }
                let parent = super::super::provenance::resolve_parent(&doc, pointer)?;
                let name = super::super::provenance::leaf(&doc, pointer)?;
                let target = if matches!(doc.node(parent)?.value, Value::Array) {
                    let index = name.index()?;
                    let count = doc.children(parent)?.count();
                    if index > count {
                        return Err(Error::Schema);
                    }
                    doc.children(parent)?.nth(index)
                } else {
                    let mut target = None;
                    for child in doc.children(parent)? {
                        if name.matches(&doc, doc.node(child)?.name.ok_or(Error::Schema)?)? {
                            target = Some(child);
                            break;
                        }
                    }
                    target
                };
                if let Some(target) = target {
                    doc.transplant(target, value)?;
                } else {
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
                }
            }
            Kind::MediaStart | Kind::Data | Kind::MediaEnd if started => (),
            Kind::RequestEnd if started => {
                super::super::provenance::restore_bindings(&mut doc)?;
                return Ok(doc);
            }
            Kind::Error => return Err(Error::Schema),
            _ => return Err(Error::Schema),
        }
    }
}
