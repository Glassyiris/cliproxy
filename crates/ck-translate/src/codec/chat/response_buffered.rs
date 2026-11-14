use super::*;
use crate::codec::{
    document::pending::Pending,
    media::{Encoding, InputDecoder, Publisher},
    source::Span,
};

pub(super) struct Buffered {
    input: Pending,
    active: Option<usize>,
}

pub(super) struct Published {
    wire: usize,
    pub(super) value: usize,
    pub(super) scope: Scope,
    field: &'static str,
    scalar: bool,
    start: u64,
    offset: u64,
    decoder: InputDecoder,
    publisher: Publisher,
    complete: bool,
    ended: bool,
}

impl Buffered {
    pub(super) fn new(owner: &mut Writer, limit: u64) -> Result<Self> {
        Ok(Self {
            input: Pending::new(owner, limit)?,
            active: None,
        })
    }
    pub(super) fn advance(&mut self, owner: &mut Writer, state: &mut State, bytes: &[u8]) -> Result<()> {
        for bytes in bytes.chunks(8192) {
            self.input.advance(owner, bytes)?;
            if let Some(index) = self.active {
                self.collect(owner, state, index)?;
            }
            if self.active.is_none()
                && let Some(wire) = self.input.string
            {
                self.begin(owner, state, wire)?;
                if let Some(index) = self.active {
                    self.collect(owner, state, index)?;
                }
            }
        }
        Ok(())
    }
    pub(super) fn finish(mut self, owner: &mut Writer, state: &mut State) -> Result<()> {
        self.input.finish()?;
        if let Some(index) = self.active {
            self.collect(owner, state, index)?;
        }
        state.document(owner, &mut self.input.document, true, None)?;
        state.done(owner)
    }

    fn begin(&mut self, owner: &mut Writer, state: &mut State, wire: usize) -> Result<()> {
        let scanned = self.input.scanner.pending_node(self.input.document.input(), wire)?;
        let data = self.input.node(wire)?;
        let doc = &self.input.document;
        let Some(parent) = doc.node(data)?.parent else {
            return Ok(());
        };
        let name = doc.node(data)?.name.ok_or(Error::Schema)?;
        let mut target = None;
        if let Some(parent_name) = doc.node(parent)?.name {
            if doc.name_is(parent_name, "message")? {
                for field in ["content", "refusal", "reasoning_content"] {
                    if doc.name_is(name, field)? && scanned.validated_end - scanned.span.start > 1024 {
                        target = Some((data, parent, field, true));
                    }
                }
            } else if doc.name_is(parent_name, "audio")? && doc.name_is(name, "data")? {
                if let Some(message) = doc.node(parent)?.parent {
                    target = Some((parent, message, "audio", false));
                }
            } else if doc.name_is(parent_name, "image_url")?
                && doc.name_is(name, "url")?
                && let Some(part) = doc.node(parent)?.parent
                && let Some(array) = doc.node(part)?.parent
                && matches!(doc.node(array)?.value, Value::Array)
                && let Some(array_name) = doc.node(array)?.name
                && let Some(message) = doc.node(array)?.parent
            {
                if doc.name_is(array_name, "images")? {
                    target = Some((part, message, "images", false));
                } else if doc.name_is(array_name, "content")?
                    && let Some(kind) = doc.member(part, "type")?
                    && doc.string_is(kind, "image_url")?
                {
                    target = Some((part, message, "content", false));
                }
            }
        }
        let Some((value, message, field, scalar)) = target else {
            return Ok(());
        };
        let Some(message_name) = doc.node(message)?.name else {
            return Ok(());
        };
        if !doc.name_is(message_name, "message")? {
            return Ok(());
        }
        let Some(choice) = doc.node(message)?.parent else {
            return Ok(());
        };
        let Some(choices) = doc.node(choice)?.parent else {
            return Ok(());
        };
        if doc.node(choices)?.parent != Some(doc.root()) || !matches!(doc.node(choices)?.value, Value::Array) {
            return Ok(());
        }
        if !doc.name_is(doc.node(choices)?.name.ok_or(Error::Schema)?, "choices")? {
            return Ok(());
        }
        let Some(index) = doc.member(choice, "index")? else {
            return Ok(());
        };
        let index = doc.unsigned(index)?;
        let (encoding, mime) = if scalar {
            (Encoding::Utf8, None)
        } else if field == "audio" {
            (Encoding::Base64, None)
        } else {
            match media::data_uri_prefix(
                owner,
                doc.input(),
                Span {
                    start: scanned.span.start + 1,
                    end: scanned.validated_end,
                },
            )? {
                media::DataUriPrefix::Incomplete | media::DataUriPrefix::Plain => return Ok(()),
                media::DataUriPrefix::Encoded { encoding, mime } => (encoding, Some(mime)),
            }
        };
        let mime = mime
            .map(|lease| self.input.document.import_json(owner, lease))
            .transpose()?;
        let doc = &self.input.document;
        state.ensure_start(owner, Some(doc))?;
        let position = state.choice(owner, index)?;
        let mut scope = state.scope(position);
        if scalar {
            let block = match field {
                "content" => 0,
                "reasoning_content" => 1,
                _ => 2,
            };
            scope.block_index = Some(block as u64);
            state.emitter.emit(
                owner,
                Kind::BlockStart,
                scope,
                |e| {
                    e.bytes(b",\"kind\":")?;
                    e.string(["text", "thinking", "refusal"][block])
                },
                |_| Ok(()),
            )?;
            state.choices[position].blocks[block] = true;
        } else if field != "audio" {
            scope.block_index = Some(state.choices[position].next_block);
            state.choices[position].next_block += 1;
            state.emitter.emit(
                owner,
                Kind::BlockStart,
                scope,
                |e| e.bytes(b",\"kind\":\"content\""),
                |_| Ok(()),
            )?;
        }
        scope.media_id = Some(media::local_id(b'm', state.serial)?);
        state.serial = state.serial.checked_add(1).ok_or(Error::Limit)?;
        let publisher = Publisher::start(&mut state.emitter, owner, scope, |e| {
            e.bytes(b",\"kind\":")?;
            e.string(if scalar {
                "text"
            } else if field == "audio" {
                "audio"
            } else {
                "image"
            })?;
            e.bytes(b",\"encoding\":\"base64\"")?;
            if let Some(mime) = mime {
                e.bytes(b",\"mime\":")?;
                doc.write(mime, e)?;
            }
            if scalar {
                e.bytes(b",\"mime\":\"text/plain;charset=utf-8\"")?;
            }
            e.bytes(b",\"attributes\":{\"field\":")?;
            e.string(field)?;
            if scalar {
                e.bytes(b",\"scalar\":true,\"value\":null}")
            } else if field == "audio" {
                e.bytes(b",\"value\":{\"data\":null}}")
            } else {
                e.bytes(b",\"value\":{\"image_url\":{\"url\":null}}}")
            }
        })?;
        self.input.document.replace(data, Value::Null)?;
        self.active = Some(state.published.push(Published {
            wire,
            value,
            scope,
            field,
            scalar,
            start: scanned.span.start + 1,
            offset: scanned.span.start + 1,
            decoder: InputDecoder::new(encoding),
            publisher,
            complete: false,
            ended: false,
        })?);
        Ok(())
    }

    fn collect(&mut self, owner: &mut Writer, state: &mut State, index: usize) -> Result<()> {
        let published = &mut state.published[index];
        let wire = self
            .input
            .scanner
            .pending_node(self.input.document.input(), published.wire)?;
        let mut chars = json::Decoded::fragment(
            self.input.document.input(),
            Span {
                start: published.offset,
                end: wire.validated_end,
            },
        )?;
        let mut chunk = [0; 36_864];
        let mut used = 0;
        while let Some(c) = chars.next_scalar()? {
            published.decoder.push(c, |bytes| {
                if used + bytes.len() > chunk.len() {
                    return Err(Error::Limit);
                }
                chunk[used..used + bytes.len()].copy_from_slice(bytes);
                used += bytes.len();
                Ok(())
            })?;
        }
        if used != 0 {
            published.publisher.append(&chunk[..used], &mut state.emitter, owner)?;
        }
        published.offset = wire.validated_end;
        self.input.document.release_input_range(Span {
            start: published.start,
            end: published.offset,
        })?;
        if wire.span.end != 0 {
            if !published.decoder.complete() {
                return Err(Error::Schema);
            }
            published.complete = true;
            self.active = None;
        }
        Ok(())
    }
}

impl State {
    pub(super) fn published_scope(&self, value: usize) -> Option<Scope> {
        self.published
            .iter()
            .find(|entry| entry.value == value && !entry.ended)
            .map(|entry| entry.scope)
    }
    pub(super) fn finish_published(&mut self, owner: &mut Writer, doc: &Document, value: usize) -> Result<bool> {
        let Some(index) = self
            .published
            .iter()
            .position(|entry| entry.value == value && !entry.ended)
        else {
            return Ok(false);
        };
        let entry = &mut self.published[index];
        if !entry.complete {
            return Err(Error::Truncated);
        }
        if !entry.scalar {
            let transcript = if entry.field == "audio" {
                doc.member(value, "transcript")?
                    .filter(|node| !matches!(doc.node(*node).map(|n| n.value), Ok(Value::Null)))
            } else {
                None
            };
            if let Some(text) = transcript {
                super::super::request::require_string(doc, text)?;
            }
            self.emitter.emit(
                owner,
                Kind::Opaque,
                entry.scope,
                |e| {
                    e.bytes(b",\"name\":\"chat.media.attributes\",\"format\":\"json\",\"value\":")?;
                    if transcript.is_some() {
                        e.bytes(b"{\"data\":null")?;
                        members(doc, value, e, &["data", "transcript"])?;
                        e.bytes(b"}")
                    } else {
                        doc.write(value, e)
                    }
                },
                |_| Ok(()),
            )?;
            if let Some(text) = transcript {
                self.emitter.emit(
                    owner,
                    Kind::MediaTranscript,
                    entry.scope,
                    |e| {
                        e.bytes(b",\"text\":")?;
                        doc.write(text, e)?;
                        e.bytes(b",\"final\":true")
                    },
                    |_| Ok(()),
                )?;
            }
        }
        entry.publisher.end(&mut self.emitter, owner)?;
        entry.ended = true;
        Ok(true)
    }
}
