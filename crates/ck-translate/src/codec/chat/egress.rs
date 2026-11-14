use super::aggregate::aggregate_chunk;
use super::response::mapped_document;
use crate::codec::{
    self, BodyMode, Error, Operation, Result,
    document::{Document, Value},
    encode::{self, Encoder},
    event::{Identity, Kind},
    internal,
    table::Table,
};
use ck_stream::{Lease, ScratchLease, Writer};
#[path = "egress_media.rs"]
mod media_events;

pub struct Diagnostic {
    pub identity: Identity,
    pub kind: Kind,
    pub destination: &'static str,
    pub reason: &'static str,
}

struct Tool {
    choice: u64,
    index: u64,
    custom: bool,
    legacy: bool,
}
pub struct Egress {
    owner: u64,
    mode: BodyMode,
    identity: Identity,
    sequence: u64,
    terminal: bool,
    failed: bool,
    document: Option<Document>,
    tools: Table<Tool>,
    media: Table<media_events::Projection>,
    include_usage: bool,
    diagnostic: fn(Diagnostic),
}
impl Egress {
    pub fn new(
        owner: &mut Writer,
        identity: Identity,
        operation: Operation,
        mode: BodyMode,
        include_usage: bool,
        diagnostic: fn(Diagnostic),
    ) -> Result<Self> {
        if operation != Operation::Generate {
            return Err(Error::Unsupported);
        }
        Ok(Self {
            owner: owner.id(),
            mode,
            identity,
            sequence: 0,
            terminal: false,
            failed: false,
            document: None,
            tools: Table::new(owner)?,
            media: Table::new(owner)?,
            include_usage,
            diagnostic,
        })
    }
    fn accept(
        &mut self,
        owner: &mut Writer,
        input: Lease,
        mut output: impl FnMut(ScratchLease) -> Result<()>,
    ) -> Result<()> {
        if owner.id() != self.owner {
            return Err(Error::Position);
        }
        if self.terminal || self.failed {
            return Err(Error::Closed);
        }
        let (kind, mut doc) = internal::decode(owner, input)?;
        let root = doc.root();
        let x = doc.required(root, "x_ck")?;
        if doc.unsigned(doc.required(x, "seq")?)? != self.sequence
            || doc.unsigned(doc.required(x, "attempt")?)? != self.identity.attempt
            || !doc.string_is(doc.required(x, "request_id")?, self.identity.request_id.as_str())?
            || !doc.string_is(doc.required(x, "stream_id")?, self.identity.stream_id.as_str())?
            || !doc.string_is(doc.required(x, "direction")?, "response")?
        {
            return Err(Error::Schema);
        }
        self.sequence = self.sequence.checked_add(1).ok_or(Error::Limit)?;
        if self.document.is_none() && !matches!(kind, Kind::ResponseStart | Kind::Error | Kind::Cancelled) {
            return Err(Error::Schema);
        }
        match kind {
            Kind::ResponseStart => {
                if self.document.is_some() {
                    return Err(Error::Schema);
                }
                doc.remove(root, "x_ck")?;
                if self.mode == BodyMode::Buffered {
                    doc.set(root, "object", Value::Text("chat.completion"))?;
                    doc.set(root, "choices", Value::Array)?;
                }
                self.document = Some(doc);
            }
            Kind::Chunk => {
                let deliverable = chunk_deliverable(&doc)?;
                doc.remove(root, "x_ck")?;
                if !super::provenance::restore(&mut doc, x)? {
                    (self.diagnostic)(Diagnostic {
                        identity: self.identity,
                        kind,
                        destination: "chat",
                        reason: "source field has no surviving native parent",
                    });
                }
                self.project_tools(&mut doc, x)?;
                if self.mode == BodyMode::Streaming {
                    if deliverable {
                        output(encode::scratch(owner, |e| {
                            source_fields(&doc, x, e)?;
                            e.bytes(b"data: ")?;
                            write_object(&doc, root, e, &[])?;
                            e.bytes(b"\n\n")
                        })?)?;
                    }
                } else {
                    let aggregate = self.document.as_mut().ok_or(Error::Schema)?;
                    let incoming = aggregate.absorb(doc)?;
                    aggregate_chunk(aggregate, incoming)?;
                }
            }
            Kind::ToolStart => {
                let choice = doc.unsigned(doc.required(x, "choice_index")?)?;
                let index = doc.unsigned(doc.required(x, "tool_index")?)?;
                if self
                    .tools
                    .iter()
                    .any(|tool| tool.choice == choice && tool.index == index)
                {
                    return Err(Error::Schema);
                }
                let custom = doc.string_is(doc.required(root, "arguments_format")?, "text")?;
                let legacy = doc.member(x, "chat_legacy")?.is_some();
                self.tools.push(Tool {
                    choice,
                    index,
                    custom,
                    legacy,
                })?;
                let source = doc.required(x, "source")?;
                let ids = doc.required(source, "ids")?;
                let id = doc.required(ids, "id")?;
                let name = doc.required(root, "name")?;
                let projected = mapped_document(owner, |e| {
                    e.bytes(b"{")?;
                    chunk_base(self.document.as_ref().ok_or(Error::Schema)?, e)?;
                    e.bytes(b",\"choices\":[{\"index\":")?;
                    e.unsigned(choice)?;
                    if legacy {
                        e.bytes(b",\"delta\":{\"function_call\":{\"name\":")?;
                        doc.write(name, e)?;
                        e.bytes(b"}},\"finish_reason\":null}]")?;
                    } else {
                        e.bytes(b",\"delta\":{\"tool_calls\":[{\"index\":")?;
                        e.unsigned(index)?;
                        e.bytes(b",\"id\":")?;
                        doc.write(id, e)?;
                        e.bytes(b",\"type\":")?;
                        e.string(if custom { "custom" } else { "function" })?;
                        e.bytes(b",")?;
                        e.string(if custom { "custom" } else { "function" })?;
                        e.bytes(b":{\"name\":")?;
                        doc.write(name, e)?;
                        e.bytes(b"}}]},\"finish_reason\":null}]")?;
                    }
                    e.bytes(b"}")
                })?;
                if self.mode == BodyMode::Streaming {
                    output(encode::scratch(owner, |e| {
                        e.bytes(b"data: ")?;
                        projected.write(projected.root(), e)?;
                        e.bytes(b"\n\n")
                    })?)?;
                } else {
                    let aggregate = self.document.as_mut().ok_or(Error::Schema)?;
                    let incoming = aggregate.absorb(projected)?;
                    aggregate_chunk(aggregate, incoming)?;
                }
            }
            Kind::Usage => {
                let usage = doc.required(root, "usage")?;
                let native = doc.required(usage, "native")?;
                let value = doc.required(native, "value")?;
                for (canonical, wire) in [
                    ("input_tokens", "prompt_tokens"),
                    ("output_tokens", "completion_tokens"),
                    ("total_tokens", "total_tokens"),
                ] {
                    if !matches!(doc.node(value)?.value, Value::Null)
                        && doc.member(value, wire)?.is_none()
                        && let Some(n) = doc.member(usage, canonical)?
                    {
                        doc.set(value, wire, Value::Unsigned(doc.unsigned(n)?))?;
                    }
                }
                if let Some(choice) = doc.member(x, "choice_index")? {
                    let final_snapshot = matches!(doc.node(doc.required(usage, "final")?)?.value, Value::Bool(true));
                    let projection = mapped_document(owner, |e| {
                        e.bytes(b"{")?;
                        chunk_base(self.document.as_ref().ok_or(Error::Schema)?, e)?;
                        e.bytes(b",\"choices\":[{\"index\":")?;
                        doc.write(choice, e)?;
                        e.bytes(b",\"delta\":{},\"finish_reason\":null,\"usage\":")?;
                        doc.write(value, e)?;
                        e.bytes(b"}]}")
                    })?;
                    if self.mode == BodyMode::Streaming {
                        if self.include_usage && final_snapshot {
                            output(encode::scratch(owner, |e| {
                                e.bytes(b"data: ")?;
                                projection.write(projection.root(), e)?;
                                e.bytes(b"\n\n")
                            })?)?;
                        }
                    } else {
                        let aggregate = self.document.as_mut().ok_or(Error::Schema)?;
                        let incoming = aggregate.absorb(projection)?;
                        aggregate_chunk(aggregate, incoming)?;
                    }
                    return Ok(());
                }
                if self.mode == BodyMode::Streaming {
                    let final_snapshot = matches!(doc.node(doc.required(usage, "final")?)?.value, Value::Bool(true));
                    if self.include_usage && final_snapshot {
                        output(encode::scratch(owner, |e| {
                            e.bytes(b"data: {")?;
                            chunk_base(self.document.as_ref().ok_or(Error::Schema)?, e)?;
                            e.bytes(b",\"choices\":[],\"usage\":")?;
                            doc.write(value, e)?;
                            e.bytes(b"}\n\n")
                        })?)?;
                    }
                } else {
                    let aggregate = self.document.as_mut().ok_or(Error::Schema)?;
                    let incoming = aggregate.absorb(doc)?;
                    let usage = aggregate.required(incoming, "usage")?;
                    let native = aggregate.required(usage, "native")?;
                    let value = aggregate.required(native, "value")?;
                    aggregate.detach(native, value)?;
                    aggregate.rename(value, "usage")?;
                    aggregate.remove(aggregate.root(), "usage")?;
                    aggregate.append(aggregate.root(), value)?;
                }
            }
            Kind::Opaque => {
                if doc.member(x, "media_id")?.is_some()
                    && let Some(name) = doc.member(root, "name")?
                    && doc.string_is(name, "chat.media.attributes")?
                {
                    let id = media_events::id(&doc, x)?;
                    let projection = self
                        .media
                        .iter_mut()
                        .find(|entry| entry.id == id)
                        .ok_or(Error::Schema)?;
                    projection.attributes(doc)?;
                } else if self.mode == BodyMode::Streaming {
                    output(encode::scratch(owner, |e| {
                        source_fields(&doc, x, e)?;
                        e.bytes(b"data: ")?;
                        let value = doc.required(root, "value")?;
                        if doc.string_is(doc.required(root, "format")?, "text")? {
                            raw_string(&doc, value, e)?;
                        } else {
                            doc.write(value, e)?;
                        }
                        e.bytes(b"\n\n")
                    })?)?;
                } else {
                    (self.diagnostic)(Diagnostic {
                        identity: self.identity,
                        kind,
                        destination: "chat.buffered",
                        reason: "no native event carrier",
                    });
                }
            }
            Kind::MediaStart => {
                let projection = media_events::Projection::start(owner, doc, x)?;
                if self.media.iter().any(|entry| entry.id == projection.id) {
                    return Err(Error::Schema);
                }
                self.media.push(projection)?;
            }
            Kind::Data | Kind::MediaTranscript | Kind::MediaEnd => {
                let id = media_events::id(&doc, x)?;
                let position = self
                    .media
                    .iter()
                    .position(|entry| entry.id == id)
                    .ok_or(Error::Schema)?;
                if kind == Kind::Data {
                    self.media[position].data(doc)?;
                } else if kind == Kind::MediaTranscript {
                    self.media[position].transcript(doc)?;
                } else {
                    let (native, value, field, choice) = self.media[position].end(&doc)?;
                    let projection = self.native_field(owner, native, value, field, choice)?;
                    self.project(owner, projection, &mut output)?;
                }
            }
            Kind::Annotation => {
                if !doc.string_is(doc.required(root, "kind")?, "chat")? {
                    return Err(Error::Unsupported);
                }
                let choice = doc.unsigned(doc.required(x, "choice_index")?)?;
                let value = doc.required(root, "value")?;
                let projection = self.native_field(owner, doc, value, "annotations", choice)?;
                self.project(owner, projection, &mut output)?;
            }
            Kind::Done => {
                if self.media.iter().any(|media| media.is_open()) {
                    return Err(Error::Truncated);
                }
                self.terminal = true;
                if self.mode == BodyMode::Streaming {
                    output(encode::scratch(owner, |e| e.bytes(b"data: [DONE]\n\n"))?)?;
                } else {
                    let aggregate = self.document.as_mut().ok_or(Error::Schema)?;
                    let choices = aggregate.required(aggregate.root(), "choices")?;
                    let mut choice = aggregate.node(choices)?.first;
                    while let Some(c) = choice {
                        choice = aggregate.node(c)?.next;
                        if matches!(
                            aggregate.node(aggregate.required(c, "finish_reason")?)?.value,
                            Value::Null
                        ) {
                            return Err(Error::Truncated);
                        }
                        if let Some(message) = aggregate.member(c, "message")?
                            && let Some(calls) = aggregate.member(message, "tool_calls")?
                        {
                            let mut call = aggregate.node(calls)?.first;
                            while let Some(t) = call {
                                call = aggregate.node(t)?.next;
                                aggregate.remove(t, "index")?;
                            }
                        }
                    }
                    output(encode::scratch(owner, |e| aggregate.write(aggregate.root(), e))?)?;
                }
            }
            Kind::Error | Kind::Cancelled => {
                self.terminal = true;
                output(encode::scratch(owner, |e| {
                    if self.mode == BodyMode::Streaming {
                        e.bytes(b"data: ")?;
                    }
                    e.bytes(b"{\"error\":{")?;
                    if kind == Kind::Error {
                        let mut first = true;
                        for key in ["code", "message", "status"] {
                            if let Some(value) = doc.member(root, key)? {
                                if !first {
                                    e.bytes(b",")?;
                                }
                                first = false;
                                e.string(key)?;
                                e.bytes(b":")?;
                                doc.write(value, e)?;
                            }
                        }
                    } else {
                        e.bytes(b"\"code\":\"stream.cancelled\",\"message\":\"Request cancelled\"")?;
                    }
                    e.bytes(b"}}")?;
                    if self.mode == BodyMode::Streaming {
                        e.bytes(b"\n\n")?;
                    }
                    Ok(())
                })?)?;
            }
            Kind::ItemStart | Kind::ItemEnd | Kind::BlockStart | Kind::BlockEnd | Kind::ToolEnd | Kind::Heartbeat => (),
            Kind::RequestStart | Kind::RequestField | Kind::RequestEnd | Kind::CountTokens | Kind::Compact => {
                return Err(Error::Unsupported);
            }
            _ => (self.diagnostic)(Diagnostic {
                identity: self.identity,
                kind,
                destination: "chat",
                reason: "no native carrier",
            }),
        }
        Ok(())
    }
    fn project_tools(&self, doc: &mut Document, x: usize) -> Result<()> {
        let Some(choice_node) = doc.member(x, "choice_index")? else {
            return Ok(());
        };
        let Some(tool_node) = doc.member(x, "tool_index")? else {
            return Ok(());
        };
        let choice_index = doc.unsigned(choice_node)?;
        let tool_index = doc.unsigned(tool_node)?;
        let tool = self
            .tools
            .iter()
            .find(|t| t.choice == choice_index && t.index == tool_index)
            .ok_or(Error::Schema)?;
        let choices = doc.required(doc.root(), "choices")?;
        let choice = doc.node(choices)?.first.ok_or(Error::Schema)?;
        let delta = doc.required(choice, "delta")?;
        let Some(calls) = doc.member(delta, "tool_calls")? else {
            return Ok(());
        };
        let call = doc.node(calls)?.first.ok_or(Error::Schema)?;
        let Some(function) = doc.member(call, "function")? else {
            return Ok(());
        };
        if tool.legacy {
            doc.remove(delta, "tool_calls")?;
            doc.detach(call, function)?;
            doc.rename(function, "function_call")?;
            doc.append(delta, function)?;
        } else if tool.custom {
            doc.rename(function, "custom")?;
            if let Some(arguments) = doc.member(function, "arguments")? {
                doc.rename(arguments, "input")?;
            }
        }
        Ok(())
    }
}
impl codec::ResponseEgress for Egress {
    fn advance(
        &mut self,
        owner: &mut Writer,
        input: Lease,
        output: impl FnMut(ScratchLease) -> Result<()>,
    ) -> Result<()> {
        let result = self.accept(owner, input, output);
        if result.is_err() {
            self.failed = true;
        }
        result
    }
    fn finish(&mut self) -> Result<()> {
        if self.terminal && !self.failed {
            Ok(())
        } else {
            Err(Error::Truncated)
        }
    }
}

fn chunk_base(doc: &Document, e: &mut Encoder<'_, '_>) -> Result<()> {
    let mut first = true;
    for key in ["id", "model", "created", "system_fingerprint", "service_tier"] {
        if let Some(value) = doc.member(doc.root(), key)? {
            if !first {
                e.bytes(b",")?;
            }
            first = false;
            e.string(key)?;
            e.bytes(b":")?;
            doc.write(value, e)?;
        }
    }
    e.bytes(b",\"object\":\"chat.completion.chunk\"")
}
fn write_object(doc: &Document, object: usize, e: &mut Encoder<'_, '_>, skip: &[&str]) -> Result<()> {
    e.bytes(b"{")?;
    let mut first = true;
    for field in doc.children(object)? {
        let name = doc.node(field)?.name.ok_or(Error::Schema)?;
        let mut omitted = false;
        for key in skip {
            omitted |= doc.name_is(name, key)?;
        }
        if omitted {
            continue;
        }
        if !first {
            e.bytes(b",")?;
        }
        first = false;
        doc.write_name(name, e)?;
        e.bytes(b":")?;
        doc.write(field, e)?;
    }
    e.bytes(b"}")
}
fn raw_string(doc: &Document, node: usize, e: &mut Encoder<'_, '_>) -> Result<()> {
    let mut chars = doc.chars(node)?;
    while let Some(c) = chars.next_scalar()? {
        e.bytes(c.encode_utf8(&mut [0; 4]).as_bytes())?;
    }
    Ok(())
}
fn source_fields(doc: &Document, x: usize, e: &mut Encoder<'_, '_>) -> Result<()> {
    if let Some(source) = doc.member(x, "source")?
        && let Some(fields) = doc.member(source, "sse")?
    {
        for field in doc.children(fields)? {
            let comment = matches!(doc.node(doc.required(field, "comment")?)?.value, Value::Bool(true));
            if !comment {
                raw_string(doc, doc.required(field, "name")?, e)?;
            }
            e.bytes(b": ")?;
            raw_string(doc, doc.required(field, "value")?, e)?;
            e.bytes(b"\n")?;
        }
    }
    Ok(())
}
fn chunk_deliverable(doc: &Document) -> Result<bool> {
    let choices = doc.required(doc.root(), "choices")?;
    if doc.node(choices)?.first.is_some() {
        return Ok(true);
    }
    for field in doc.children(doc.root())? {
        let name = doc.node(field)?.name.ok_or(Error::Schema)?;
        let mut known = false;
        for key in [
            "x_ck",
            "id",
            "model",
            "created",
            "object",
            "system_fingerprint",
            "service_tier",
            "choices",
        ] {
            known |= doc.name_is(name, key)?;
        }
        if !known {
            return Ok(true);
        }
    }
    let x = doc.required(doc.root(), "x_ck")?;
    if doc.member(x, "original")?.is_some() {
        return Ok(true);
    }
    if let Some(source) = doc.member(x, "source")?
        && let Some(fields) = doc.member(source, "sse")?
    {
        return Ok(doc.node(fields)?.first.is_some());
    }
    Ok(false)
}
