use super::*;
use crate::codec::internal;
use std::task::Poll;

#[derive(Clone, Copy)]
enum Change {
    Remove(usize),
    Text(usize, usize),
    Bytes(usize, u64),
    Index(usize, u64),
}

impl State {
    pub(super) fn reconcile(&mut self, owner: &mut Writer, doc: &mut Document, choices: usize) -> Result<()> {
        let mut snapshots = false;
        for choice in doc.children(choices)? {
            snapshots |= doc.member(choice, "message")?.is_some();
        }
        if !snapshots {
            return Ok(());
        }
        while let Poll::Ready(Some(record)) = self.reader.try_next() {
            let ck_stream::Read::Record(lease) = record else {
                return Err(Error::Closed);
            };
            let (kind, input) = internal::decode(owner, lease)?;
            if kind == Kind::Opaque {
                let x = input.required(input.root(), "x_ck")?;
                if input.member(x, "media_id")?.is_none()
                    || !input
                        .member(input.root(), "name")?
                        .map(|n| input.string_is(n, "chat.media.attributes"))
                        .transpose()?
                        .unwrap_or(false)
                {
                    continue;
                }
            }
            // Accounting observes only ingress updates, never this native replay.
            if kind == Kind::Usage {
                continue;
            }
            let (projection, _) = self.reduction.project(owner, kind, input)?;
            if let Some(projection) = projection {
                self.reduction.fold(projection)?;
            }
        }
        let prior = self.reduction.document.as_ref().ok_or(Error::Schema)?;
        for choice in doc.children(choices)? {
            let Some(finish) = doc.member(choice, "finish_reason")? else {
                continue;
            };
            if matches!(doc.node(finish)?.value, Value::Null) {
                continue;
            }
            let index = doc.unsigned(doc.required(choice, "index")?)?;
            let position = self
                .choices
                .iter()
                .position(|choice| choice.index == index)
                .ok_or(Error::Schema)?;
            let message = doc.member(choice, "message")?;
            let supplied_audio = message
                .map(|message| doc.member(message, "audio"))
                .transpose()?
                .flatten();
            let supplied_data = match supplied_audio {
                Some(audio) if matches!(doc.node(audio)?.value, Value::Object) => doc.member(audio, "data")?.is_some(),
                _ => false,
            };
            if !supplied_data && !self.choices[position].audio.complete() {
                return Err(Error::Truncated);
            }
            if doc.string_is(finish, "length")? || doc.string_is(finish, "content_filter")? {
                continue;
            }
            let old = indexed(prior, prior.required(prior.root(), "choices")?, index)?
                .map(|choice| prior.required(choice, "message"))
                .transpose()?;
            if let Some(message) = message {
                validate_completion(owner, prior, old, doc, message)?;
            } else if let Some(old) = old {
                validate_completion(owner, prior, None, prior, old)?;
            }
        }
        let mut changes = Table::new(owner)?;
        let mut seen = Table::new(owner)?;
        for choice in doc.children(choices)? {
            let index = doc.unsigned(doc.required(choice, "index")?)?;
            if seen.contains(&index) {
                return Err(Error::Schema);
            }
            seen.push(index)?;
            let Some(message) = doc.member(choice, "message")? else {
                continue;
            };
            validate_message(owner, doc, message)?;
            let old = indexed(prior, prior.required(prior.root(), "choices")?, index)?
                .map(|c| prior.required(c, "message"))
                .transpose()?;
            if let Some(audio) = doc.member(message, "audio")?
                && matches!(doc.node(audio)?.value, Value::Object)
                && let Some(data) = doc.member(audio, "data")?
            {
                let mut published = 0;
                if let Some(old) = old
                    && let Some(audio) = prior.member(old, "audio")?
                    && matches!(prior.node(audio)?.value, Value::Object)
                    && let Some(data) = prior.member(audio, "data")?
                {
                    let mut bytes = prior.decoded_bytes(data)?;
                    while bytes.next_byte()?.is_some() {
                        published += 1;
                    }
                }
                let position = self
                    .choices
                    .iter()
                    .position(|choice| choice.index == index)
                    .ok_or(Error::Schema)?;
                self.choices[position].audio.validate_snapshot(doc, data, published)?;
            }
            reconcile_object(owner, prior, old, doc, message, &mut changes, Context::Message)?;
        }
        for choice in doc.children(choices)? {
            if let Some(message) = doc.member(choice, "message")?
                && let Some(audio) = doc.member(message, "audio")?
                && matches!(doc.node(audio)?.value, Value::Object)
                && doc.member(audio, "data")?.is_some()
            {
                let index = doc.unsigned(doc.required(choice, "index")?)?;
                let position = self
                    .choices
                    .iter()
                    .position(|choice| choice.index == index)
                    .ok_or(Error::Schema)?;
                self.choices[position].audio = media::Base64Fragments::default();
            }
        }
        // Mutate only the parsed incoming topology after every choice validates.
        // Scratch contains new suffixes, never a serialized accumulated message.
        for change in changes.iter() {
            match *change {
                Change::Remove(node) => {
                    let parent = doc.node(node)?.parent.ok_or(Error::Schema)?;
                    doc.detach(parent, node)?;
                }
                Change::Index(node, index) => {
                    doc.set(node, "index", Value::Unsigned(index))?;
                }
                Change::Text(node, skip) => {
                    let suffix = encode::scratch(owner, |e| {
                        let mut chars = doc.chars(node)?;
                        for _ in 0..skip {
                            chars.next_scalar()?.ok_or(Error::Schema)?;
                        }
                        e.bytes(b"\"")?;
                        while let Some(c) = chars.next_scalar()? {
                            e.escaped(c.encode_utf8(&mut [0; 4]))?;
                        }
                        e.bytes(b"\"")
                    })?;
                    let value = doc.import_json(owner, suffix)?;
                    doc.transplant(node, value)?;
                }
                Change::Bytes(node, skip) => {
                    let suffix = encode::scratch(owner, |e| {
                        use base64::Engine;
                        let mut bytes = doc.decoded_bytes(node)?;
                        for _ in 0..skip {
                            bytes.next_byte()?.ok_or(Error::Schema)?;
                        }
                        e.bytes(b"\"")?;
                        loop {
                            let mut block = [0; 3];
                            let mut len = 0;
                            for slot in &mut block {
                                let Some(byte) = bytes.next_byte()? else { break };
                                *slot = byte;
                                len += 1;
                            }
                            if len == 0 {
                                break;
                            }
                            let mut encoded = [0; 4];
                            let n = base64::engine::general_purpose::STANDARD
                                .encode_slice(&block[..len], &mut encoded)
                                .map_err(|_| Error::Schema)?;
                            e.bytes(&encoded[..n])?;
                        }
                        e.bytes(b"\"")
                    })?;
                    let value = doc.import_json(owner, suffix)?;
                    doc.transplant(node, value)?;
                }
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Context {
    Message,
    Tool,
    Function,
    Audio,
    Metadata,
}

fn indexed(doc: &Document, array: usize, index: u64) -> Result<Option<usize>> {
    for child in doc.children(array)? {
        if doc.unsigned(doc.required(child, "index")?)? == index {
            return Ok(Some(child));
        }
    }
    Ok(None)
}

pub(super) fn matching_member(old: &Document, parent: usize, new: &Document, node: usize) -> Result<Option<usize>> {
    let name = new.node(node)?.name.ok_or(Error::Schema)?;
    for child in old.children(parent)? {
        let mut a = old.name_chars(old.node(child)?.name.ok_or(Error::Schema)?)?;
        let mut b = new.name_chars(name)?;
        loop {
            let c = a.next_scalar()?;
            if c != b.next_scalar()? {
                break;
            }
            if c.is_none() {
                return Ok(Some(child));
            }
        }
    }
    Ok(None)
}

fn reconcile_object(
    owner: &mut Writer,
    old: &Document,
    prior: Option<usize>,
    new: &Document,
    object: usize,
    changes: &mut Table<Change>,
    context: Context,
) -> Result<bool> {
    if !matches!(new.node(object)?.value, Value::Object) {
        return Err(Error::Schema);
    }
    let mut empty = true;
    for field in new.children(object)? {
        let name = new.node(field)?.name.ok_or(Error::Schema)?;
        let previous = prior
            .map(|p| matching_member(old, p, new, field))
            .transpose()?
            .flatten();
        let same = if context == Context::Message && new.name_is(name, "tool_calls")? {
            reconcile_tools(owner, old, previous, new, field, changes)?
        } else if let Some(previous) = previous {
            let append = match context {
                Context::Message => ["content", "refusal", "reasoning_content"]
                    .iter()
                    .any(|key| new.name_is(name, key).unwrap_or(false)),
                Context::Function => new.name_is(name, "arguments")? || new.name_is(name, "input")?,
                Context::Audio => new.name_is(name, "transcript")?,
                _ => false,
            };
            if context == Context::Audio && new.name_is(name, "data")? {
                let (skip, equal) = bytes_prefix(old, previous, new, field, 0)?;
                if !equal {
                    changes.push(Change::Bytes(field, skip))?;
                }
                equal
            } else if append && is_string(old.node(previous)?.value) {
                let (skip, equal) = text_prefix(old, previous, new, field)?;
                if !equal {
                    changes.push(Change::Text(field, skip))?;
                }
                equal
            } else if matches!(old.node(previous)?.value, Value::Array)
                && matches!(new.node(field)?.value, Value::Array)
            {
                let mut incoming = new.children(field)?;
                for entry in old.children(previous)? {
                    let supplied = incoming.next().ok_or(Error::Schema)?;
                    if !exact(old, entry, new, supplied, 0)? {
                        return Err(Error::Schema);
                    }
                    changes.push(Change::Remove(supplied))?;
                }
                incoming.next().is_none()
            } else if matches!(old.node(previous)?.value, Value::Object)
                && matches!(new.node(field)?.value, Value::Object)
            {
                let nested = if context == Context::Message && new.name_is(name, "audio")? {
                    Context::Audio
                } else if new.name_is(name, "function")?
                    || new.name_is(name, "custom")?
                    || new.name_is(name, "function_call")?
                {
                    Context::Function
                } else {
                    Context::Metadata
                };
                reconcile_object(owner, old, Some(previous), new, field, changes, nested)?
            } else {
                let same = exact(old, previous, new, field, 0)?;
                let immutable = append
                    || (context == Context::Message
                        && ["role", "audio", "images", "function_call"]
                            .iter()
                            .any(|key| new.name_is(name, key).unwrap_or(false)))
                    || (context == Context::Tool
                        && ["id", "index", "type"]
                            .iter()
                            .any(|key| new.name_is(name, key).unwrap_or(false)))
                    || (context == Context::Function && new.name_is(name, "name")?)
                    || (context == Context::Audio
                        && ["id", "format", "codec", "sample_rate", "channels"]
                            .iter()
                            .any(|key| new.name_is(name, key).unwrap_or(false)));
                // A previously absent/null value can acquire content; a published value cannot be cleared.
                if !same && immutable && !matches!(old.node(previous)?.value, Value::Null) {
                    return Err(Error::Schema);
                }
                same
            }
        } else {
            if context == Context::Message && new.name_is(name, "function_call")? {
                new.required(field, "name")?;
            }
            false
        };
        if same {
            changes.push(Change::Remove(field))?;
        } else {
            empty = false;
        }
    }
    Ok(empty)
}

fn reconcile_tools(
    owner: &mut Writer,
    old: &Document,
    prior: Option<usize>,
    new: &Document,
    calls: usize,
    changes: &mut Table<Change>,
) -> Result<bool> {
    let mut seen = Table::new(owner)?;
    let mut empty = true;
    for (ordinal, call) in new.children(calls)?.enumerate() {
        let supplied_index = new.member(call, "index")?.map(|n| new.unsigned(n)).transpose()?;
        let supplied_id = new.member(call, "id")?;
        let mut previous = None;
        if let Some(prior) = prior {
            for candidate in old.children(prior)? {
                let candidate_index = old.unsigned(old.required(candidate, "index")?)?;
                let index_match = supplied_index == Some(candidate_index);
                let id_match = if let Some(id) = supplied_id {
                    exact(old, old.required(candidate, "id")?, new, id, 0)?
                } else {
                    false
                };
                if index_match || id_match {
                    if previous.is_some_and(|p| p != candidate) {
                        return Err(Error::Schema);
                    }
                    previous = Some(candidate);
                }
            }
        }
        let index = if let Some(previous) = previous {
            let custom = old.member(previous, "custom")?.is_some();
            if new.member(call, if custom { "function" } else { "custom" })?.is_some() {
                return Err(Error::Schema);
            }
            let index = old.unsigned(old.required(previous, "index")?)?;
            if supplied_index.is_some_and(|supplied| supplied != index) {
                return Err(Error::Schema);
            }
            index
        } else {
            new.required(call, "id")?;
            let custom = new
                .member(call, "type")?
                .map(|n| new.string_is(n, "custom"))
                .transpose()?
                .unwrap_or(false);
            new.required(new.required(call, if custom { "custom" } else { "function" })?, "name")?;
            if let Some(prior) = prior
                && indexed(old, prior, supplied_index.unwrap_or(ordinal as u64))?.is_some()
            {
                return Err(Error::Schema);
            }
            supplied_index.unwrap_or(ordinal as u64)
        };
        if seen.contains(&index) {
            return Err(Error::Schema);
        }
        seen.push(index)?;
        let same = reconcile_object(owner, old, previous, new, call, changes, Context::Tool)?;
        if same {
            changes.push(Change::Remove(call))?;
        } else {
            changes.push(Change::Index(call, index))?;
            empty = false;
        }
    }
    Ok(empty && prior.is_some())
}

fn is_string(value: Value) -> bool {
    matches!(
        value,
        Value::String(_) | Value::Text(_) | Value::Id(_) | Value::Fragments | Value::Utf8Media
    )
}

fn text_prefix(old: &Document, prior: usize, new: &Document, node: usize) -> Result<(usize, bool)> {
    let mut a = old.chars(prior)?;
    let mut b = new.chars(node)?;
    let mut length = 0;
    while let Some(c) = a.next_scalar()? {
        if b.next_scalar()? != Some(c) {
            return Err(Error::Schema);
        }
        length += 1;
    }
    Ok((length, b.next_scalar()?.is_none()))
}

fn bytes_prefix(old: &Document, prior: usize, new: &Document, node: usize, prefix: usize) -> Result<(u64, bool)> {
    let mut a = old.decoded_bytes(prior)?;
    let mut b = new.decoded_bytes_after(node, prefix)?;
    let mut length = 0;
    while let Some(byte) = a.next_byte()? {
        if b.next_byte()? != Some(byte) {
            return Err(Error::Schema);
        }
        length += 1;
    }
    let equal = b.next_byte()?.is_none();
    while b.next_byte()?.is_some() {}
    Ok((length, equal))
}

pub(super) fn exact(old: &Document, prior: usize, new: &Document, node: usize, depth: usize) -> Result<bool> {
    if depth >= 128 {
        return Err(Error::Limit);
    }
    let a = old.node(prior)?.value;
    let b = new.node(node)?.value;
    if matches!(a, Value::Base64Fragments) {
        return Ok(bytes_prefix(old, prior, new, node, 0)?.1);
    }
    // Image data URLs contain a native prefix and separately decoded media bytes.
    if matches!(a, Value::Fragments)
        && let Some(prefix) = old.node(prior)?.first
        && let Some(binary) = old.node(prefix)?.next
        && matches!(old.node(binary)?.value, Value::Base64Fragments)
    {
        let (skip, _) = text_prefix(old, prefix, new, node)?;
        return Ok(bytes_prefix(old, binary, new, node, skip)?.1);
    }
    if is_string(a) && is_string(b) {
        let mut a = old.chars(prior)?;
        let mut b = new.chars(node)?;
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
    match (a, b) {
        (Value::Object, Value::Object) => {
            if old.children(prior)?.count() != new.children(node)?.count() {
                return Ok(false);
            }
            for field in new.children(node)? {
                let Some(previous) = matching_member(old, prior, new, field)? else {
                    return Ok(false);
                };
                if !exact(old, previous, new, field, depth + 1)? {
                    return Ok(false);
                }
            }
            Ok(true)
        }
        (Value::Array, Value::Array) => {
            let mut b = new.children(node)?;
            for a in old.children(prior)? {
                let Some(b) = b.next() else { return Ok(false) };
                if !exact(old, a, new, b, depth + 1)? {
                    return Ok(false);
                }
            }
            Ok(b.next().is_none())
        }
        (Value::Null, Value::Null) => Ok(true),
        (Value::Bool(a), Value::Bool(b)) => Ok(a == b),
        (Value::Unsigned(a), _) => Ok(new.unsigned(node).ok() == Some(a)),
        (_, Value::Unsigned(b)) => Ok(old.unsigned(prior).ok() == Some(b)),
        (Value::Number(a), Value::Number(b)) => {
            let mut a_bytes = old.source(a)?.cursor(a.span)?;
            let mut b_bytes = new.source(b)?.cursor(b.span)?;
            loop {
                let a = a_bytes.next_byte()?;
                if a != b_bytes.next_byte()? {
                    return Ok(false);
                }
                if a.is_none() {
                    return Ok(true);
                }
            }
        }
        _ => Ok(false),
    }
}

fn validate_message(owner: &mut Writer, doc: &Document, message: usize) -> Result<()> {
    if !matches!(doc.node(message)?.value, Value::Object) {
        return Err(Error::Schema);
    }
    for field in doc.children(message)? {
        let name = doc.node(field)?.name.ok_or(Error::Schema)?;
        if ["role", "refusal", "reasoning_content"]
            .iter()
            .any(|key| doc.name_is(name, key).unwrap_or(false))
        {
            if !matches!(doc.node(field)?.value, Value::Null) {
                doc.chars(field)?;
            }
        } else if doc.name_is(name, "content")? {
            if !matches!(doc.node(field)?.value, Value::Null | Value::Array) {
                doc.chars(field)?;
            }
        } else if doc.name_is(name, "tool_calls")? {
            if !matches!(doc.node(field)?.value, Value::Array) {
                return Err(Error::Schema);
            }
            for call in doc.children(field)? {
                if let Some(index) = doc.member(call, "index")? {
                    doc.unsigned(index)?;
                }
                if let Some(id) = doc.member(call, "id")? {
                    doc.chars(id)?;
                }
                if let Some(kind) = doc.member(call, "type")?
                    && !doc.string_is(kind, "function")?
                    && !doc.string_is(kind, "custom")?
                {
                    return Err(Error::Schema);
                }
                for key in ["function", "custom"] {
                    if let Some(function) = doc.member(call, key)? {
                        validate_function(doc, function)?;
                    }
                }
            }
        } else if doc.name_is(name, "function_call")? {
            validate_function(doc, field)?;
        } else if doc.name_is(name, "audio")? && matches!(doc.node(field)?.value, Value::Object) {
            if let Some(data) = doc.member(field, "data")? {
                let Value::String(text) = doc.node(data)?.value else {
                    return Err(Error::Schema);
                };
                media::decode_base64(doc, text, |_| Ok(()))?;
            }
            if let Some(text) = doc.member(field, "transcript")?
                && !matches!(doc.node(text)?.value, Value::Null)
            {
                doc.chars(text)?;
            }
        } else if (doc.name_is(name, "images")? || doc.name_is(name, "annotations")?)
            && !matches!(doc.node(field)?.value, Value::Array)
        {
            return Err(Error::Schema);
        }
        if (doc.name_is(name, "content")? || doc.name_is(name, "images")?)
            && matches!(doc.node(field)?.value, Value::Array)
        {
            for part in doc.children(field)? {
                if let Some(image) = doc.member(part, "image_url")?
                    && let Some(url) = doc.member(image, "url")?
                    && let Some((encoding, _)) = super::super::request_content::data_uri_metadata(doc, owner, url)?
                {
                    let Value::String(text) = doc.node(url)?.value else {
                        return Err(Error::Schema);
                    };
                    media::bytes(
                        doc,
                        media::Media {
                            node: url,
                            id: LocalId::new("validate")?,
                            data: Some(text),
                            encoding,
                            kind: "image",
                            mime: None,
                        },
                        |_| Ok(()),
                    )?;
                }
            }
        }
    }
    Ok(())
}

fn validate_function(doc: &Document, function: usize) -> Result<()> {
    if !matches!(doc.node(function)?.value, Value::Object) {
        return Err(Error::Schema);
    }
    for key in ["name", "arguments", "input"] {
        if let Some(value) = doc.member(function, key)? {
            doc.chars(value)?;
        }
    }
    Ok(())
}

fn validate_completion(
    owner: &mut Writer,
    old: &Document,
    prior: Option<usize>,
    new: &Document,
    message: usize,
) -> Result<()> {
    for (doc, body, other) in [(new, Some(message), None), (old, prior, Some((new, message)))] {
        let Some(body) = body else { continue };
        if let Some(function) = doc.member(body, "function_call")? {
            let replacement = other
                .map(|(new, message)| new.member(message, "function_call"))
                .transpose()?
                .flatten();
            if let Some(arguments) = doc.member(function, "arguments")? {
                let overridden = if let (Some((new, _)), Some(function)) = (other, replacement) {
                    new.member(function, "arguments")?.is_some()
                } else {
                    false
                };
                if !overridden {
                    validate_arguments(owner, doc, arguments)?;
                }
            }
        }
        if let Some(calls) = doc.member(body, "tool_calls")? {
            for call in doc.children(calls)? {
                let Some(function) = doc.member(call, "function")? else {
                    continue;
                };
                let Some(arguments) = doc.member(function, "arguments")? else {
                    continue;
                };
                let mut overridden = false;
                if let Some((new, message)) = other
                    && let Some(calls) = new.member(message, "tool_calls")?
                {
                    for candidate in new.children(calls)? {
                        let id_match = if let Some(id) = new.member(candidate, "id")? {
                            exact(doc, doc.required(call, "id")?, new, id, 0)?
                        } else {
                            false
                        };
                        let index_match = if let Some(index) = new.member(candidate, "index")? {
                            new.unsigned(index)? == doc.unsigned(doc.required(call, "index")?)?
                        } else {
                            false
                        };
                        if (id_match || index_match)
                            && let Some(function) = new.member(candidate, "function")?
                        {
                            overridden |= new.member(function, "arguments")?.is_some();
                        }
                    }
                }
                if !overridden {
                    validate_arguments(owner, doc, arguments)?;
                }
            }
        }
    }
    Ok(())
}

fn validate_arguments(owner: &mut Writer, doc: &Document, arguments: usize) -> Result<()> {
    let lease = encode::scratch(owner, |e| {
        let mut chars = doc.chars(arguments)?;
        while let Some(c) = chars.next_scalar()? {
            e.bytes(c.encode_utf8(&mut [0; 4]).as_bytes())?;
        }
        Ok(())
    })?;
    let mut source = Source::new(owner)?;
    source.push_scratch(lease)?;
    json::Scanner::new(owner, source.len())?.finish(&source)
}
