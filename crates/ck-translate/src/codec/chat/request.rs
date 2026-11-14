use super::request_content::normalize_part;
use crate::codec::{
    self, Capability, Error, Operation, RequestFence, RequestView, Result, ValidatedRequest,
    document::{Document, Name, Value},
    encode::{self, Encoder},
    event::{Emitter, Identity, Kind, Scope},
    json,
    media::{self, Registry},
};
use ck_stream::{ScratchLease, Writer};

#[path = "request_string.rs"]
mod string;

#[path = "request_records.rs"]
mod records;
pub use records::read_document;

#[path = "request_write.rs"]
mod write;
use write::write_request;

#[path = "request_publish.rs"]
mod publish;
use publish::{Component, field, fields};

pub struct Ingress {
    owner: u64,
    scanner: Option<json::Scanner>,
    document: Document,
    started: bool,
    last_field: Option<usize>,
    messages: Option<PendingMessages>,
    current_message: Option<PendingMessage>,
    string: Option<PendingString>,
    trees: codec::table::Table<Option<PendingTree>>,
    published_media: usize,
    media: Registry,
    emitter: Emitter,
    fence: RequestFence,
    operation: Operation,
    failed: bool,
    reader: ck_stream::Reader,
}

struct PendingMessages {
    wire: usize,
    node: usize,
    last: Option<usize>,
    index: u64,
}

struct PendingMessage {
    wire: usize,
    node: usize,
    last: Option<usize>,
}
struct PendingString {
    wire: usize,
    node: usize,
    media: usize,
    offset: u64,
    publisher: media::Publisher,
    decoder: media::InputDecoder,
}

#[derive(Clone, Copy)]
struct PendingTree {
    node: usize,
    last: Option<usize>,
    index: u64,
    done: bool,
}

impl Ingress {
    pub fn new(
        owner: &mut Writer,
        store: &ck_stream::Store,
        identity: Identity,
        operation: Operation,
        max_bytes: u64,
    ) -> Result<Self> {
        if operation != Operation::Generate {
            return Err(Error::Unsupported);
        }
        let mut document = Document::streaming(owner)?;
        initialize(&mut document)?;
        Ok(Self {
            owner: owner.id(),
            scanner: Some(json::Scanner::new(owner, max_bytes)?),
            document,
            started: false,
            last_field: None,
            messages: None,
            current_message: None,
            string: None,
            trees: codec::table::Table::new(owner)?,
            published_media: 0,
            media: Registry::new(owner)?,
            emitter: Emitter::new(identity),
            fence: RequestFence::default(),
            operation,
            failed: false,
            reader: store.reader(owner.id(), 0)?,
        })
    }

    fn consume(&mut self, owner: &mut Writer) -> Result<()> {
        let scanner = self.scanner.as_ref().ok_or(Error::Closed)?;
        if scanner.nodes().is_empty() {
            return Ok(());
        }
        let root = scanner.pending_node(self.document.input(), 0)?;
        if root.kind != json::Kind::Object {
            return Err(Error::Schema);
        }
        if !self.started {
            self.emitter.request_start(
                owner,
                RequestView {
                    document: &self.document,
                    media: &self.media,
                    operation: self.operation,
                },
            )?;
            let (kind, _) = codec::internal::next(owner, &mut self.reader)?;
            if kind != Kind::RequestStart {
                return Err(Error::Schema);
            }
            let root = self.document.root();
            field(
                &mut self.document,
                &self.media,
                root,
                &[],
                &mut self.emitter,
                owner,
                &mut self.reader,
            )?;
            self.started = true;
        }
        loop {
            let scanner = self.scanner.as_ref().ok_or(Error::Closed)?;
            let next = match self.last_field {
                Some(last) => scanner.pending_node(self.document.input(), last)?.next,
                None => root.first,
            };
            let Some(index) = next else { break };
            let wire = scanner.pending_node(self.document.input(), index)?;
            let key = wire.key.ok_or(Error::Schema)?;
            if self.messages.as_ref().is_some_and(|m| m.wire == index)
                || scanner.key_is(&self.document, key, "messages")?
            {
                if wire.kind != json::Kind::Array {
                    return Err(Error::Schema);
                }
                if self.messages.is_none() {
                    self.scanner
                        .as_mut()
                        .ok_or(Error::Closed)?
                        .bind_key(key, Name::Static("messages"));
                    let node = self.document.set(self.document.root(), "messages", Value::Array)?;
                    field(
                        &mut self.document,
                        &self.media,
                        node,
                        &[Some(Component::Name(Name::Static("messages")))],
                        &mut self.emitter,
                        owner,
                        &mut self.reader,
                    )?;
                    self.messages = Some(PendingMessages {
                        wire: index,
                        node,
                        last: None,
                        index: 0,
                    });
                }
                self.consume_messages(owner)?;
                let scanner = self.scanner.as_ref().ok_or(Error::Closed)?;
                if scanner.completed_node(self.document.input(), index)?.is_none() {
                    break;
                }
            } else {
                if self.string.as_ref().is_some_and(|s| s.wire == index)
                    || (wire.kind == json::Kind::String
                        && wire.span.end == 0
                        && wire.validated_end - wire.span.start > 1024
                        && !json::string_is(self.document.input(), key, "reasoning_effort")?
                        && !json::string_is(self.document.input(), key, "reasoning")?
                        && !json::string_is(self.document.input(), key, "functions")?
                        && !json::string_is(self.document.input(), key, "function_call")?
                        && !json::string_is(self.document.input(), key, "x_ck")?)
                {
                    let name = self
                        .string
                        .as_ref()
                        .map(|s| self.document.node(s.node).map(|n| n.name))
                        .transpose()?
                        .flatten()
                        .unwrap_or(Name::Mapped(codec::document::Text { source: 0, span: key }));
                    if !self
                        .stream_string(owner, index, self.document.root(), &[Some(Component::Name(name))], true)?
                        .1
                    {
                        break;
                    }
                    self.last_field = Some(index);
                    continue;
                }
                let scanner = self.scanner.as_ref().ok_or(Error::Closed)?;
                if !scanner.key_is(&self.document, key, "x_ck")?
                    && !scanner.key_is(&self.document, key, "functions")?
                    && !scanner.key_is(&self.document, key, "function_call")?
                    && !scanner.key_is(&self.document, key, "reasoning")?
                    && !scanner.key_is(&self.document, key, "reasoning_effort")?
                    && (wire.span.end == 0 || self.trees.get(index).is_some_and(Option::is_some))
                {
                    let name = if let Some(state) = self.trees.get(index).and_then(|s| *s) {
                        self.document.node(state.node)?.name.ok_or(Error::Schema)?
                    } else {
                        Name::Mapped(codec::document::Text { source: 0, span: key })
                    };
                    let mut path = [None; 128];
                    path[0] = Some(Component::Name(name));
                    if !self.consume_tree(owner, index, self.document.root(), &mut path, 1, true)? {
                        break;
                    }
                    self.last_field = Some(index);
                    continue;
                }
                let scanner = self.scanner.as_ref().ok_or(Error::Closed)?;
                if scanner.completed_node(self.document.input(), index)?.is_none() {
                    break;
                }
                let node = self.document.import_completed(scanner, index)?;
                let name = self.document.node(node)?.name.ok_or(Error::Schema)?;
                for alias in ["x_ck", "functions", "function_call", "reasoning", "reasoning_effort"] {
                    if self.document.name_is(name, alias)? {
                        self.scanner
                            .as_mut()
                            .ok_or(Error::Closed)?
                            .bind_key(key, Name::Static(alias));
                    }
                }
                if self.document.name_is(name, "x_ck")? {
                    let x = self.document.required(self.document.root(), "x_ck")?;
                    let original = self.document.required(x, "original")?;
                    original_field(&mut self.document, original, "/x_ck", node)?;
                } else {
                    for existing in self.document.children(self.document.root())? {
                        if self
                            .document
                            .names_equal(name, self.document.node(existing)?.name.ok_or(Error::Schema)?)?
                        {
                            return Err(Error::Schema);
                        }
                    }
                    self.document.append(self.document.root(), node)?;
                    if self.document.name_is(name, "functions")? {
                        let mut next = self.document.node(node)?.first;
                        while let Some(function) = next {
                            next = self.document.node(function)?.next;
                            super::request_controls::cache(&mut self.document, owner, function)?;
                        }
                    }
                    normalize_options(&mut self.document)?;
                    let published = if self.document.name_is(name, "functions")? {
                        Some(self.document.required(self.document.root(), "tools")?)
                    } else if self.document.name_is(name, "function_call")? {
                        Some(self.document.required(self.document.root(), "tool_choice")?)
                    } else if self.document.name_is(name, "reasoning")?
                        || self.document.name_is(name, "reasoning_effort")?
                    {
                        None
                    } else {
                        Some(node)
                    };
                    if let Some(node) = published {
                        let mut path = [None; 128];
                        path[0] = Some(Component::Name(self.document.node(node)?.name.ok_or(Error::Schema)?));
                        fields(
                            &mut self.document,
                            &self.media,
                            node,
                            (&mut path, 1),
                            &mut self.emitter,
                            owner,
                            &mut self.reader,
                        )?;
                    }
                }
            }
            self.last_field = Some(index);
        }
        Ok(())
    }

    fn consume_messages(&mut self, owner: &mut Writer) -> Result<()> {
        loop {
            let pending = self.messages.as_ref().ok_or(Error::Schema)?;
            let scanner = self.scanner.as_ref().ok_or(Error::Closed)?;
            let next = match pending.last {
                Some(last) => scanner.pending_node(self.document.input(), last)?.next,
                None => scanner.pending_node(self.document.input(), pending.wire)?.first,
            };
            let Some(index) = next else { break };
            let wire = scanner.pending_node(self.document.input(), index)?;
            if wire.kind != json::Kind::Object {
                return Err(Error::Schema);
            }
            let message_index = pending.index;
            let mut path = [None; 128];
            path[0] = Some(Component::Name(Name::Static("messages")));
            path[1] = Some(Component::Index(message_index));
            if self.current_message.is_none() {
                let node = self.document.add(None, Value::Object)?;
                self.document.append(pending.node, node)?;
                field(
                    &mut self.document,
                    &self.media,
                    node,
                    &path[..2],
                    &mut self.emitter,
                    owner,
                    &mut self.reader,
                )?;
                self.current_message = Some(PendingMessage {
                    wire: index,
                    node,
                    last: None,
                });
            }
            loop {
                let current = self.current_message.as_ref().ok_or(Error::Schema)?;
                let scanner = self.scanner.as_ref().ok_or(Error::Closed)?;
                let next = match current.last {
                    Some(last) => scanner.pending_node(self.document.input(), last)?.next,
                    None => scanner.pending_node(self.document.input(), current.wire)?.first,
                };
                let Some(child) = next else { break };
                let value = scanner.pending_node(self.document.input(), child)?;
                let key = value.key.ok_or(Error::Schema)?;
                let existing = self
                    .string
                    .as_ref()
                    .filter(|s| s.wire == child)
                    .map(|s| s.node)
                    .or_else(|| self.trees.get(child).and_then(|s| s.map(|s| s.node)));
                let name = existing
                    .map(|node| self.document.node(node).map(|n| n.name))
                    .transpose()?
                    .flatten()
                    .unwrap_or(Name::Mapped(codec::document::Text { source: 0, span: key }));
                path[2] = Some(Component::Name(name));
                if self.string.as_ref().is_some_and(|s| s.wire == child)
                    || (value.kind == json::Kind::String
                        && value.span.end == 0
                        && value.validated_end - value.span.start > 1024)
                {
                    if !self.stream_string(owner, child, current.node, &path[..3], true)?.1 {
                        return Ok(());
                    }
                } else {
                    if value.span.end == 0 || self.trees.get(child).is_some_and(Option::is_some) {
                        let deferred = self.document.name_is(name, "tool_calls")?
                            || self.document.name_is(name, "function_call")?
                            || (self.document.name_is(name, "content")? && value.kind == json::Kind::Array);
                        if !self.consume_tree(owner, child, current.node, &mut path, 3, !deferred)? {
                            return Ok(());
                        }
                        self.current_message.as_mut().ok_or(Error::Schema)?.last = Some(child);
                        continue;
                    }
                    if value.span.end == 0 {
                        return Ok(());
                    }
                    let node = self.document.import_completed(scanner, child)?;
                    self.document.append(current.node, node)?;
                    let deferred = self.document.name_is(name, "tool_calls")?
                        || self.document.name_is(name, "function_call")?
                        || (self.document.name_is(name, "content")? && value.kind == json::Kind::Array);
                    if !deferred {
                        fields(
                            &mut self.document,
                            &self.media,
                            node,
                            (&mut path, 3),
                            &mut self.emitter,
                            owner,
                            &mut self.reader,
                        )?;
                    }
                }
                self.current_message.as_mut().ok_or(Error::Schema)?.last = Some(child);
            }
            if wire.span.end == 0 {
                break;
            }
            let current = self.current_message.take().ok_or(Error::Schema)?;
            self.media.validate_registrations(&self.document)?;
            normalize_message(&mut self.document, current.node, message_index, &mut self.media, owner)?;
            self.media.relocate_ingress(&self.document)?;
            fields(
                &mut self.document,
                &self.media,
                current.node,
                (&mut path, 2),
                &mut self.emitter,
                owner,
                &mut self.reader,
            )?;
            while self.published_media < self.media.len() {
                let index = self.published_media;
                media::publish(
                    &self.document,
                    self.media.at(index),
                    &mut self.emitter,
                    owner,
                    Scope::default(),
                )?;
                self.media.retain(&mut self.document, index, owner, &mut self.reader)?;
                self.published_media += 1;
            }
            let pending = self.messages.as_mut().ok_or(Error::Schema)?;
            pending.last = Some(index);
            pending.index += 1;
        }
        Ok(())
    }

    fn consume_tree(
        &mut self,
        owner: &mut Writer,
        wire_index: usize,
        parent: usize,
        path: &mut [Option<Component>; 128],
        depth: usize,
        publish: bool,
    ) -> Result<bool> {
        if depth == path.len() {
            return Err(Error::Limit);
        }
        while self.trees.len() <= wire_index {
            self.trees.push(None)?;
        }
        if self.trees[wire_index].is_some_and(|state| state.done) {
            return Ok(true);
        }
        let scanner = self.scanner.as_ref().ok_or(Error::Closed)?;
        let wire = scanner.pending_node(self.document.input(), wire_index)?;
        let mut media_carrier = false;
        if let Some(name) = self.document.node(parent)?.name {
            for key in ["input_audio", "image_url", "file"] {
                media_carrier |= self.document.name_is(name, key)?;
            }
        }
        if wire.kind == json::Kind::String
            && (self.string.as_ref().is_some_and(|s| s.wire == wire_index)
                || (wire.span.end == 0 && (wire.validated_end - wire.span.start > 1024 || media_carrier)))
        {
            let (node, done) = self.stream_string(owner, wire_index, parent, &path[..depth], publish)?;
            if let Some(node) = node {
                self.trees[wire_index] = Some(PendingTree {
                    node,
                    last: None,
                    index: 0,
                    done,
                });
            }
            return Ok(done);
        }
        if self.trees[wire_index].is_none() {
            if !matches!(wire.kind, json::Kind::Object | json::Kind::Array) {
                if wire.span.end == 0 {
                    return Ok(false);
                }
                let node = self.document.import_completed(scanner, wire_index)?;
                self.document.append(parent, node)?;
                if publish {
                    fields(
                        &mut self.document,
                        &self.media,
                        node,
                        (path, depth),
                        &mut self.emitter,
                        owner,
                        &mut self.reader,
                    )?;
                }
                self.trees[wire_index] = Some(PendingTree {
                    node,
                    last: None,
                    index: 0,
                    done: true,
                });
                return Ok(true);
            }
            let name = wire
                .key
                .map(|span| Name::Mapped(codec::document::Text { source: 0, span }));
            let node = self.document.add(
                name,
                if wire.kind == json::Kind::Object {
                    Value::Object
                } else {
                    Value::Array
                },
            )?;
            self.document.append(parent, node)?;
            if publish {
                field(
                    &mut self.document,
                    &self.media,
                    node,
                    &path[..depth],
                    &mut self.emitter,
                    owner,
                    &mut self.reader,
                )?;
            }
            self.trees[wire_index] = Some(PendingTree {
                node,
                last: None,
                index: 0,
                done: false,
            });
        }
        loop {
            let state = self.trees[wire_index].ok_or(Error::Schema)?;
            let scanner = self.scanner.as_ref().ok_or(Error::Closed)?;
            let next = match state.last {
                Some(last) => scanner.pending_node(self.document.input(), last)?.next,
                None => wire.first,
            };
            let Some(child) = next else { break };
            let value = scanner.pending_node(self.document.input(), child)?;
            path[depth] = Some(if wire.kind == json::Kind::Array {
                Component::Index(state.index)
            } else {
                Component::Name(if let Some(state) = self.trees.get(child).and_then(|s| *s) {
                    self.document.node(state.node)?.name.ok_or(Error::Schema)?
                } else {
                    Name::Mapped(codec::document::Text {
                        source: 0,
                        span: value.key.ok_or(Error::Schema)?,
                    })
                })
            });
            if !self.consume_tree(owner, child, state.node, path, depth + 1, publish)? {
                return Ok(false);
            }
            self.trees[wire_index].as_mut().ok_or(Error::Schema)?.last = Some(child);
            self.trees[wire_index].as_mut().ok_or(Error::Schema)?.index =
                state.index.checked_add(1).ok_or(Error::Limit)?;
        }
        self.trees[wire_index].as_mut().ok_or(Error::Schema)?.done = wire.span.end != 0;
        Ok(wire.span.end != 0)
    }

    fn prepare(&mut self, owner: &mut Writer) -> Result<()> {
        self.scanner
            .as_mut()
            .ok_or(Error::Closed)?
            .finish(self.document.input())?;
        self.consume(owner)?;
        super::request_controls::declarations(&mut self.document, owner)?;
        super::provenance::bindings(&mut self.document, owner)?;
        validate(&self.document)?;
        super::request_schema::validate(&self.document, &self.media)?;
        let x = self.document.required(self.document.root(), "x_ck")?;
        let mut path = [None; 128];
        path[0] = Some(Component::Name(Name::Static("x_ck")));
        fields(
            &mut self.document,
            &self.media,
            x,
            (&mut path, 1),
            &mut self.emitter,
            owner,
            &mut self.reader,
        )?;
        self.scanner = None;
        self.document.retire_scratch()
    }
}

impl codec::RequestIngress for Ingress {
    fn flush_deadline(&self) -> Option<std::time::Instant> {
        // Every complete decoded fragment is published within advance.
        None
    }

    fn advance(&mut self, owner: &mut Writer, bytes: &[u8]) -> Result<()> {
        if owner.id() != self.owner {
            return Err(Error::Position);
        }
        if self.failed {
            return Err(Error::Closed);
        }
        let result = (|| {
            for bytes in bytes.chunks(8192) {
                self.document.push_input(owner, bytes)?;
                self.scanner
                    .as_mut()
                    .ok_or(Error::Closed)?
                    .advance_document(&self.document)?;
                self.consume(owner)?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            self.failed = true;
            if !matches!(error, Error::Storage(_)) {
                super::failure(&mut self.emitter, owner, "client")?;
            }
            return Err(error);
        }
        Ok(())
    }
    fn finish<'a>(&'a mut self, owner: &mut Writer, destination: &impl Capability) -> Result<ValidatedRequest<'a>> {
        if owner.id() != self.owner {
            return Err(Error::Position);
        }
        if self.failed {
            return Err(Error::Closed);
        }
        if let Err(error) = self.prepare(owner) {
            self.failed = true;
            super::failure(&mut self.emitter, owner, "client")?;
            return Err(error);
        }
        let doc = &self.document;
        let view = RequestView {
            document: doc,
            media: &self.media,
            operation: self.operation,
        };
        let ready = match self.fence.end(view, destination) {
            Ok(ready) => ready,
            Err(error) => {
                self.failed = true;
                super::failure(&mut self.emitter, owner, "client")?;
                return Err(error);
            }
        };
        self.emitter.request_end(owner, &ready)?;
        self.emitter
            .emit(owner, Kind::Done, Scope::default(), |_| Ok(()), |_| Ok(()))?;
        Ok(ready)
    }
}

pub struct Egress {
    pub destination: &'static str,
    pub upstream_stream: bool,
}
impl codec::RequestEgress for Egress {
    fn encode(&self, request: &ValidatedRequest<'_>, owner: &mut Writer) -> Result<ScratchLease> {
        let view = request.for_destination(self.destination)?;
        if view.operation != Operation::Generate {
            return Err(Error::Unsupported);
        }
        view.document.check_owner(owner)?;
        encode::scratch(owner, |e| write_request(view, self.upstream_stream, e))
    }
}

/// Chat's protocol capabilities; model-specific restrictions belong in a distinct policy key.
pub struct ChatCapability;
impl Capability for ChatCapability {
    fn destination(&self) -> &'static str {
        "chat"
    }
    fn validate(&self, view: RequestView<'_>) -> Result<()> {
        if view.operation != Operation::Generate {
            return Err(Error::Unsupported);
        }
        validate(view.document)?;
        super::request_schema::validate(view.document, view.media)?;
        super::request_controls::destination(view.document)
    }
}

pub(super) fn require_string(doc: &Document, node: usize) -> Result<()> {
    if matches!(
        doc.node(node)?.value,
        Value::String(_) | Value::Text(_) | Value::Id(_) | Value::Utf8Media
    ) {
        Ok(())
    } else {
        Err(Error::Schema)
    }
}
fn require_array(doc: &Document, node: usize) -> Result<()> {
    if matches!(doc.node(node)?.value, Value::Array) {
        Ok(())
    } else {
        Err(Error::Schema)
    }
}

fn validate(doc: &Document) -> Result<()> {
    let root = doc.root();
    require_string(doc, doc.required(root, "model")?)?;
    let messages = doc.required(root, "messages")?;
    require_array(doc, messages)?;
    for message in doc.children(messages)? {
        let role = doc.required(message, "role")?;
        let mut accepted = false;
        for value in ["system", "developer", "user", "assistant", "tool", "function"] {
            accepted |= doc.string_is(role, value)?;
        }
        if !accepted {
            return Err(Error::Unsupported);
        }
        if let Some(content) = doc.member(message, "content")? {
            match doc.node(content)?.value {
                Value::String(_) | Value::Text(_) | Value::Utf8Media | Value::Null => (),
                Value::Array => {
                    for part in doc.children(content)? {
                        let kind = doc.required(part, "type")?;
                        let mut supported = false;
                        for name in [
                            "text",
                            "reasoning",
                            "reasoning_summary",
                            "refusal",
                            "image",
                            "audio",
                            "video",
                            "document",
                            "tool_result",
                            "opaque",
                            "redacted",
                            "encrypted",
                        ] {
                            supported |= doc.string_is(kind, name)?;
                        }
                        if !supported {
                            return Err(Error::Unsupported);
                        }
                    }
                }
                _ => return Err(Error::Schema),
            }
        }
        if let Some(calls) = doc.member(message, "tool_calls")? {
            require_array(doc, calls)?;
            for call in doc.children(calls)? {
                require_string(doc, doc.required(call, "id")?)?;
                let function = doc.required(call, "function")?;
                require_string(doc, doc.required(function, "name")?)?;
                let format = doc.required(call, "arguments_format")?;
                if !doc.string_is(format, "json")? && !doc.string_is(format, "text")? {
                    return Err(Error::Schema);
                }
            }
        }
        if doc.string_is(role, "tool")? {
            let result_id = doc.required(message, "tool_call_id")?;
            let mut found = false;
            for prior in doc.children(messages)? {
                if prior == message {
                    break;
                }
                if let Some(calls) = doc.member(prior, "tool_calls")? {
                    for call in doc.children(calls)? {
                        if doc.equal_strings(result_id, doc.required(call, "id")?)? {
                            found = true;
                        }
                    }
                }
            }
            if !found {
                return Err(Error::Schema);
            }
        }
    }
    Ok(())
}

fn initialize(doc: &mut Document) -> Result<()> {
    let root = doc.root();
    let x = doc.set(root, "x_ck", Value::Object)?;
    doc.set(x, "v", Value::Unsigned(1))?;
    doc.set(x, "original_protocol", Value::Text("chat"))?;
    doc.set(x, "operation", Value::Text("generate"))?;
    doc.set(x, "original", Value::Array)?;
    Ok(())
}

fn normalize_options(doc: &mut Document) -> Result<()> {
    let root = doc.root();
    let x = doc.required(root, "x_ck")?;
    if let Some(reasoning) = doc.remove(root, "reasoning_effort")? {
        let thinking = match doc.member(x, "thinking")? {
            Some(i) => i,
            None => doc.set(x, "thinking", Value::Object)?,
        };
        doc.rename(reasoning, "effort")?;
        doc.append(thinking, reasoning)?;
    }
    if let Some(reasoning) = doc.remove(root, "reasoning")? {
        let thinking = match doc.member(x, "thinking")? {
            Some(i) => i,
            None => doc.set(x, "thinking", Value::Object)?,
        };
        doc.rename(reasoning, "native")?;
        doc.append(thinking, reasoning)?;
    }
    if let Some(functions) = doc.remove(root, "functions")? {
        if doc.member(root, "tools")?.is_some() {
            return Err(Error::Schema);
        }
        require_array(doc, functions)?;
        let tools = doc.set(root, "tools", Value::Array)?;
        while let Some(function) = doc.node(functions)?.first {
            doc.detach(functions, function)?;
            let wrapper = doc.add(None, Value::Object)?;
            doc.set(wrapper, "type", Value::Text("function"))?;
            doc.rename(function, "function")?;
            doc.append(wrapper, function)?;
            doc.append(tools, wrapper)?;
        }
        doc.set(x, "chat_legacy_functions", Value::Bool(true))?;
    }
    if let Some(choice) = doc.remove(root, "function_call")? {
        if doc.member(root, "tool_choice")?.is_some() {
            return Err(Error::Schema);
        }
        doc.rename(choice, "tool_choice")?;
        doc.append(root, choice)?;
        if matches!(doc.node(choice)?.value, Value::Object) {
            let function = doc.add(Some(Name::Static("function")), Value::Object)?;
            if let Some(name) = doc.remove(choice, "name")? {
                doc.append(function, name)?;
            }
            doc.set(choice, "type", Value::Text("function"))?;
            doc.append(choice, function)?;
        }
        doc.set(x, "chat_legacy_choice", Value::Bool(true))?;
    }
    Ok(())
}

fn normalize_message(
    doc: &mut Document,
    m: usize,
    current_message: u64,
    registry: &mut Registry,
    owner: &mut Writer,
) -> Result<()> {
    let x = doc.required(doc.root(), "x_ck")?;
    super::request_controls::message(doc, owner, m, current_message)?;
    if let Some(content) = doc.member(m, "content")?
        && matches!(doc.node(content)?.value, Value::Array)
    {
        let mut part = doc.node(content)?.first;
        while let Some(p) = part {
            part = doc.node(p)?.next;
            normalize_part(doc, registry, owner, p)?;
        }
    }
    if let Some(function) = doc.remove(m, "function_call")? {
        if doc.member(m, "tool_calls")?.is_some() {
            return Err(Error::Schema);
        }
        let calls = doc.set(m, "tool_calls", Value::Array)?;
        let call = doc.add(None, Value::Object)?;
        doc.append(calls, call)?;
        doc.set(call, "id", Value::Id(media::local_id(b'l', m as u64)?))?;
        doc.set(call, "type", Value::Text("function"))?;
        doc.rename(function, "function")?;
        doc.append(call, function)?;
        let legacy = match doc.member(x, "chat_legacy_calls")? {
            Some(n) => n,
            None => doc.set(x, "chat_legacy_calls", Value::Array)?,
        };
        let entry = doc.add(None, Value::Object)?;
        doc.append(legacy, entry)?;
        doc.set(entry, "message_index", Value::Unsigned(current_message))?;
        doc.bind_origin(entry, m, None)?;
    }
    if let Some(calls) = doc.member(m, "tool_calls")? {
        require_array(doc, calls)?;
        let mut call = doc.node(calls)?.first;
        while let Some(c) = call {
            call = doc.node(c)?.next;
            let kind = doc.required(c, "type")?;
            let custom = doc.string_is(kind, "custom")?;
            let function = if custom {
                let custom = doc.remove(c, "custom")?.ok_or(Error::Schema)?;
                doc.rename(custom, "function")?;
                doc.append(c, custom)?;
                if let Some(input) = doc.remove(custom, "input")? {
                    doc.rename(input, "arguments")?;
                    doc.append(custom, input)?;
                }
                custom
            } else {
                doc.required(c, "function")?
            };
            doc.set(c, "arguments_format", Value::Text(if custom { "text" } else { "json" }))?;
            if let Some(arguments) = doc.member(function, "arguments")? {
                require_string(doc, arguments)?;
                if !custom {
                    let lease = encode::scratch(owner, |e| {
                        let mut decoded = doc.chars(arguments)?;
                        while let Some(c) = decoded.next_scalar()? {
                            e.bytes(c.encode_utf8(&mut [0; 4]).as_bytes())?;
                        }
                        Ok(())
                    })?;
                    let parsed = doc.import_json(owner, lease)?;
                    doc.transplant(arguments, parsed)?;
                }
            }
        }
    }
    Ok(())
}

fn original_field(doc: &mut Document, original: usize, pointer: &'static str, value: usize) -> Result<()> {
    let entry = doc.add(None, Value::Object)?;
    doc.append(original, entry)?;
    doc.bind_origin(entry, doc.root(), None)?;
    doc.set(entry, "protocol", Value::Text("chat"))?;
    doc.set(entry, "pointer", Value::Text(pointer))?;
    doc.rename(value, "value")?;
    doc.append(entry, value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::{
        RequestEgress, RequestIngress,
        event::{Direction, LocalId},
        source::Span,
    };

    #[test]
    fn unfinished_request_retires_raw_positions_before_completion() {
        let directory = std::env::temp_dir().join(format!("ck-request-retirement-{}", uuid::Uuid::new_v4()));
        let mut config = ck_stream::Config::new(directory.clone());
        config.pool_bytes = Some(48 * ck_stream::FRAME_BYTES);
        config.max_event_bytes = 16 * ck_stream::FRAME_BYTES;
        config.max_metadata_bytes = 4 * 1024 * 1024;
        config.header_slots = 8;
        config.workers = 1;
        let mut store =
            ck_stream::Store::with_clock(config, std::sync::Arc::new(ck_stream::ManualClock::default())).unwrap();
        let mut owner = store.create().unwrap();
        let identity = Identity {
            request_id: LocalId::new("request").unwrap(),
            stream_id: LocalId::new("stream").unwrap(),
            attempt: 1,
            direction: Direction::Request,
        };
        let mut ingress = Ingress::new(&mut owner, &store, identity, Operation::Generate, 100_000).unwrap();
        let prefix = format!(
            r#"{{"model":"m","messages":[{{"role":"user","content":"{}"#,
            "a".repeat(8192)
        );
        ingress.advance(&mut owner, prefix.as_bytes()).unwrap();
        assert!(matches!(
            ingress.document.input().equals(Span { start: 2048, end: 2049 }, b"a"),
            Err(Error::Position)
        ));
        assert!(u64::from(store.used_frames()) <= owner.committed().frame + 2);
        for tail in [b"\\uD83D".as_slice(), b"\\uDE80", b"\xc3", b"\xa9", br#""}]}"#] {
            ingress.advance(&mut owner, tail).unwrap();
        }
        let ready = ingress.finish(&mut owner, &ChatCapability).unwrap();
        let output = Egress {
            destination: "chat",
            upstream_stream: false,
        }
        .encode(&ready, &mut owner)
        .unwrap();
        let mut bytes = Vec::new();
        while bytes.len() < output.len() {
            bytes.extend_from_slice(output.chunk(bytes.len()).unwrap());
        }
        let output: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(output["messages"][0]["content"], format!("{}🚀é", "a".repeat(8192)));
        drop(ingress);
        store.shutdown().unwrap();
        std::fs::remove_dir(directory).unwrap();
    }
}
