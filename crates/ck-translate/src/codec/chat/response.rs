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
#[path = "response_snapshot.rs"]
mod snapshot;
#[path = "response_tool.rs"]
mod tool;

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
        store: &ck_stream::Store,
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
                reader: store.reader(owner.id(), 0)?,
                reduction: super::reduction::Reduction::new(owner)?,
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
    audio_output: Option<media_events::Audio>,
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
    reader: ck_stream::Reader,
    reduction: super::reduction::Reduction,
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
        let mut doc = Document::parse(owner, data, length)?;
        if error_event || doc.member(doc.root(), "error")?.is_some() {
            return Err(Error::Schema);
        }
        self.document(owner, &mut doc, false, Some((source, event)))
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
        doc: &mut Document,
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
        if !buffered {
            // All deltas precede validation; no snapshot suffix or close may escape a
            // contradiction in a later choice in this same source record.
            for choice in doc.children(choices)? {
                let index = doc.unsigned(doc.required(choice, "index")?)?;
                let position = self.choice(owner, index)?;
                if self.choices[position].finished {
                    return Err(Error::Schema);
                }
                if let Some(delta) = doc.member(choice, "delta")? {
                    self.delta(owner, doc, choice, delta, position, false)?;
                }
            }
            self.reconcile(owner, doc, choices)?;
        }
        for choice in doc.children(choices)? {
            let index = doc.unsigned(doc.required(choice, "index")?)?;
            let position = self.choice(owner, index)?;
            if self.choices[position].finished {
                return Err(Error::Schema);
            }
            if let Some(body) = doc.member(choice, "message")? {
                self.delta(owner, doc, choice, body, position, buffered)?;
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
            audio_output: None,
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
                if doc.node(field)?.first.is_none() {
                    self.empty_array(owner, position, "tool_calls")?;
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
        if let Some(audio) = &mut self.choices[position].audio_output {
            audio.finish(&mut self.emitter, owner)?;
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
pub(super) fn equal(a: &Document, ai: usize, b: &Document, bi: usize) -> Result<bool> {
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
