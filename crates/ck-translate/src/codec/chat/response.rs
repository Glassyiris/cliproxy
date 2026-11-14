use super::accounting::Accounting;
use crate::codec::{
    self, BodyMode, Error, Operation, Result,
    document::{Document, Value},
    encode::{self, Encoder},
    event::{Emitter, Identity, Kind, LocalId, Scope},
    json, media,
    source::Source,
    sse,
    table::Table,
};
use ck_stream::Writer;
#[path = "response_buffered.rs"]
mod buffered;
#[path = "response_media.rs"]
mod media_events;

pub struct Ingress {
    owner: u64,
    source: Option<Source>,
    sse: Option<sse::Scanner>,
    buffered: Option<buffered::Buffered>,
    state: State,
    failed: bool,
}

impl Ingress {
    pub fn new(
        owner: &mut Writer,
        identity: Identity,
        operation: Operation,
        mode: BodyMode,
        limit: u64,
    ) -> Result<Self> {
        if operation != Operation::Generate {
            return Err(Error::Unsupported);
        }
        Ok(Self {
            owner: owner.id(),
            source: if mode == BodyMode::Streaming {
                Some(Source::new(owner)?)
            } else {
                None
            },
            sse: if mode == BodyMode::Streaming {
                Some(sse::Scanner::new(owner, limit)?)
            } else {
                None
            },
            buffered: if mode == BodyMode::Buffered {
                Some(buffered::Buffered::new(owner, limit)?)
            } else {
                None
            },
            state: State {
                emitter: Emitter::new(identity),
                base: None,
                choices: Table::new(owner)?,
                usage: Accounting::default(),
                terminal: false,
                identity,
                serial: 0,
                published: Table::new(owner)?,
            },

            failed: false,
        })
    }
}
impl codec::ResponseIngress for Ingress {
    fn advance(&mut self, owner: &mut Writer, bytes: &[u8]) -> Result<()> {
        if owner.id() != self.owner {
            return Err(Error::Position);
        }
        if self.failed || self.state.terminal {
            return Err(Error::Closed);
        }
        let result = (|| {
            if let Some(buffered) = &mut self.buffered {
                buffered.advance(owner, &mut self.state, bytes)?;
            } else {
                let source = self.source.as_mut().ok_or(Error::Closed)?;
                source.push_bytes(owner, bytes)?;
                let scanner = self.sse.as_mut().ok_or(Error::Closed)?;
                let state = &mut self.state;
                scanner.advance(source, |event| state.event(owner, source, event))?;
                source.release_before(scanner.consumed())?;
            }
            Ok(())
        })();
        self.handle(owner, result)
    }
    fn finish(&mut self, owner: &mut Writer) -> Result<()> {
        if owner.id() != self.owner {
            return Err(Error::Position);
        }
        if self.failed {
            return Err(Error::Closed);
        }
        let result = (|| {
            if let Some(scanner) = &mut self.sse {
                let source = self.source.as_ref().ok_or(Error::Closed)?;
                let state = &mut self.state;
                scanner.finish(source, |event| state.event(owner, source, event))?;
                if !state.terminal {
                    return Err(Error::Truncated);
                }
            } else {
                self.buffered
                    .take()
                    .ok_or(Error::Closed)?
                    .finish(owner, &mut self.state)?;
            }
            Ok(())
        })();
        self.handle(owner, result)
    }
}
impl Ingress {
    fn handle(&mut self, owner: &mut Writer, result: Result<()>) -> Result<()> {
        if let Err(error) = result {
            self.failed = true;
            if !self.state.terminal && !matches!(error, Error::Storage(_)) {
                self.state.emit_usage(owner, true)?;
                super::failure(&mut self.state.emitter, owner, "upstream")?;
                self.state.terminal = true;
            }
            return Err(error);
        }
        Ok(())
    }
}

struct Choice {
    index: u64,
    item: LocalId,
    blocks: [bool; 3],
    next_block: u64,
    audio: media::Base64Fragments,
    tools: Table<Tool>,
    usage: Accounting,
    finished: bool,
}
struct Tool {
    index: u64,
    id: LocalId,
    metadata: Document,
    arguments: Option<Source>,
    parser: Option<json::Scanner>,
    custom: bool,
    legacy: bool,
}
struct State {
    emitter: Emitter,
    base: Option<Document>,
    choices: Table<Choice>,
    usage: Accounting,
    terminal: bool,
    identity: Identity,
    serial: u64,
    published: Table<buffered::Published>,
}

pub(super) fn mapped_document(
    owner: &mut Writer,
    write: impl Fn(&mut Encoder<'_, '_>) -> Result<()>,
) -> Result<Document> {
    let lease = encode::scratch(owner, write)?;
    let mut source = Source::new(owner)?;
    source.push_scratch(lease)?;
    let len = source.len();
    Document::parse(owner, source, len)
}

impl State {
    fn event(&mut self, owner: &mut Writer, source: &Source, event: &sse::Event) -> Result<()> {
        if self.terminal {
            return Err(Error::Closed);
        }
        if !event.has_data(source)? {
            if !event.fields().is_empty() {
                self.ensure_start(owner, None)?;
                self.emitter.emit(
                    owner,
                    Kind::Heartbeat,
                    Scope::default(),
                    |_| Ok(()),
                    |e| sse_provenance(source, event, e),
                )?;
            }
            return Ok(());
        }
        let name = event.name(source)?;
        let known = name.is_none() || name.is_some_and(|span| source.equals(span, b"message").unwrap_or(false));
        let error_event = name.is_some_and(|span| source.equals(span, b"error").unwrap_or(false));
        let lease = encode::scratch(owner, |e| event.write_data(source, |b| e.bytes(b)))?;
        let mut data = Source::new(owner)?;
        data.push_scratch(lease)?;
        if known && data.equals(data.whole(), b"[DONE]")? {
            return self.done(owner);
        }
        if !known && !error_event {
            self.ensure_start(owner, None)?;
            let length = data.len();
            match Document::parse(owner, data, length) {
                Ok(doc) => {
                    self.emitter.emit(
                        owner,
                        Kind::Opaque,
                        Scope::default(),
                        |e| {
                            e.bytes(b",\"format\":\"json\",\"value\":")?;
                            doc.write(doc.root(), e)
                        },
                        |e| sse_provenance(source, event, e),
                    )?;
                }
                Err(Error::Json | Error::Truncated) => {
                    self.emitter.emit(
                        owner,
                        Kind::Opaque,
                        Scope::default(),
                        |e| {
                            e.bytes(b",\"format\":\"text\",\"value\":")?;
                            e.quoted_json(|e| event.write_data(source, |b| e.bytes(b)))
                        },
                        |e| sse_provenance(source, event, e),
                    )?;
                }
                Err(error) => return Err(error),
            }
            return Ok(());
        }
        let length = data.len();
        let doc = Document::parse(owner, data, length)?;
        if error_event || doc.member(doc.root(), "error")?.is_some() {
            return Err(Error::Schema);
        }
        self.document(owner, &doc, false, Some((source, event)))
    }

    fn ensure_start(&mut self, owner: &mut Writer, doc: Option<&Document>) -> Result<()> {
        const FIELDS: [&str; 5] = ["id", "model", "created", "system_fingerprint", "service_tier"];
        if let Some(base) = &self.base {
            let Some(doc) = doc else {
                return Ok(());
            };
            let mut changed = false;
            for name in FIELDS {
                if let Some(incoming) = doc.member(doc.root(), name)? {
                    changed |= match base.member(base.root(), name)? {
                        Some(current) => match (base.node(current)?.value, doc.node(incoming)?.value) {
                            (Value::Null, Value::Null) => false,
                            (Value::Null, _) | (_, Value::Null) => true,
                            _ if name == "created" => base.unsigned(current)? != doc.unsigned(incoming)?,
                            _ => !equal(base, current, doc, incoming)?,
                        },
                        None => true,
                    };
                }
            }
            if !changed {
                return Ok(());
            }
        }
        let local = self.identity.stream_id;
        let created = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| Error::Schema)?
            .as_secs();
        let base = mapped_document(owner, |e| {
            e.bytes(b"{")?;
            let mut first = true;
            for (index, name) in FIELDS.iter().enumerate() {
                let mut supplied = None;
                for source in [doc, self.base.as_ref()].into_iter().flatten() {
                    if let Some(node) = source.member(source.root(), name)? {
                        supplied = Some((source, node));
                        break;
                    }
                }
                if supplied.is_none() && index >= 3 {
                    continue;
                }
                if !first {
                    e.bytes(b",")?;
                }
                first = false;
                e.string(name)?;
                e.bytes(b":")?;
                if let Some((source, node)) = supplied {
                    source.write(node, e)?;
                } else {
                    match *name {
                        "id" => e.string(local.as_str())?,
                        "model" => e.string("")?,
                        _ => e.unsigned(created)?,
                    }
                }
            }
            e.bytes(b"}")
        })?;
        if self.base.is_none() {
            self.emitter.emit(
                owner,
                Kind::ResponseStart,
                Scope::default(),
                |e| members(&base, base.root(), e, &[]),
                |_| Ok(()),
            )?;
        }
        self.base = Some(base);
        Ok(())
    }

    fn document(
        &mut self,
        owner: &mut Writer,
        doc: &Document,
        buffered: bool,
        wire: Option<(&Source, &sse::Event)>,
    ) -> Result<()> {
        if self.terminal {
            return Err(Error::Closed);
        }
        if doc.member(doc.root(), "error")?.is_some() {
            return Err(Error::Schema);
        }
        self.ensure_start(owner, Some(doc))?;
        // A separate metadata chunk retains root extensions and source framing once, even
        // when one source record splits into many independent choices and tool deltas.
        self.emitter.emit(
            owner,
            Kind::Chunk,
            Scope::default(),
            |e| {
                base(self.base.as_ref().ok_or(Error::Schema)?, e)?;
                e.bytes(b",\"choices\":[]")
            },
            |e| {
                if let Some((source, event)) = wire {
                    sse_provenance(source, event, e)?;
                }
                super::provenance::unknown(
                    doc,
                    doc.root(),
                    &[
                        "id",
                        "model",
                        "created",
                        "object",
                        "choices",
                        "usage",
                        "system_fingerprint",
                        "service_tier",
                    ],
                    e,
                )
            },
        )?;
        let choices = doc.required(doc.root(), "choices")?;
        if !matches!(doc.node(choices)?.value, Value::Array) {
            return Err(Error::Schema);
        }
        for choice in doc.children(choices)? {
            let index = doc.unsigned(doc.required(choice, "index")?)?;
            let position = self.choice(owner, index)?;
            if self.choices[position].finished {
                return Err(Error::Schema);
            }
            let body = doc.member(choice, if buffered { "message" } else { "delta" })?;
            if let Some(body) = body {
                self.delta(owner, doc, choice, body, position, buffered)?;
            } else if !buffered && doc.member(choice, "message")?.is_some() {
                return Err(Error::Schema);
            }
            if let Some(logprobs) = doc.member(choice, "logprobs")? {
                let scope = self.scope(position);
                self.emitter.emit(
                    owner,
                    Kind::Chunk,
                    scope,
                    |e| {
                        base(self.base.as_ref().ok_or(Error::Schema)?, e)?;
                        e.bytes(b",\"choices\":[{\"index\":")?;
                        e.unsigned(index)?;
                        e.bytes(b",\"delta\":{},\"finish_reason\":null,\"logprobs\":")?;
                        doc.write(logprobs, e)?;
                        e.bytes(b"}]")
                    },
                    |_| Ok(()),
                )?;
            }
            if let Some(usage) = doc.member(choice, "usage")? {
                let scope = self.scope(position);
                self.choices[position].usage.update(owner, doc, usage)?;
                self.choices[position]
                    .usage
                    .emit(owner, &mut self.emitter, scope, false)?;
            }
            for field in doc.children(choice)? {
                let name = doc.node(field)?.name.ok_or(Error::Schema)?;
                let mut known = false;
                for key in ["index", "delta", "message", "finish_reason", "logprobs", "usage"] {
                    known |= doc.name_is(name, key)?;
                }
                if !known {
                    self.emitter.emit(
                        owner,
                        Kind::Chunk,
                        self.scope(position),
                        |e| {
                            base(self.base.as_ref().ok_or(Error::Schema)?, e)?;
                            e.bytes(b",\"choices\":[{\"index\":")?;
                            e.unsigned(index)?;
                            e.bytes(b",\"delta\":{},\"finish_reason\":null}]")
                        },
                        |e| super::provenance::one(doc, field, e),
                    )?;
                }
            }
            if let Some(finish) = doc.member(choice, "finish_reason")? {
                if !matches!(doc.node(finish)?.value, Value::Null) {
                    self.finish_choice(owner, doc, finish, position)?;
                } else if buffered {
                    return Err(Error::Truncated);
                }
            } else if buffered {
                return Err(Error::Truncated);
            }
        }
        if let Some(usage) = doc.member(doc.root(), "usage")? {
            self.usage.update(owner, doc, usage)?;
            self.usage.emit(owner, &mut self.emitter, Scope::default(), false)?;
        }
        Ok(())
    }

    fn choice(&mut self, owner: &mut Writer, index: u64) -> Result<usize> {
        if let Some(position) = self.choices.iter().position(|choice| choice.index == index) {
            return Ok(position);
        }
        let item = media::local_id(b'i', self.serial)?;
        self.serial += 1;
        let position = self.choices.push(Choice {
            index,
            item,
            blocks: [false; 3],
            next_block: 3,
            audio: media::Base64Fragments::default(),
            tools: Table::new(owner)?,
            usage: Accounting::default(),
            finished: false,
        })?;
        self.emitter.emit(
            owner,
            Kind::ItemStart,
            self.scope(position),
            |e| e.bytes(b",\"kind\":\"message\""),
            |_| Ok(()),
        )?;
        Ok(position)
    }
    fn scope(&self, position: usize) -> Scope {
        Scope {
            choice_index: Some(self.choices[position].index),
            item_id: Some(self.choices[position].item),
            ..Scope::default()
        }
    }
    fn delta(
        &mut self,
        owner: &mut Writer,
        doc: &Document,
        _choice: usize,
        body: usize,
        position: usize,
        buffered: bool,
    ) -> Result<()> {
        if !matches!(doc.node(body)?.value, Value::Object) {
            return Err(Error::Schema);
        }
        for field in doc.children(body)? {
            if buffered && self.finish_published(owner, doc, field)? {
                continue;
            }
            let name = doc.node(field)?.name.ok_or(Error::Schema)?;
            if doc.name_is(name, "audio")?
                && matches!(doc.node(field)?.value, Value::Object)
                && self.media_value(owner, doc, field, self.scope(position), "audio")?
            {
                continue;
            }
            if doc.name_is(name, "images")?
                || (doc.name_is(name, "content")? && matches!(doc.node(field)?.value, Value::Array))
            {
                let name = if doc.name_is(name, "images")? {
                    "images"
                } else {
                    "content"
                };
                self.array_field(owner, doc, field, position, name)?;
                continue;
            }
            if doc.name_is(name, "annotations")? && matches!(doc.node(field)?.value, Value::Array) {
                self.annotations(owner, doc, field, position)?;
                continue;
            }
            if doc.name_is(name, "tool_calls")? {
                if !matches!(doc.node(field)?.value, Value::Array) {
                    return Err(Error::Schema);
                }
                for (index, call) in doc.children(field)?.enumerate() {
                    self.tool(
                        owner,
                        doc,
                        call,
                        position,
                        if buffered { Some(index as u64) } else { None },
                        None,
                    )?;
                }
                continue;
            }
            if doc.name_is(name, "function_call")? {
                self.legacy_tool(owner, doc, field, position)?;
                continue;
            }
            let mut known = false;
            for key in [
                "role",
                "content",
                "reasoning_content",
                "refusal",
                "audio",
                "annotations",
            ] {
                known |= doc.name_is(name, key)?;
            }
            if !known {
                self.emitter.emit(
                    owner,
                    Kind::Chunk,
                    self.scope(position),
                    |e| {
                        base(self.base.as_ref().ok_or(Error::Schema)?, e)?;
                        e.bytes(b",\"choices\":[{\"index\":")?;
                        e.unsigned(self.choices[position].index)?;
                        e.bytes(b",\"delta\":{},\"finish_reason\":null}]")
                    },
                    |e| super::provenance::one(doc, field, e),
                )?;
                continue;
            }
            let mut scope = self.scope(position);
            for (block, key) in ["content", "reasoning_content", "refusal"].iter().enumerate() {
                if doc.name_is(name, key)? && !matches!(doc.node(field)?.value, Value::Null) {
                    if !matches!(doc.node(field)?.value, Value::String(_) | Value::Text(_)) {
                        return Err(Error::Schema);
                    }
                    scope.block_index = Some(block as u64);
                    if !self.choices[position].blocks[block] {
                        self.emitter.emit(
                            owner,
                            Kind::BlockStart,
                            scope,
                            |e| {
                                e.bytes(b",\"kind\":")?;
                                e.string(["text", "thinking", "refusal"][block])
                            },
                            |_| Ok(()),
                        )?;
                        self.choices[position].blocks[block] = true;
                    }
                }
            }
            self.emitter.emit(
                owner,
                Kind::Chunk,
                scope,
                |e| {
                    base(self.base.as_ref().ok_or(Error::Schema)?, e)?;
                    e.bytes(b",\"choices\":[{\"index\":")?;
                    e.unsigned(self.choices[position].index)?;
                    e.bytes(b",\"delta\":{")?;
                    doc.write_name(name, e)?;
                    e.bytes(b":")?;
                    doc.write(field, e)?;
                    e.bytes(b"},\"finish_reason\":null}]")
                },
                |_| Ok(()),
            )?;
        }
        Ok(())
    }

    fn legacy_tool(&mut self, owner: &mut Writer, doc: &Document, function: usize, position: usize) -> Result<()> {
        let synthetic = media::local_id(b'l', self.choices[position].index)?;
        let call = mapped_document(owner, |e| {
            e.bytes(b"{\"index\":0,\"id\":")?;
            e.string(synthetic.as_str())?;
            e.bytes(b",\"type\":\"function\",\"function\":")?;
            doc.write(function, e)?;
            e.bytes(b"}")
        })?;
        self.tool(owner, &call, call.root(), position, None, Some((doc, function)))
    }
    fn tool(
        &mut self,
        owner: &mut Writer,
        doc: &Document,
        call: usize,
        position: usize,
        buffered_index: Option<u64>,
        original: Option<(&Document, usize)>,
    ) -> Result<()> {
        let legacy = original.is_some();
        let index = if let Some(node) = doc.member(call, "index")? {
            doc.unsigned(node)?
        } else {
            buffered_index.ok_or(Error::Schema)?
        };
        let existing = self.choices[position].tools.iter().position(|tool| tool.index == index);
        let tool_position = if let Some(existing) = existing {
            existing
        } else {
            let custom = doc
                .member(call, "type")?
                .map(|n| doc.string_is(n, "custom"))
                .transpose()?
                .unwrap_or(false);
            let function = doc.required(call, if custom { "custom" } else { "function" })?;
            let name = doc.required(function, "name")?;
            let call_id = doc.required(call, "id")?;
            let metadata = mapped_document(owner, |e| {
                e.bytes(b"{\"name\":")?;
                doc.write(name, e)?;
                e.bytes(b",\"id\":")?;
                doc.write(call_id, e)?;
                e.bytes(b",\"custom\":")?;
                e.bytes(if custom { b"true" } else { b"false" })?;
                e.bytes(b"}")
            })?;
            let id = media::local_id(b't', self.serial)?;
            self.serial += 1;
            let mut scope = self.scope(position);
            scope.tool_index = Some(index);
            scope.tool_call_id = Some(id);
            self.emitter.emit(
                owner,
                Kind::ToolStart,
                scope,
                |e| {
                    e.bytes(b",\"name\":")?;
                    doc.write(name, e)?;
                    e.bytes(if custom {
                        b",\"kind\":\"custom\",\"arguments_format\":\"text\""
                    } else {
                        b",\"kind\":\"function\",\"arguments_format\":\"json\""
                    })
                },
                |e| {
                    e.bytes(b",\"source\":{\"protocol\":\"chat\",\"ids\":{\"id\":")?;
                    doc.write(call_id, e)?;
                    e.bytes(b"}}")?;
                    if legacy {
                        e.bytes(b",\"chat_legacy\":true")?;
                    }
                    Ok(())
                },
            )?;
            self.choices[position].tools.push(Tool {
                index,
                id,
                metadata,
                arguments: None,
                parser: None,
                custom,
                legacy,
            })?
        };
        let mut scope = self.scope(position);
        let tool = &mut self.choices[position].tools[tool_position];
        if tool.legacy != legacy {
            return Err(Error::Schema);
        }
        scope.tool_index = Some(index);
        scope.tool_call_id = Some(tool.id);
        if let Some(id) = doc.member(call, "id")?
            && !equal(
                doc,
                id,
                &tool.metadata,
                tool.metadata.required(tool.metadata.root(), "id")?,
            )?
        {
            return Err(Error::Schema);
        }
        if let Some(kind) = doc.member(call, "type")?
            && !doc.string_is(kind, if tool.custom { "custom" } else { "function" })?
        {
            return Err(Error::Schema);
        }
        if let Some(function) = doc.member(call, if tool.custom { "custom" } else { "function" })? {
            if let Some(name) = doc.member(function, "name")?
                && !equal(
                    doc,
                    name,
                    &tool.metadata,
                    tool.metadata.required(tool.metadata.root(), "name")?,
                )?
            {
                return Err(Error::Schema);
            }
            if let Some(arguments) = doc.member(function, if tool.custom { "input" } else { "arguments" })? {
                let Value::String(text) = doc.node(arguments)?.value else {
                    return Err(Error::Schema);
                };
                self.emitter.emit(
                    owner,
                    Kind::Chunk,
                    scope,
                    |e| {
                        base(self.base.as_ref().ok_or(Error::Schema)?, e)?;
                        e.bytes(b",\"choices\":[{\"index\":")?;
                        e.unsigned(scope.choice_index.ok_or(Error::Schema)?)?;
                        e.bytes(b",\"delta\":{\"tool_calls\":[{\"index\":")?;
                        e.unsigned(index)?;
                        e.bytes(b",\"function\":{\"arguments\":")?;
                        doc.write(arguments, e)?;
                        e.bytes(b"}}]},\"finish_reason\":null}]")
                    },
                    |_| Ok(()),
                )?;
                if !tool.custom {
                    if tool.arguments.is_none() {
                        tool.arguments = Some(Source::new(owner)?);
                        tool.parser = Some(json::Scanner::new(owner, u64::MAX)?);
                    }
                    let length = text.span.len();
                    if length > 2 {
                        let lease = encode::scratch(owner, |e| {
                            let mut decoded = doc.chars(arguments)?;
                            while let Some(c) = decoded.next_scalar()? {
                                e.bytes(c.encode_utf8(&mut [0; 4]).as_bytes())?;
                            }
                            Ok(())
                        })?;
                        tool.arguments.as_mut().ok_or(Error::Schema)?.push_scratch(lease)?;
                    }
                    tool.parser
                        .as_mut()
                        .ok_or(Error::Schema)?
                        .advance(tool.arguments.as_ref().ok_or(Error::Schema)?)?;
                }
            }
            for (ordinal, field) in doc.children(function)?.enumerate() {
                let name = doc.node(field)?.name.ok_or(Error::Schema)?;
                if doc.name_is(name, "name")? || doc.name_is(name, if tool.custom { "input" } else { "arguments" })? {
                    continue;
                }
                let (source, field) = if let Some((source, function)) = original {
                    (source, source.children(function)?.nth(ordinal).ok_or(Error::Schema)?)
                } else {
                    (doc, field)
                };
                preserved_tool_field(
                    &mut self.emitter,
                    owner,
                    self.base.as_ref().ok_or(Error::Schema)?,
                    source,
                    field,
                    scope,
                    true,
                )?;
            }
        }
        for field in doc.children(call)? {
            let name = doc.node(field)?.name.ok_or(Error::Schema)?;
            let mut known = false;
            for key in ["index", "id", "type", "function", "custom"] {
                known |= doc.name_is(name, key)?;
            }
            if !known {
                preserved_tool_field(
                    &mut self.emitter,
                    owner,
                    self.base.as_ref().ok_or(Error::Schema)?,
                    doc,
                    field,
                    scope,
                    false,
                )?;
            }
        }
        Ok(())
    }
    fn finish_choice(&mut self, owner: &mut Writer, doc: &Document, finish: usize, position: usize) -> Result<()> {
        if !self.choices[position].audio.complete() {
            return Err(Error::Truncated);
        }
        let scope = self.scope(position);
        let incomplete = doc.string_is(finish, "length")? || doc.string_is(finish, "content_filter")?;
        // Validate every tool before publishing any successful close for this choice.
        for tool in self.choices[position].tools.iter_mut() {
            if let (Some(parser), Some(arguments)) = (&mut tool.parser, &tool.arguments)
                && let Err(error) = parser.finish(arguments)
                && !incomplete
            {
                return Err(error);
            }
        }
        for tool in self.choices[position].tools.iter_mut() {
            let mut tool_scope = scope;
            tool_scope.tool_index = Some(tool.index);
            tool_scope.tool_call_id = Some(tool.id);
            let valid = tool.parser.as_ref().map(|parser| parser.is_finished());
            self.emitter.emit(
                owner,
                Kind::ToolEnd,
                tool_scope,
                |e| {
                    e.bytes(if incomplete {
                        b",\"status\":\"incomplete\""
                    } else {
                        b",\"status\":\"completed\""
                    })?;
                    if let Some(valid) = valid {
                        e.bytes(b",\"valid_json\":")?;
                        e.bytes(if valid { b"true" } else { b"false" })?;
                    }
                    Ok(())
                },
                |_| Ok(()),
            )?;
            tool.arguments = None;
            tool.parser = None;
        }
        for (block, opened) in self.choices[position].blocks.iter_mut().enumerate() {
            if *opened {
                let mut block_scope = scope;
                block_scope.block_index = Some(block as u64);
                self.emitter
                    .emit(owner, Kind::BlockEnd, block_scope, |_| Ok(()), |_| Ok(()))?;
                *opened = false;
            }
        }
        self.emitter.emit(
            owner,
            Kind::ItemEnd,
            scope,
            |e| {
                e.bytes(if incomplete {
                    b",\"status\":\"incomplete\""
                } else {
                    b",\"status\":\"completed\""
                })
            },
            |_| Ok(()),
        )?;
        self.emitter.emit(
            owner,
            Kind::Chunk,
            scope,
            |e| {
                base(self.base.as_ref().ok_or(Error::Schema)?, e)?;
                e.bytes(b",\"choices\":[{\"index\":")?;
                e.unsigned(scope.choice_index.ok_or(Error::Schema)?)?;
                e.bytes(b",\"delta\":{},\"finish_reason\":")?;
                doc.write(finish, e)?;
                e.bytes(b"}]")
            },
            |e| {
                e.bytes(b",\"native_finish_reason\":")?;
                doc.write(finish, e)
            },
        )?;
        self.choices[position].finished = true;
        Ok(())
    }
    fn emit_usage(&mut self, owner: &mut Writer, final_snapshot: bool) -> Result<()> {
        for choice in self.choices.iter_mut() {
            let scope = Scope {
                choice_index: Some(choice.index),
                item_id: Some(choice.item),
                ..Scope::default()
            };
            choice.usage.emit(owner, &mut self.emitter, scope, final_snapshot)?;
        }
        self.usage
            .emit(owner, &mut self.emitter, Scope::default(), final_snapshot)?;
        Ok(())
    }
    fn done(&mut self, owner: &mut Writer) -> Result<()> {
        if self.terminal || self.choices.is_empty() || self.choices.iter().any(|choice| !choice.finished) {
            return Err(Error::Truncated);
        }
        self.emit_usage(owner, true)?;
        self.emitter
            .emit(owner, Kind::Done, Scope::default(), |_| Ok(()), |_| Ok(()))?;
        self.terminal = true;
        Ok(())
    }
}

pub(super) fn base(doc: &Document, e: &mut Encoder<'_, '_>) -> Result<()> {
    members(doc, doc.root(), e, &[])?;
    e.bytes(b",\"object\":\"chat.completion.chunk\"")
}
pub(super) fn members(doc: &Document, object: usize, e: &mut Encoder<'_, '_>, skip: &[&str]) -> Result<()> {
    for child in doc.children(object)? {
        let name = doc.node(child)?.name.ok_or(Error::Schema)?;
        let mut omitted = false;
        for key in skip {
            omitted |= doc.name_is(name, key)?;
        }
        if !omitted {
            e.bytes(b",")?;
            doc.write_name(name, e)?;
            e.bytes(b":")?;
            doc.write(child, e)?;
        }
    }
    Ok(())
}
fn sse_provenance(source: &Source, event: &sse::Event, e: &mut Encoder<'_, '_>) -> Result<()> {
    e.bytes(b",\"source\":{\"protocol\":\"chat\",\"sse\":[")?;
    let mut first = true;
    for field in event.fields() {
        if !field.comment && source.equals(field.name, b"data")? {
            continue;
        }
        if !first {
            e.bytes(b",")?;
        }
        first = false;
        e.bytes(b"{\"name\":")?;
        e.quoted_json(|e| e.span(source, field.name))?;
        e.bytes(b",\"value\":")?;
        e.quoted_json(|e| e.span(source, field.value))?;
        e.bytes(b",\"comment\":")?;
        e.bytes(if field.comment { b"true" } else { b"false" })?;
        e.bytes(b"}")?;
    }
    e.bytes(b"]}")
}
fn equal(a: &Document, ai: usize, b: &Document, bi: usize) -> Result<bool> {
    let mut a = a.chars(ai)?;
    let mut b = b.chars(bi)?;
    loop {
        let value = a.next_scalar()?;
        if value != b.next_scalar()? {
            return Ok(false);
        }
        if value.is_none() {
            return Ok(true);
        }
    }
}

fn preserved_tool_field(
    emitter: &mut Emitter,
    owner: &mut Writer,
    metadata: &Document,
    doc: &Document,
    field: usize,
    scope: Scope,
    inner: bool,
) -> Result<()> {
    emitter.emit(
        owner,
        Kind::Chunk,
        scope,
        |e| {
            base(metadata, e)?;
            e.bytes(b",\"choices\":[{\"index\":")?;
            e.unsigned(scope.choice_index.ok_or(Error::Schema)?)?;
            e.bytes(b",\"delta\":{\"tool_calls\":[{\"index\":")?;
            e.unsigned(scope.tool_index.ok_or(Error::Schema)?)?;
            if inner {
                e.bytes(b",\"function\":{}")?;
            }
            e.bytes(b"}]},\"finish_reason\":null}]")
        },
        |e| super::provenance::one(doc, field, e),
    )?;
    Ok(())
}
