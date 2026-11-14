//! Gemini generation and count boundaries over the canonical inference stream.

pub mod egress;
pub mod request;
mod request_content;
mod request_encode;
mod request_schema;
pub mod response;

use crate::codec::{
    Error, Result,
    document::{Document, Value},
    encode::{self, Encoder},
    event::{Emitter, Kind, Scope},
    source::Source,
};
use ck_stream::{MetadataPermit, Writer};

fn mapped(owner: &mut Writer, write: impl Fn(&mut Encoder<'_, '_>) -> Result<()>) -> Result<Document> {
    let raw = encode::scratch(owner, write)?;
    let mut source = Source::new(owner)?;
    source.push_scratch(raw)?;
    let length = source.len();
    Document::parse(owner, source, length)
}
fn failure(emitter: &mut Emitter, owner: &mut Writer, client: bool) -> Result<()> {
    emitter.emit(owner, Kind::Error, Scope::default(), |e| {
        e.bytes(if client { b",\"code\":\"invalid_request\",\"status\":400,\"message\":\"Invalid request\",\"scope\":\"client\"" } else { b",\"code\":\"invalid_response\",\"status\":502,\"message\":\"Invalid upstream response\",\"scope\":\"upstream\"" })
    }, |_| Ok(()))?;
    Ok(())
}
fn string(doc: &Document, node: usize) -> Result<()> {
    doc.chars(node)?;
    Ok(())
}
fn is(doc: &Document, parent: usize, key: &str, value: &str) -> Result<bool> {
    doc.member(parent, key)?
        .map(|n| doc.string_is(n, value))
        .transpose()
        .map(|v| v.unwrap_or(false))
}
fn member(doc: &Document, parent: usize, key: &str, e: &mut Encoder<'_, '_>) -> Result<()> {
    if let Some(n) = doc.member(parent, key)? {
        e.bytes(b",")?;
        e.string(key)?;
        e.bytes(b":")?;
        doc.write(n, e)?;
    }
    Ok(())
}
fn members(doc: &Document, parent: usize, skip: &[&str], e: &mut Encoder<'_, '_>) -> Result<()> {
    for n in doc.children(parent)? {
        let name = doc.node(n)?.name.ok_or(Error::Schema)?;
        if skip
            .iter()
            .try_fold(false, |yes, key| Ok::<_, Error>(yes || doc.name_is(name, key)?))?
        {
            continue;
        }
        e.bytes(b",")?;
        doc.write_name(name, e)?;
        e.bytes(b":")?;
        doc.write(n, e)?;
    }
    Ok(())
}
fn provenance(doc: &Document, parent: usize, known: &[&str], e: &mut Encoder<'_, '_>) -> Result<()> {
    e.bytes(b",\"source\":{\"protocol\":\"gemini\"},\"original\":[")?;
    let mut first = true;
    for node in doc.children(parent)? {
        let name = doc.node(node)?.name.ok_or(Error::Schema)?;
        if known
            .iter()
            .try_fold(false, |yes, key| Ok::<_, Error>(yes || doc.name_is(name, key)?))?
        {
            continue;
        }
        if !first {
            e.bytes(b",")?;
        }
        first = false;
        e.bytes(b"{\"protocol\":\"gemini\",\"pointer\":\"/")?;
        let mut chars = doc.name_chars(name)?;
        while let Some(c) = chars.next_scalar()? {
            match c {
                '~' => e.bytes(b"~0")?,
                '/' => e.bytes(b"~1")?,
                c => e.escaped(c.encode_utf8(&mut [0; 4]))?,
            }
        }
        e.bytes(b"\",\"value\":")?;
        doc.write(node, e)?;
        e.bytes(b"}")?;
    }
    e.bytes(b"]")
}
struct Table<T> {
    values: Vec<T>,
    permit: MetadataPermit,
}
impl<T> Table<T> {
    fn new(owner: &mut Writer) -> Result<Self> {
        Ok(Self {
            values: Vec::new(),
            permit: owner.reserve_metadata(0)?,
        })
    }
    fn push(&mut self, value: T) -> Result<usize> {
        self.permit.check_live()?;
        if self.values.len() == self.values.capacity() {
            let capacity = self.values.capacity().max(4).checked_mul(2).ok_or(Error::Limit)?;
            self.permit
                .resize(capacity.checked_mul(std::mem::size_of::<T>()).ok_or(Error::Limit)?)?;
            self.values
                .try_reserve_exact(capacity - self.values.len())
                .map_err(|_| Error::Limit)?;
            self.permit.resize(self.values.capacity() * std::mem::size_of::<T>())?;
        }
        let index = self.values.len();
        self.values.push(value);
        Ok(index)
    }
}
impl<T> std::ops::Deref for Table<T> {
    type Target = [T];
    fn deref(&self) -> &[T] {
        &self.values
    }
}
impl<T> std::ops::DerefMut for Table<T> {
    fn deref_mut(&mut self) -> &mut [T] {
        &mut self.values
    }
}
fn object(doc: &Document, node: usize) -> Result<()> {
    if matches!(doc.node(node)?.value, Value::Object) {
        Ok(())
    } else {
        Err(Error::Schema)
    }
}
fn array(doc: &Document, node: usize) -> Result<()> {
    if matches!(doc.node(node)?.value, Value::Array) {
        Ok(())
    } else {
        Err(Error::Schema)
    }
}

fn origin(doc: &Document, parent: usize, carrier: &'static str) -> Result<Option<usize>> {
    for entry in doc.origins(parent)? {
        if doc.origin(entry)?.is_some_and(|(_, kind)| kind == Some(carrier)) {
            return Ok(Some(entry));
        }
    }
    Ok(None)
}
