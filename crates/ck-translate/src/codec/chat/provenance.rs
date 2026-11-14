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

pub(super) fn pointer(doc: &Document, mut node: usize, e: &mut Encoder<'_, '_>) -> Result<()> {
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
pub(super) struct Segment<'a> {
    chars: Characters<'a>,
    remaining: usize,
}
impl Segment<'_> {
    pub(super) fn index(mut self) -> Result<usize> {
        let mut index = 0usize;
        let mut any = false;
        while let Some(c) = self.next()? {
            if !c.is_ascii_digit() {
                return Err(Error::Schema);
            }
            index = index
                .checked_mul(10)
                .and_then(|n| n.checked_add(c as usize - '0' as usize))
                .ok_or(Error::Limit)?;
            any = true;
        }
        if any { Ok(index) } else { Err(Error::Schema) }
    }
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
    pub(super) fn matches(&self, doc: &Document, name: Name) -> Result<bool> {
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

pub(super) fn leaf(doc: &Document, pointer: usize) -> Result<Segment<'_>> {
    let mut chars = doc.chars(pointer)?;
    if chars.next_scalar()? != Some('/') {
        return Err(Error::Schema);
    }
    loop {
        let (name, last) = segment(&mut chars)?;
        if last {
            return Ok(name);
        }
    }
}

pub(super) fn write_segment(mut name: Segment<'_>, e: &mut Encoder<'_, '_>) -> Result<()> {
    e.bytes(b"\"")?;
    while let Some(c) = name.next()? {
        e.escaped(c.encode_utf8(&mut [0; 4]))?;
    }
    e.bytes(b"\"")
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

pub(super) fn preserve_request_members<const N: usize>(
    doc: &mut Document,
    owner: &mut ck_stream::Writer,
    parent: usize,
    target: usize,
    carrier: Option<&'static str>,
    keys: &[&str; N],
) -> Result<()> {
    let mut fields = [None; N];
    for (field, key) in fields.iter_mut().zip(keys) {
        *field = doc.member(parent, key)?;
    }
    if fields.iter().all(Option::is_none) {
        return Ok(());
    }
    let lease = crate::codec::encode::scratch(owner, |e| {
        e.bytes(b"[")?;
        for (index, field) in fields.iter().flatten().enumerate() {
            if index != 0 {
                e.bytes(b",")?;
            }
            pointer(doc, *field, e)?;
        }
        e.bytes(b"]")
    })?;
    let paths = doc.import_json(owner, lease)?;
    let x = doc.required(doc.root(), "x_ck")?;
    let original = doc.required(x, "original")?;
    for field in fields.into_iter().flatten() {
        let path = doc.node(paths)?.first.ok_or(Error::Schema)?;
        doc.detach(paths, path)?;
        doc.detach(parent, field)?;
        let entry = doc.add(None, Value::Object)?;
        doc.append(original, entry)?;
        doc.bind_origin(entry, target, carrier)?;
        doc.set(entry, "protocol", Value::Text("chat"))?;
        doc.rename(path, "pointer")?;
        doc.append(entry, path)?;
        doc.rename(field, "value")?;
        doc.append(entry, field)?;
    }
    Ok(())
}

pub(super) fn request_members(
    doc: &Document,
    parent: usize,
    carrier: Option<&str>,
    skip: &[&str],
    mapped_elsewhere: &[&str],
    e: &mut Encoder<'_, '_>,
) -> Result<()> {
    request_members_first(doc, parent, carrier, skip, mapped_elsewhere, &mut false, e)
}

pub(super) fn request_members_first(
    doc: &Document,
    parent: usize,
    carrier: Option<&str>,
    skip: &[&str],
    mapped_elsewhere: &[&str],
    first: &mut bool,
    e: &mut Encoder<'_, '_>,
) -> Result<()> {
    let x = doc.required(doc.root(), "x_ck")?;
    let Some(original) = doc.member(x, "original")? else {
        return Ok(());
    };
    'entries: for entry in doc.origins(parent)? {
        if doc.node(entry)?.parent != Some(original) || doc.origin(entry)? != Some((parent, carrier)) {
            continue;
        }
        if !doc.string_is(doc.required(entry, "protocol")?, "chat")? {
            continue;
        }
        let pointer = doc.required(entry, "pointer")?;
        let mut chars = doc.chars(pointer)?;
        if chars.next_scalar()? != Some('/') {
            continue;
        }
        let name = loop {
            let (name, last) = segment(&mut chars)?;
            if last {
                break name;
            }
        };
        for key in skip {
            if name.is(key)? {
                continue 'entries;
            }
        }
        let current = match carrier {
            Some(_) => doc.required(parent, "source")?,
            None => parent,
        };
        for child in doc.children(current)? {
            let field = doc.node(child)?.name.ok_or(Error::Schema)?;
            let mut mapped = false;
            for key in mapped_elsewhere {
                mapped |= doc.name_is(field, key)?;
            }
            if !mapped && name.matches(doc, field)? {
                continue 'entries;
            }
        }
        // Only unmapped members are restored; mapped deletions must not revive source data.
        if !*first {
            e.bytes(b",")?;
        }
        *first = false;
        e.bytes(b"\"")?;
        let mut name = name;
        while let Some(c) = name.next()? {
            e.escaped(c.encode_utf8(&mut [0; 4]))?;
        }
        e.bytes(b"\":")?;
        doc.write(doc.required(entry, "value")?, e)?;
    }
    Ok(())
}

fn segment<'a>(chars: &mut Characters<'a>) -> Result<(Segment<'a>, bool)> {
    let start = chars.clone();
    let mut remaining = 0;
    let last = loop {
        match chars.next_scalar()? {
            Some('/') => break false,
            None => break true,
            Some(_) => remaining += 1,
        }
    };
    Ok((
        Segment {
            chars: start,
            remaining,
        },
        last,
    ))
}

pub(super) fn bindings(doc: &mut Document, owner: &mut ck_stream::Writer) -> Result<()> {
    let x = doc.required(doc.root(), "x_ck")?;
    for key in ["original", "cache_control", "replay", "tools", "chat_legacy_calls"] {
        let Some(list) = doc.member(x, key)? else {
            continue;
        };
        let mut next = doc.node(list)?.first;
        while let Some(entry) = next {
            next = doc.node(entry)?.next;
            let Some((parent, carrier)) = doc.origin(entry)? else {
                continue;
            };
            let lease = crate::codec::encode::scratch(owner, |e| pointer(doc, parent, e))?;
            let binding = doc.import_json(owner, lease)?;
            doc.rename(binding, "binding")?;
            doc.append(entry, binding)?;
            if let Some(carrier) = carrier {
                doc.set(entry, "carrier", Value::Text(carrier))?;
            }
        }
    }
    Ok(())
}

pub(super) fn resolve(doc: &Document, pointer: usize) -> Result<usize> {
    resolve_to(doc, pointer, false)
}

pub(super) fn resolve_parent(doc: &Document, pointer: usize) -> Result<usize> {
    resolve_to(doc, pointer, true)
}

fn resolve_to(doc: &Document, pointer: usize, parent_only: bool) -> Result<usize> {
    let mut chars = doc.chars(pointer)?;
    match chars.next_scalar()? {
        None => return Ok(doc.root()),
        Some('/') => (),
        _ => return Err(Error::Schema),
    }
    let mut parent = doc.root();
    loop {
        let (name, last) = segment(&mut chars)?;
        if last && parent_only {
            return Ok(parent);
        }
        parent = match doc.node(parent)?.value {
            Value::Object => {
                let mut found = None;
                for child in doc.children(parent)? {
                    if name.matches(doc, doc.node(child)?.name.ok_or(Error::Schema)?)? {
                        found = Some(child);
                        break;
                    }
                }
                found.ok_or(Error::Schema)?
            }
            Value::Array => doc.children(parent)?.nth(name.index()?).ok_or(Error::Schema)?,
            _ => return Err(Error::Schema),
        };
        if last {
            return Ok(parent);
        }
    }
}

pub(super) fn restore_bindings(doc: &mut Document) -> Result<()> {
    let x = doc.required(doc.root(), "x_ck")?;
    for key in ["original", "cache_control", "replay", "tools", "chat_legacy_calls"] {
        let Some(list) = doc.member(x, key)? else {
            continue;
        };
        let mut next = doc.node(list)?.first;
        while let Some(entry) = next {
            next = doc.node(entry)?.next;
            let Some(binding) = doc.member(entry, "binding")? else {
                continue;
            };
            let parent = resolve(doc, binding)?;
            let carrier = if let Some(carrier) = doc.member(entry, "carrier")? {
                let mut found = None;
                for name in ["image_url", "input_audio", "file"] {
                    if doc.string_is(carrier, name)? {
                        found = Some(name);
                    }
                }
                Some(found.ok_or(Error::Schema)?)
            } else {
                None
            };
            doc.bind_origin(entry, parent, carrier)?;
        }
    }
    Ok(())
}

pub(super) fn preserve_request_field(
    doc: &mut Document,
    owner: &mut ck_stream::Writer,
    field: usize,
    target: usize,
    carrier: Option<&'static str>,
) -> Result<usize> {
    let parent = doc.node(field)?.parent.ok_or(Error::Schema)?;
    let lease = crate::codec::encode::scratch(owner, |e| pointer(doc, field, e))?;
    let pointer = doc.import_json(owner, lease)?;
    let x = doc.required(doc.root(), "x_ck")?;
    let original = doc.required(x, "original")?;
    let entry = doc.add(None, Value::Object)?;
    doc.append(original, entry)?;
    doc.bind_origin(entry, target, carrier)?;
    doc.set(entry, "protocol", Value::Text("chat"))?;
    doc.rename(pointer, "pointer")?;
    doc.append(entry, pointer)?;
    doc.detach(parent, field)?;
    doc.rename(field, "value")?;
    doc.append(entry, field)?;
    Ok(entry)
}

pub(super) fn native_members(
    doc: &mut Document,
    owner: &mut ck_stream::Writer,
    part: usize,
    carrier: &'static str,
    known: &[&str],
) -> Result<()> {
    let native = doc.required(part, carrier)?;
    let mut next = doc.node(native)?.first;
    while let Some(field) = next {
        next = doc.node(field)?.next;
        let name = doc.node(field)?.name.ok_or(Error::Schema)?;
        let mut mapped = false;
        for key in known {
            mapped |= doc.name_is(name, key)?;
        }
        if !mapped {
            preserve_request_field(doc, owner, field, part, Some(carrier))?;
        }
    }
    Ok(())
}
