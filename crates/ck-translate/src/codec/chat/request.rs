use crate::codec::{
    self, Capability, Error, Operation, RequestFence, RequestView, Result, ValidatedRequest,
    document::{Document, Name, Value},
    encode::{self, Encoder},
    event::{Emitter, Identity, Kind, Scope},
    json::{self, Decoded},
    media::{self, Encoding, Registry},
};
use ck_stream::{ScratchLease, Writer};

pub struct Ingress {
    owner: u64,
    scanner: Option<json::Scanner>,
    document: Document,
    started: bool,
    last_field: Option<usize>,
    messages: Option<PendingMessages>,
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
            if json::string_is(self.document.input(), key, "messages")? {
                if wire.kind != json::Kind::Array {
                    return Err(Error::Schema);
                }
                if self.messages.is_none() {
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
                if scanner.completed_node(self.document.input(), index)?.is_none() {
                    break;
                }
                let node = self.document.import_completed(scanner, index)?;
                let name = self.document.node(node)?.name.ok_or(Error::Schema)?;
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
        let pending = self.messages.as_mut().ok_or(Error::Schema)?;
        let scanner = self.scanner.as_ref().ok_or(Error::Closed)?;
        loop {
            let next = match pending.last {
                Some(last) => scanner.pending_node(self.document.input(), last)?.next,
                None => scanner.pending_node(self.document.input(), pending.wire)?.first,
            };
            let Some(index) = next else { break };
            if scanner.completed_node(self.document.input(), index)?.is_none() {
                break;
            }
            let message = self.document.import_completed(scanner, index)?;
            self.document.append(pending.node, message)?;
            normalize_message(&mut self.document, message, pending.index, &mut self.media, owner)?;
            let mut path = [None; 128];
            path[0] = Some(Component::Name(Name::Static("messages")));
            path[1] = Some(Component::Index(pending.index));
            fields(
                &mut self.document,
                &self.media,
                message,
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
            pending.last = Some(index);
            pending.index += 1;
        }
        Ok(())
    }

    fn prepare(&mut self, owner: &mut Writer) -> Result<()> {
        self.scanner
            .as_mut()
            .ok_or(Error::Closed)?
            .finish(self.document.input())?;
        self.consume(owner)?;
        validate(&self.document)?;
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
    fn advance(&mut self, owner: &mut Writer, bytes: &[u8]) -> Result<()> {
        if owner.id() != self.owner {
            return Err(Error::Position);
        }
        if self.failed {
            return Err(Error::Closed);
        }
        let result = (|| {
            self.document.push_input(owner, bytes)?;
            self.scanner
                .as_mut()
                .ok_or(Error::Closed)?
                .advance(self.document.input())?;
            self.consume(owner)
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
        validate(view.document)
    }
}

fn require_string(doc: &Document, node: usize) -> Result<()> {
    if matches!(doc.node(node)?.value, Value::String(_) | Value::Text(_) | Value::Id(_)) {
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
                Value::String(_) | Value::Text(_) | Value::Null => (),
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
        let entry = doc.add(None, Value::Unsigned(current_message))?;
        doc.append(legacy, entry)?;
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
                    let Value::String(text) = doc.node(arguments)?.value else {
                        return Err(Error::Schema);
                    };
                    let lease = encode::scratch(owner, |e| {
                        let mut decoded = Decoded::new(doc.source(text)?, text.span)?;
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
    doc.set(entry, "protocol", Value::Text("chat"))?;
    doc.set(entry, "pointer", Value::Text(pointer))?;
    doc.rename(value, "value")?;
    doc.append(entry, value)
}

fn normalize_part(doc: &mut Document, registry: &mut Registry, _owner: &mut Writer, part: usize) -> Result<()> {
    let kind = doc.required(part, "type")?;
    if doc.string_is(kind, "text")? {
        require_string(doc, doc.required(part, "text")?)?;
        return Ok(());
    }
    if doc.string_is(kind, "image_url")? {
        let image = doc.remove(part, "image_url")?.ok_or(Error::Schema)?;
        let url = doc.remove(image, "url")?.ok_or(Error::Schema)?;
        require_string(doc, url)?;
        doc.replace(kind, Value::Text("image"))?;
        let source = doc.set(part, "source", Value::Object)?;
        doc.set(source, "kind", Value::Text("uri"))?;
        doc.rename(url, "uri")?;
        doc.append(source, url)?;
        if let Some(detail) = doc.remove(image, "detail")? {
            doc.append(part, detail)?;
        }
        // Remaining native image attributes remain attached to the typed source.
        while let Some(extra) = doc.node(image)?.first {
            doc.detach(image, extra)?;
            doc.append(source, extra)?;
        }
        return Ok(());
    }
    if doc.string_is(kind, "input_audio")? {
        let audio = doc.remove(part, "input_audio")?.ok_or(Error::Schema)?;
        let data = doc.remove(audio, "data")?.ok_or(Error::Schema)?;
        let Value::String(text) = doc.node(data)?.value else {
            return Err(Error::Schema);
        };
        let format = doc.member(audio, "format")?;
        doc.replace(kind, Value::Text("audio"))?;
        let source = doc.set(part, "source", Value::Object)?;
        doc.set(source, "kind", Value::Text("data"))?;
        doc.rename(data, "ref")?;
        doc.append(source, data)?;
        let mime = if let Some(format) = format {
            if doc.string_is(format, "wav")? {
                Some(doc.set(part, "mime", Value::Text("audio/wav"))?)
            } else if doc.string_is(format, "mp3")? {
                Some(doc.set(part, "mime", Value::Text("audio/mpeg"))?)
            } else {
                None
            }
        } else {
            None
        };
        while let Some(extra) = doc.node(audio)?.first {
            doc.detach(audio, extra)?;
            doc.append(source, extra)?;
        }
        registry.register(doc, data, text, Encoding::Base64, "audio", mime)?;
        return Ok(());
    }
    if doc.string_is(kind, "file")? {
        let file = doc.remove(part, "file")?.ok_or(Error::Schema)?;
        doc.replace(kind, Value::Text("document"))?;
        let source = doc.set(part, "source", Value::Object)?;
        if let Some(id) = doc.remove(file, "file_id")? {
            doc.set(source, "kind", Value::Text("file"))?;
            doc.append(source, id)?;
        } else if let Some(data) = doc.remove(file, "file_data")? {
            let Value::String(text) = doc.node(data)?.value else {
                return Err(Error::Schema);
            };
            doc.set(source, "kind", Value::Text("data"))?;
            doc.rename(data, "ref")?;
            doc.append(source, data)?;
            registry.register(doc, data, text, Encoding::Base64, "document", None)?;
        } else {
            return Err(Error::Schema);
        }
        while let Some(extra) = doc.node(file)?.first {
            doc.detach(file, extra)?;
            doc.append(part, extra)?;
        }
        return Ok(());
    }
    if doc.string_is(kind, "refusal")? {
        if let Some(value) = doc.remove(part, "refusal")? {
            doc.rename(value, "text")?;
            doc.append(part, value)?;
        }
        return Ok(());
    }
    for known in [
        "reasoning",
        "reasoning_summary",
        "audio",
        "image",
        "video",
        "document",
        "tool_result",
    ] {
        if doc.string_is(kind, known)? {
            return Ok(());
        }
    }
    let native = doc.add(Some(Name::Static("value")), Value::Object)?;
    while let Some(child) = doc.node(part)?.first {
        doc.detach(part, child)?;
        doc.append(native, child)?;
    }
    doc.set(part, "type", Value::Text("opaque"))?;
    doc.set(part, "protocol", Value::Text("chat"))?;
    doc.append(part, native)
}

#[derive(Clone, Copy)]
enum Component {
    Name(Name),
    Index(u64),
}
fn pointer(doc: &Document, path: &[Option<Component>], e: &mut Encoder<'_, '_>) -> Result<()> {
    e.bytes(b"\"")?;
    for component in path.iter().flatten() {
        e.bytes(b"/")?;
        match component {
            Component::Index(i) => e.unsigned(*i)?,
            Component::Name(name) => {
                let mut decoded = doc.name_chars(*name)?;
                while let Some(c) = decoded.next_scalar()? {
                    pointer_scalar(c, e)?;
                }
            }
        }
    }
    e.bytes(b"\"")
}
fn pointer_scalar(c: char, e: &mut Encoder<'_, '_>) -> Result<()> {
    match c {
        '~' => e.bytes(b"~0"),
        '/' => e.bytes(b"~1"),
        c => e.escaped(c.encode_utf8(&mut [0; 4])),
    }
}
fn field(
    doc: &mut Document,
    media: &Registry,
    node: usize,
    path: &[Option<Component>],
    emitter: &mut Emitter,
    owner: &mut Writer,
    reader: &mut ck_stream::Reader,
) -> Result<bool> {
    let registered = media.get(doc, node)?;
    emitter.emit(
        owner,
        Kind::RequestField,
        Scope::default(),
        |e| {
            e.bytes(b",\"pointer\":")?;
            pointer(doc, path, e)?;
            e.bytes(b",\"value\":")?;
            if let Some(m) = registered {
                return media::write_reference(m, e);
            }
            match doc.node(node)?.value {
                Value::Object => e.bytes(b"{}"),
                Value::Array => e.bytes(b"[]"),
                _ => doc.write(node, e),
            }
        },
        |_| Ok(()),
    )?;
    let (kind, event) = codec::internal::next(owner, reader)?;
    if kind != Kind::RequestField {
        return Err(Error::Schema);
    }
    doc.bind_field(node, event)?;
    Ok(registered.is_some())
}

fn fields(
    doc: &mut Document,
    media: &Registry,
    node: usize,
    (path, depth): (&mut [Option<Component>; 128], usize),
    emitter: &mut Emitter,
    owner: &mut Writer,
    reader: &mut ck_stream::Reader,
) -> Result<()> {
    if depth == path.len() {
        return Err(Error::Limit);
    }
    if field(doc, media, node, &path[..depth], emitter, owner, reader)? {
        return Ok(());
    }
    let mut child = doc.node(node)?.first;
    let mut index = 0;
    while let Some(current) = child {
        child = doc.node(current)?.next;
        path[depth] = Some(if matches!(doc.node(node)?.value, Value::Array) {
            Component::Index(index)
        } else {
            Component::Name(doc.node(current)?.name.ok_or(Error::Schema)?)
        });
        fields(doc, media, current, (path, depth + 1), emitter, owner, reader)?;
        index += 1;
    }
    Ok(())
}

fn write_request(view: RequestView<'_>, streaming: bool, e: &mut Encoder<'_, '_>) -> Result<()> {
    let doc = view.document;
    let root = doc.root();
    let x = doc.required(root, "x_ck")?;
    e.bytes(b"{")?;
    let mut first = true;
    for child in doc.children(root)? {
        let name = doc.node(child)?.name.ok_or(Error::Schema)?;
        if doc.name_is(name, "x_ck")? || doc.name_is(name, "stream")? {
            continue;
        }
        if !first {
            e.bytes(b",")?;
        }
        first = false;
        if doc.name_is(name, "tools")? && doc.member(x, "chat_legacy_functions")?.is_some() {
            e.bytes(b"\"functions\":[")?;
            for (i, tool) in doc.children(child)?.enumerate() {
                if i != 0 {
                    e.bytes(b",")?;
                }
                doc.write(doc.required(tool, "function")?, e)?;
            }
            e.bytes(b"]")?;
        } else if doc.name_is(name, "tool_choice")? && doc.member(x, "chat_legacy_choice")?.is_some() {
            e.bytes(b"\"function_call\":")?;
            if matches!(doc.node(child)?.value, Value::Object) {
                doc.write(doc.required(child, "function")?, e)?;
            } else {
                doc.write(child, e)?;
            }
        } else {
            doc.write_name(name, e)?;
            e.bytes(b":")?;
            if doc.name_is(name, "messages")? {
                e.bytes(b"[")?;
                for (i, message) in doc.children(child)?.enumerate() {
                    if i != 0 {
                        e.bytes(b",")?;
                    }
                    write_message(view, message, i as u64, e)?;
                }
                e.bytes(b"]")?;
            } else {
                doc.write(child, e)?;
            }
        }
    }
    if !first {
        e.bytes(b",")?;
    }
    e.bytes(b"\"stream\":")?;
    e.bytes(if streaming { b"true" } else { b"false" })?;
    if let Some(thinking) = doc.member(x, "thinking")? {
        for (from, to) in [("effort", "reasoning_effort"), ("native", "reasoning")] {
            if let Some(value) = doc.member(thinking, from)? {
                e.bytes(b",")?;
                e.string(to)?;
                e.bytes(b":")?;
                doc.write(value, e)?;
            }
        }
    }
    if let Some(original) = doc.member(x, "original")? {
        for entry in doc.children(original)? {
            let p = doc.required(entry, "pointer")?;
            if doc.string_is(p, "/x_ck")? {
                e.bytes(b",\"x_ck\":")?;
                doc.write(doc.required(entry, "value")?, e)?;
            }
        }
    }
    e.bytes(b"}")
}

fn write_message(view: RequestView<'_>, message: usize, message_index: u64, e: &mut Encoder<'_, '_>) -> Result<()> {
    let doc = view.document;
    e.bytes(b"{")?;
    for (i, field) in doc.children(message)?.enumerate() {
        if i != 0 {
            e.bytes(b",")?;
        }
        let name = doc.node(field)?.name.ok_or(Error::Schema)?;
        if doc.name_is(name, "tool_calls")? {
            let x = doc.required(doc.root(), "x_ck")?;
            let mut legacy = false;
            if let Some(calls) = doc.member(x, "chat_legacy_calls")? {
                for call in doc.children(calls)? {
                    legacy |= doc.unsigned(call)? == message_index;
                }
            }
            if legacy {
                e.bytes(b"\"function_call\":")?;
                write_function(
                    doc,
                    doc.required(doc.node(field)?.first.ok_or(Error::Schema)?, "function")?,
                    false,
                    e,
                )?;
            } else {
                e.bytes(b"\"tool_calls\":[")?;
                for (j, call) in doc.children(field)?.enumerate() {
                    if j != 0 {
                        e.bytes(b",")?;
                    }
                    let custom = doc.string_is(doc.required(call, "arguments_format")?, "text")?;
                    e.bytes(b"{")?;
                    let mut first = true;
                    for member in doc.children(call)? {
                        let name = doc.node(member)?.name.ok_or(Error::Schema)?;
                        if doc.name_is(name, "arguments_format")? {
                            continue;
                        }
                        if !first {
                            e.bytes(b",")?;
                        }
                        first = false;
                        if doc.name_is(name, "function")? {
                            e.string(if custom { "custom" } else { "function" })?;
                            e.bytes(b":")?;
                            write_function(doc, member, custom, e)?;
                        } else {
                            doc.write_name(name, e)?;
                            e.bytes(b":")?;
                            doc.write(member, e)?;
                        }
                    }
                    e.bytes(b"}")?;
                }
                e.bytes(b"]")?;
            }
        } else {
            doc.write_name(name, e)?;
            e.bytes(b":")?;
            if doc.name_is(name, "content")? && matches!(doc.node(field)?.value, Value::Array) {
                e.bytes(b"[")?;
                for (j, part) in doc.children(field)?.enumerate() {
                    if j != 0 {
                        e.bytes(b",")?;
                    }
                    write_part(view, part, e)?;
                }
                e.bytes(b"]")?;
            } else {
                doc.write(field, e)?;
            }
        }
    }
    e.bytes(b"}")
}
fn write_function(doc: &Document, function: usize, custom: bool, e: &mut Encoder<'_, '_>) -> Result<()> {
    e.bytes(b"{")?;
    for (i, field) in doc.children(function)?.enumerate() {
        if i != 0 {
            e.bytes(b",")?;
        }
        let name = doc.node(field)?.name.ok_or(Error::Schema)?;
        if doc.name_is(name, "arguments")? {
            e.string(if custom { "input" } else { "arguments" })?;
            e.bytes(b":")?;
            if custom {
                doc.write(field, e)?;
            } else {
                e.quoted_json(|e| doc.write(field, e))?;
            }
        } else {
            doc.write_name(name, e)?;
            e.bytes(b":")?;
            doc.write(field, e)?;
        }
    }
    e.bytes(b"}")
}
fn write_part(view: RequestView<'_>, part: usize, e: &mut Encoder<'_, '_>) -> Result<()> {
    let doc = view.document;
    let kind = doc.required(part, "type")?;
    if doc.string_is(kind, "opaque")? {
        return doc.write(doc.required(part, "value")?, e);
    }
    if doc.string_is(kind, "image")? {
        let source = doc.required(part, "source")?;
        e.bytes(b"{\"type\":\"image_url\",\"image_url\":{\"url\":")?;
        doc.write(doc.required(source, "uri")?, e)?;
        if let Some(detail) = doc.member(part, "detail")? {
            e.bytes(b",\"detail\":")?;
            doc.write(detail, e)?;
        }
        super::response::members(doc, source, e, &["kind", "uri", "ref"])?;
        e.bytes(b"}")?;
        super::response::members(doc, part, e, &["type", "source", "detail", "mime"])?;
        e.bytes(b"}")
    } else if doc.string_is(kind, "audio")? || doc.string_is(kind, "document")? {
        let audio = doc.string_is(kind, "audio")?;
        let source = doc.required(part, "source")?;
        e.bytes(if audio {
            b"{\"type\":\"input_audio\",\"input_audio\":{"
        } else {
            b"{\"type\":\"file\",\"file\":{"
        })?;
        if let Some(reference) = doc.member(source, "ref")? {
            view.media.get(doc, reference)?.ok_or(Error::Position)?;
            e.string(if audio { "data" } else { "file_data" })?;
            e.bytes(b":")?;
            view.media.write_value(doc, reference, e)?;
        } else {
            e.bytes(b"\"file_id\":")?;
            doc.write(doc.required(source, "file_id")?, e)?;
        }
        if let Some(format) = doc.member(source, "format")? {
            e.bytes(b",\"format\":")?;
            doc.write(format, e)?;
        }
        if let Some(filename) = doc.member(part, "filename")? {
            e.bytes(b",\"filename\":")?;
            doc.write(filename, e)?;
        }
        super::response::members(doc, source, e, &["kind", "ref", "file_id", "format"])?;
        e.bytes(b"}")?;
        super::response::members(doc, part, e, &["type", "source", "filename", "mime"])?;
        e.bytes(b"}")
    } else {
        doc.write(part, e)
    }
}
