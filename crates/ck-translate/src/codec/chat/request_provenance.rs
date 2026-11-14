use super::provenance;
use crate::codec::{
    Error, Result,
    document::{Document, Value},
};
use ck_stream::Writer;

#[derive(Clone, Copy)]
enum Context {
    Root,
    Messages,
    Message,
    Parts,
    Part,
    Tools,
    Tool,
    Function,
    Custom,
    Format,
    Grammar,
    Choice,
    ResponseFormat,
    JsonSchema,
    Audio,
    StreamOptions,
    Prediction,
    Calls,
    Call,
    HistoryFunction,
    Extra,
    Google,
    Literal,
}

fn context(doc: &Document, node: usize) -> Result<Context> {
    if node == doc.root() {
        return Ok(Context::Root);
    }
    let Some(parent) = doc.node(node)?.parent else {
        return Ok(Context::Literal);
    };
    let context = context(doc, parent)?;
    let name = doc.node(node)?.name;
    let is = |s| name.map(|n| doc.name_is(n, s)).unwrap_or(Ok(false));
    Ok(match context {
        Context::Root if is("messages")? => Context::Messages,
        Context::Messages => Context::Message,
        Context::Message if is("content")? => Context::Parts,
        Context::Parts => Context::Part,
        Context::Root if is("tools")? => Context::Tools,
        Context::Tools => Context::Tool,
        Context::Tool | Context::Choice if is("function")? => Context::Function,
        Context::Tool | Context::Choice if is("custom")? => Context::Custom,
        Context::Custom if is("format")? => Context::Format,
        Context::Format if is("grammar")? => Context::Grammar,
        Context::Root if is("tool_choice")? => Context::Choice,
        Context::Root if is("response_format")? => Context::ResponseFormat,
        Context::ResponseFormat if is("json_schema")? => Context::JsonSchema,
        Context::Root if is("audio")? => Context::Audio,
        Context::Root if is("stream_options")? => Context::StreamOptions,
        Context::Root if is("prediction")? => Context::Prediction,
        Context::Prediction if is("content")? => Context::Parts,
        Context::Message if is("tool_calls")? => Context::Calls,
        Context::Calls => Context::Call,
        Context::Call if is("function")? || is("custom")? => Context::HistoryFunction,
        Context::Call | Context::HistoryFunction if is("extra_content")? => Context::Extra,
        Context::Extra if is("google")? => Context::Google,
        _ => Context::Literal,
    })
}

pub(super) fn capture(doc: &mut Document, owner: &mut Writer, node: usize) -> Result<Option<usize>> {
    let Some(parent) = doc.node(node)?.parent else {
        return Ok(None);
    };
    if !matches!(doc.node(parent)?.value, Value::Object) {
        return Ok(None);
    }
    let name = doc.node(node)?.name.ok_or(Error::Schema)?;
    if doc.name_is(name, "cache_control")?
        && matches!(
            context(doc, parent)?,
            Context::Message | Context::Part | Context::Tool | Context::Function | Context::Custom
        )
    {
        return super::request_controls::capture_cache(doc, owner, node).map(Some);
    }
    let keys: &[&str] = match context(doc, parent)? {
        Context::Root => &[
            "model",
            "messages",
            "tools",
            "tool_choice",
            "parallel_tool_calls",
            "temperature",
            "top_p",
            "max_tokens",
            "max_completion_tokens",
            "stop",
            "n",
            "seed",
            "stream",
            "stream_options",
            "response_format",
            "logprobs",
            "top_logprobs",
            "logit_bias",
            "presence_penalty",
            "frequency_penalty",
            "modalities",
            "audio",
            "prediction",
            "store",
            "metadata",
            "user",
            "safety_identifier",
            "service_tier",
            "prompt_cache_key",
            "x_ck",
        ],
        Context::Message => &[
            "role",
            "content",
            "name",
            "tool_calls",
            "tool_call_id",
            "function_call",
            "refusal",
            "reasoning_content",
            "audio",
            "cache_control",
        ],
        Context::Part => &[
            "type",
            "text",
            "refusal",
            "image_url",
            "input_audio",
            "file",
            "source",
            "mime",
            "detail",
            "filename",
            "transcript",
            "timing",
            "protocol",
            "value",
            "cache_control",
        ],
        Context::Tool => &["type", "function", "custom", "cache_control"],
        Context::Function => &["name", "description", "parameters", "strict", "cache_control"],
        Context::Custom => &["name", "description", "format", "namespace", "cache_control"],
        Context::Format => &["type", "grammar"],
        Context::Grammar => &["syntax", "definition"],
        Context::Choice => &["type", "function", "custom"],
        Context::ResponseFormat => &["type", "json_schema"],
        Context::JsonSchema => &["name", "description", "schema", "strict"],
        Context::Audio => &["voice", "format"],
        Context::StreamOptions => &["include_usage", "include_obfuscation"],
        Context::Prediction => &["type", "content"],
        Context::Call => &[
            "id",
            "type",
            "function",
            "custom",
            "arguments_format",
            "extra_content",
            "thoughtSignature",
            "thought_signature",
        ],
        Context::HistoryFunction => &[
            "name",
            "arguments",
            "input",
            "namespace",
            "extra_content",
            "thoughtSignature",
            "thought_signature",
        ],
        Context::Extra => &["google"],
        Context::Google => &["thought_signature"],
        _ => return Ok(None),
    };
    for key in keys {
        if doc.name_is(name, key)? {
            return Ok(None);
        }
    }
    provenance::preserve_request_field(doc, owner, node, parent, None).map(Some)
}

pub(super) fn preserved(doc: &Document, mut node: usize) -> Result<bool> {
    let x = doc.required(doc.root(), "x_ck")?;
    while let Some(parent) = doc.node(node)?.parent {
        if parent == x {
            return Ok(true);
        }
        node = parent;
    }
    Ok(false)
}
