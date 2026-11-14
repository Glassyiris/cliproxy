use crate::codec::{
    Error, Result,
    document::{Characters, Document, Name, Value},
    encode::Encoder,
};

pub(super) fn unknown(doc: &Document, object: usize, skip: &[&str], e: &mut Encoder<'_, '_>) -> Result<()> {
    let mut first = true;
    for field in doc.children(object)? {
        let name = doc.node(field)?.name.ok_or(Error::Schema)?;
        let mut known = false;
        for key in skip {
            known |= doc.name_is(name, key)?;
        }
        if known {
            continue;
        }
        if first {
            e.bytes(b",\"original\":[")?;
            first = false;
        } else {
            e.bytes(b",")?;
        }
        entry(doc, field, e)?;
    }
    if !first {
        e.bytes(b"]")?;
    }
    Ok(())
}

pub(super) fn one(doc: &Document, field: usize, e: &mut Encoder<'_, '_>) -> Result<()> {
    e.bytes(b",\"original\":[")?;
    entry(doc, field, e)?;
    e.bytes(b"]")
}

fn entry(doc: &Document, field: usize, e: &mut Encoder<'_, '_>) -> Result<()> {
    e.bytes(b"{\"protocol\":\"chat\",\"pointer\":")?;
    pointer(doc, field, e)?;
    e.bytes(b",\"value\":")?;
    doc.write(field, e)?;
    e.bytes(b"}")
}

fn pointer(doc: &Document, mut node: usize, e: &mut Encoder<'_, '_>) -> Result<()> {
    let mut path = [None; 128];
    let mut depth = 0;
    while let Some(parent) = doc.node(node)?.parent {
        *path.get_mut(depth).ok_or(Error::Limit)? = Some((parent, node));
        depth += 1;
        node = parent;
    }
    e.bytes(b"\"")?;
    for entry in path[..depth].iter().rev() {
        let (parent, node) = entry.ok_or(Error::Schema)?;
        e.bytes(b"/")?;
        if matches!(doc.node(parent)?.value, Value::Array) {
            let index = doc
                .children(parent)?
                .position(|child| child == node)
                .ok_or(Error::Schema)?;
            e.unsigned(index as u64)?;
        } else {
            let mut name = doc.name_chars(doc.node(node)?.name.ok_or(Error::Schema)?)?;
            while let Some(c) = name.next_scalar()? {
                match c {
                    '~' => e.bytes(b"~0")?,
                    '/' => e.bytes(b"~1")?,
                    c => e.escaped(c.encode_utf8(&mut [0; 4]))?,
                }
            }
        }
    }
    e.bytes(b"\"")
}

#[derive(Clone)]
struct Segment<'a> {
    chars: Characters<'a>,
    remaining: usize,
}
impl Segment<'_> {
    fn next(&mut self) -> Result<Option<char>> {
        if self.remaining == 0 {
            return Ok(None);
        }
        self.remaining -= 1;
        let c = self.chars.next_scalar()?.ok_or(Error::Schema)?;
        if c != '~' {
            return Ok(Some(c));
        }
        if self.remaining == 0 {
            return Err(Error::Schema);
        }
        self.remaining -= 1;
        match self.chars.next_scalar()? {
            Some('0') => Ok(Some('~')),
            Some('1') => Ok(Some('/')),
            _ => Err(Error::Schema),
        }
    }
    fn is(&self, expected: &str) -> Result<bool> {
        let mut chars = self.clone();
        for c in expected.chars() {
            if chars.next()? != Some(c) {
                return Ok(false);
            }
        }
        Ok(chars.next()?.is_none())
    }
    fn matches(&self, doc: &Document, name: Name) -> Result<bool> {
        let mut chars = self.clone();
        let mut name = doc.name_chars(name)?;
        loop {
            let c = chars.next()?;
            if c != name.next_scalar()? {
                return Ok(false);
            }
            if c.is_none() {
                return Ok(true);
            }
        }
    }
}

pub(super) fn restore(doc: &mut Document, x: usize) -> Result<bool> {
    let Some(original) = doc.member(x, "original")? else {
        return Ok(true);
    };
    let mut restored = true;
    let mut next = doc.node(original)?.first;
    while let Some(entry) = next {
        next = doc.node(entry)?.next;
        if !doc.string_is(doc.required(entry, "protocol")?, "chat")? {
            restored = false;
            continue;
        }
        let pointer = doc.required(entry, "pointer")?;
        let Value::String(text) = doc.node(pointer)?.value else {
            return Err(Error::Schema);
        };
        let parent = {
            let mut chars = doc.chars(pointer)?;
            if chars.next_scalar()? != Some('/') {
                return Err(Error::Schema);
            }
            let mut parent = doc.root();
            loop {
                let start = chars.clone();
                let mut length = 0;
                let last = loop {
                    match chars.next_scalar()? {
                        Some('/') => break false,
                        None => break true,
                        Some(_) => length += 1,
                    }
                };
                let segment = Segment {
                    chars: start,
                    remaining: length,
                };
                if last {
                    if !matches!(doc.node(parent)?.value, Value::Object) {
                        restored = false;
                        break None;
                    }
                    let mut exists = false;
                    for child in doc.children(parent)? {
                        if let Some(name) = doc.node(child)?.name {
                            exists |= segment.matches(doc, name)?;
                        }
                    }
                    break if exists { None } else { Some(parent) };
                }
                let child = if matches!(doc.node(parent)?.value, Value::Array) {
                    let mut digits = segment.clone();
                    let mut index = 0usize;
                    while let Some(c) = digits.next()? {
                        let digit = c.to_digit(10).ok_or(Error::Schema)? as usize;
                        index = index
                            .checked_mul(10)
                            .and_then(|value| value.checked_add(digit))
                            .ok_or(Error::Limit)?;
                    }
                    let first = doc.node(parent)?.first;
                    if first.is_some_and(|first| doc.node(first).is_ok_and(|node| node.next.is_none())) {
                        first
                    } else {
                        doc.children(parent)?.nth(index)
                    }
                } else {
                    let mut found = None;
                    for child in doc.children(parent)? {
                        if let Some(name) = doc.node(child)?.name
                            && segment.matches(doc, name)?
                        {
                            found = Some(child);
                            break;
                        }
                    }
                    if found.is_none() && segment.is("message")? {
                        found = doc.member(parent, "delta")?;
                    }
                    if found.is_none() && segment.is("custom")? {
                        found = doc.member(parent, "function")?;
                    }
                    if found.is_none()
                        && segment.is("function_call")?
                        && let Some(calls) = doc.member(parent, "tool_calls")?
                        && let Some(call) = doc.node(calls)?.first
                    {
                        found = doc.member(call, "function")?;
                    }
                    found
                };
                let Some(child) = child else {
                    restored = false;
                    break None;
                };
                parent = child;
            }
        };
        if let Some(parent) = parent {
            let value = doc.remove(entry, "value")?.ok_or(Error::Schema)?;
            let target = doc.add(Some(Name::Pointer(text)), Value::Null)?;
            doc.transplant(target, value)?;
            doc.append(parent, target)?;
        }
    }
    Ok(restored)
}
