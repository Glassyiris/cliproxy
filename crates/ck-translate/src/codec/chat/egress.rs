use super::reduction::Reduction;
use crate::codec::{
    self, BodyMode, Error, Operation, Result,
    document::{Document, Value},
    encode::{self, Encoder},
    event::{Identity, Kind},
    internal,
};
use ck_stream::{Lease, ScratchLease, Writer};

pub struct Diagnostic {
    pub identity: Identity,
    pub kind: Kind,
    pub destination: &'static str,
    pub reason: &'static str,
}

pub struct Egress {
    owner: u64,
    mode: BodyMode,
    identity: Identity,
    sequence: u64,
    terminal: bool,
    failed: bool,
    reduction: Reduction,
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
            reduction: Reduction::new(owner)?,
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
        let (kind, doc) = internal::decode(owner, input)?;
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
        if self.reduction.document.is_none() && !matches!(kind, Kind::ResponseStart | Kind::Error | Kind::Cancelled) {
            return Err(Error::Schema);
        }
        match kind {
            Kind::ResponseStart
            | Kind::Chunk
            | Kind::ToolStart
            | Kind::Usage
            | Kind::MediaStart
            | Kind::Data
            | Kind::MediaTranscript
            | Kind::MediaEnd
            | Kind::Annotation => {
                let deliverable = if kind == Kind::Chunk {
                    if self.mode == BodyMode::Streaming {
                        self.reduction.refresh_metadata(owner, &doc)?;
                    }
                    chunk_deliverable(&doc)?
                } else if kind == Kind::Usage {
                    let usage = doc.required(root, "usage")?;
                    self.include_usage && matches!(doc.node(doc.required(usage, "final")?)?.value, Value::Bool(true))
                } else {
                    true
                };
                let (projection, lost) = self.reduction.project(owner, kind, doc)?;
                if lost {
                    (self.diagnostic)(Diagnostic {
                        identity: self.identity,
                        kind,
                        destination: "chat",
                        reason: "source field has no surviving native parent",
                    });
                }
                if let Some(projection) = projection {
                    if self.mode == BodyMode::Buffered {
                        self.reduction.fold(projection)?;
                    } else if deliverable {
                        output(encode::scratch(owner, |e| {
                            if kind == Kind::Chunk {
                                source_fields(&projection, x, e)?;
                            }
                            e.bytes(b"data: ")?;
                            projection.write(projection.root(), e)?;
                            e.bytes(b"\n\n")
                        })?)?;
                    }
                }
            }
            Kind::Opaque => {
                if doc.member(x, "media_id")?.is_some()
                    && let Some(name) = doc.member(root, "name")?
                    && doc.string_is(name, "chat.media.attributes")?
                {
                    if let (Some(projection), _) = self.reduction.project(owner, kind, doc)? {
                        if self.mode == BodyMode::Buffered {
                            self.reduction.fold(projection)?;
                        } else {
                            output(encode::scratch(owner, |e| {
                                e.bytes(b"data: ")?;
                                projection.write(projection.root(), e)?;
                                e.bytes(b"\n\n")
                            })?)?;
                        }
                    }
                } else if self.mode == BodyMode::Streaming {
                    output(encode::scratch(owner, |e| {
                        source_fields(&doc, x, e)?;
                        e.bytes(b"data: ")?;
                        let value = doc.required(root, "value")?;
                        if doc.string_is(doc.required(root, "format")?, "text")? {
                            let mut chars = doc.chars(value)?;
                            while let Some(c) = chars.next_scalar()? {
                                if c == '\n' {
                                    e.bytes(b"\ndata: ")?;
                                } else {
                                    e.bytes(c.encode_utf8(&mut [0; 4]).as_bytes())?;
                                }
                            }
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
            Kind::Done => {
                if self.reduction.has_open_media() {
                    return Err(Error::Truncated);
                }
                self.terminal = true;
                if self.mode == BodyMode::Streaming {
                    output(encode::scratch(owner, |e| e.bytes(b"data: [DONE]\n\n"))?)?;
                } else {
                    let aggregate = self.reduction.document.as_mut().ok_or(Error::Schema)?;
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
