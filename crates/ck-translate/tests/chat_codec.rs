#[path = "semantic/incremental.rs"]
mod incremental;
#[path = "semantic/request_controls.rs"]
mod request_controls;
#[path = "semantic/mod.rs"]
mod semantic;

#[path = "semantic/request_media.rs"]
mod request_media;

#[path = "semantic/provenance.rs"]
mod provenance;
#[path = "semantic/response_media.rs"]
mod response_media;
#[path = "semantic/terminal.rs"]
mod terminal;
#[path = "semantic/usage.rs"]
mod usage;

use ck_translate::codec::{
    self, Operation, RequestEgress, RequestIngress,
    chat::request::{ChatCapability, Egress, Ingress},
    event::{Direction, Identity, LocalId},
};
use semantic::Mapped;

fn identity(direction: Direction) -> Identity {
    Identity {
        request_id: LocalId::new("request").unwrap(),
        stream_id: LocalId::new("stream").unwrap(),
        attempt: 1,
        direction,
    }
}
fn bytes(lease: &ck_stream::ScratchLease) -> Vec<u8> {
    let mut bytes = Vec::new();
    while bytes.len() < lease.len() {
        bytes.extend_from_slice(lease.chunk(bytes.len()).unwrap());
    }
    bytes
}
fn request(input: &[u8]) -> (serde_json::Value, Vec<serde_json::Value>) {
    request_with_frames(input, 64)
}
fn request_with_frames(input: &[u8], frames: usize) -> (serde_json::Value, Vec<serde_json::Value>) {
    let mut mapped = Mapped::configured(std::sync::Arc::new(ck_stream::ManualClock::default()), frames);
    let mut ingress = Ingress::new(
        &mut mapped.writer,
        &mapped.store,
        identity(Direction::Request),
        Operation::Generate,
        1024 * 1024,
    )
    .unwrap();
    for chunk in input.chunks(19) {
        ingress.advance(&mut mapped.writer, chunk).unwrap();
    }
    let ready = ingress.finish(&mut mapped.writer, &ChatCapability).unwrap();
    let committed = mapped.writer.committed();
    assert_eq!(
        u64::from(mapped.store.used_frames()),
        committed.frame + u64::from(committed.offset != 0),
        "finished request retained noncanonical scratch"
    );
    let output = Egress {
        destination: "chat",
        upstream_stream: true,
    }
    .encode(&ready, &mut mapped.writer)
    .unwrap();
    let value = serde_json::from_slice(&bytes(&output)).unwrap();
    let events = mapped.output(&mapped.writer);
    let events = std::str::from_utf8(&events)
        .unwrap()
        .lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    (value, events)
}

#[test]
fn request_preserves_nullable_content_sampling_and_structured_tool_history() {
    let input = br#"{"model":"m","temperature":0,"top_p":0.9,"messages":[{"role":"assistant","content":null,"tool_calls":[{"id":"call","type":"function","function":{"name":"f","arguments":"{\"nested\":[null,0,\"x\"]}"}}]},{"role":"tool","tool_call_id":"call","content":"ok"}],"x_ck":{"attempt":999,"media":[{"media_id":"spoof"}]},"vendor":{"nested":[null,false]}}"#;
    let (output, events) = request(input);
    assert_eq!(output["messages"][0]["content"], serde_json::Value::Null);
    assert_eq!(output["temperature"], 0);
    assert_eq!(output["top_p"], 0.9);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(
            output["messages"][0]["tool_calls"][0]["function"]["arguments"]
                .as_str()
                .unwrap()
        )
        .unwrap(),
        serde_json::json!({"nested":[null,0,"x"]})
    );
    assert_eq!(output["x_ck"]["attempt"], 999);
    assert_eq!(output["vendor"], serde_json::json!({"nested":[null,false]}));
    let argument = events
        .iter()
        .find(|event| event["pointer"] == "/messages/0/tool_calls/0/function/arguments")
        .unwrap();
    assert_eq!(argument["value"], serde_json::json!({}));
    assert!(events.iter().all(|event| event["x_ck"]["attempt"] == 1));
}

#[test]
fn request_media_is_normalized_and_not_copied_inline_in_canonical_fields() {
    let (output, events) = request(br#"{"model":"m","messages":[{"role":"user","content":[{"type":"text","text":"hi"},{"type":"image_url","image_url":{"url":"https://example.test/a.png","detail":"high"}},{"type":"input_audio","input_audio":{"data":"AAECAw==","format":"wav"}}]}]}"#);
    assert_eq!(output["messages"][0]["content"][1]["image_url"]["detail"], "high");
    assert_eq!(output["messages"][0]["content"][2]["input_audio"]["data"], "AAECAw==");
    assert!(
        events
            .iter()
            .any(|event| event["pointer"] == "/messages/0/content/1/type" && event["value"] == "image")
    );
    assert!(
        events
            .iter()
            .any(|event| event["pointer"] == "/messages/0/content/2/type" && event["value"] == "audio")
    );
    assert!(
        events
            .iter()
            .filter(|event| event.get("pointer").is_some())
            .all(|event| event["value"] != "AAECAw==")
    );
    assert!(events.iter().any(|event| event["bytes"] == "AAECAw=="));
}

#[test]
fn request_rejects_duplicate_decoded_keys_inside_argument_json_and_unlinked_results() {
    for input in [
        br#"{"model":"m","messages":[{"role":"assistant","tool_calls":[{"id":"c","type":"function","function":{"name":"f","arguments":"{\"a\":1,\"\\u0061\":2}"}}]}]}"#.as_slice(),
        br#"{"model":"m","messages":[{"role":"tool","tool_call_id":"unknown","content":"x"}]}"#,
    ] {
        let mut mapped = Mapped::new();
        let mut ingress = Ingress::new(&mut mapped.writer, &mapped.store, identity(Direction::Request), Operation::Generate, 1024 * 1024).unwrap();
        let result = ingress.advance(&mut mapped.writer, input);
        assert!(result.is_err() || ingress.finish(&mut mapped.writer, &ChatCapability).is_err());
        let events = mapped.output(&mapped.writer);
        assert!(!std::str::from_utf8(&events).unwrap().contains("event: x_ck.request.end\n"));
    }
}

#[test]
fn unsupported_operations_never_create_a_chat_body() {
    let mut mapped = Mapped::new();
    for operation in [Operation::CountTokens, Operation::Compact] {
        assert!(matches!(
            Ingress::new(
                &mut mapped.writer,
                &mapped.store,
                identity(Direction::Request),
                operation,
                1024
            ),
            Err(codec::Error::Unsupported)
        ));
    }
    assert!(mapped.output(&mapped.writer).is_empty());
}

fn response(input: &[u8], upstream: codec::BodyMode, downstream: codec::BodyMode) -> (Vec<u8>, Vec<serde_json::Value>) {
    response_fragmented(input, upstream, downstream, 31)
}

fn response_fragmented(
    input: &[u8],
    upstream: codec::BodyMode,
    downstream: codec::BodyMode,
    fragment: usize,
) -> (Vec<u8>, Vec<serde_json::Value>) {
    use codec::{ResponseEgress, ResponseIngress};
    use std::task::Poll;
    let mut mapped = Mapped::new();
    let mut ingress = codec::chat::response::Ingress::new(
        &mut mapped.writer,
        identity(Direction::Response),
        Operation::Generate,
        upstream,
        1024 * 1024,
    )
    .unwrap();
    let mut reader = mapped.store.reader(mapped.writer.id(), 0).unwrap();
    let mut egress = codec::chat::egress::Egress::new(
        &mut mapped.writer,
        identity(Direction::Response),
        Operation::Generate,
        downstream,
        true,
        |_| panic!("unexpected projection loss"),
    )
    .unwrap();
    let mut result = Vec::new();
    for chunk in input.chunks(fragment) {
        ingress.advance(&mut mapped.writer, chunk).unwrap();
    }
    ingress.finish(&mut mapped.writer).unwrap();
    while let Poll::Ready(Some(ck_stream::Read::Record(lease))) = reader.try_next() {
        egress
            .advance(&mut mapped.writer, lease, |lease| {
                result.extend_from_slice(&bytes(&lease));
                Ok(())
            })
            .unwrap();
    }
    egress.finish().unwrap();
    let canonical = mapped.output(&mapped.writer);
    let events = std::str::from_utf8(&canonical)
        .unwrap()
        .lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    (result, events)
}

#[test]
fn response_choices_tools_and_usage_remain_independent() {
    let wire = concat!(
        "data: {\"id\":\"r\",\"model\":\"m\",\"created\":1,\"choices\":[{\"index\":2,\"delta\":{\"role\":\"assistant\",\"content\":\"two\"},\"finish_reason\":null},{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":3,\"id\":\"a\",\"type\":\"function\",\"function\":{\"name\":\"f\",\"arguments\":\"{\\\"a\\\":\"}},{\"index\":7,\"id\":\"b\",\"type\":\"function\",\"function\":{\"name\":\"g\",\"arguments\":\"{}\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"id\":\"r\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":3,\"function\":{\"arguments\":\"1}\"}}]},\"finish_reason\":\"tool_calls\"},{\"index\":2,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":2,\"prompt_tokens_details\":{\"cached_tokens\":0,\"vendor_ttl\":{\"300\":2}}}}\n\n",
        "data: {\"choices\":[],\"usage\":{\"completion_tokens\":3}}\n\n",
        "data: [DONE]\n\n"
    );
    let (result, events) = response(wire.as_bytes(), codec::BodyMode::Streaming, codec::BodyMode::Buffered);
    let result: serde_json::Value = serde_json::from_slice(&result).unwrap();
    assert_eq!(result["choices"][0]["index"], 2);
    assert_eq!(result["choices"][0]["message"]["content"], "two");
    let calls = &result["choices"][1]["message"]["tool_calls"];
    assert_eq!(calls[0]["id"], "a");
    assert_eq!(calls[0]["function"]["arguments"], "{\"a\":1}");
    assert_eq!(calls[1]["function"]["arguments"], "{}");
    assert_eq!(result["usage"]["completion_tokens"], 3);
    assert_eq!(result["usage"]["total_tokens"], 13);
    assert_eq!(result["usage"]["prompt_tokens_details"]["vendor_ttl"]["300"], 2);
    assert!(
        events
            .iter()
            .filter_map(|event| event["choices"].as_array())
            .all(|choices| choices.len() <= 1)
    );
}

#[test]
fn buffered_response_projects_streaming_with_empty_refusal_and_logprobs() {
    let input = br#"{"id":"r","object":"chat.completion","created":1,"model":"m","choices":[{"index":0,"message":{"role":"assistant","content":"","refusal":""},"logprobs":{"content":[{"token":"x","bytes":[120],"top_logprobs":[]}]},"finish_reason":"stop"}],"usage":{"prompt_tokens":0,"completion_tokens":0}}"#;
    let (output, events) = response(input, codec::BodyMode::Buffered, codec::BodyMode::Streaming);
    let text = std::str::from_utf8(&output).unwrap();
    assert_eq!(text.matches("data: [DONE]").count(), 1);
    let logprobs = events
        .iter()
        .find(|event| event["choices"][0].get("logprobs").is_some())
        .unwrap();
    assert_eq!(logprobs["choices"][0]["delta"], serde_json::json!({}));
    assert_eq!(
        logprobs["choices"][0]["logprobs"]["content"][0]["bytes"],
        serde_json::json!([120])
    );
    assert!(text.contains("\"refusal\":\"\""));
}

#[test]
fn tool_arguments_are_published_before_finish_and_truncation_never_succeeds() {
    use codec::ResponseIngress;
    let mut mapped = Mapped::new();
    let mut ingress = codec::chat::response::Ingress::new(
        &mut mapped.writer,
        identity(Direction::Response),
        Operation::Generate,
        codec::BodyMode::Streaming,
        1024 * 1024,
    )
    .unwrap();
    ingress.advance(&mut mapped.writer, b"data: {\"id\":\"r\",\"model\":\"m\",\"created\":1,\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c\",\"type\":\"function\",\"function\":{\"name\":\"f\",\"arguments\":\"{\"}}]},\"finish_reason\":null}]}\n\n").unwrap();
    let output = mapped.output(&mapped.writer);
    assert!(std::str::from_utf8(&output).unwrap().contains("\"arguments\":\"{\""));
    assert!(ingress.finish(&mut mapped.writer).is_err());
    let output = mapped.output(&mapped.writer);
    let text = std::str::from_utf8(&output).unwrap();
    assert!(text.contains("event: x_ck.error\n"));
    assert!(!text.contains("event: x_ck.done\n"));
    assert!(!text.contains("event: x_ck.tool.end\n"));
}

#[test]
fn legacy_functions_and_selection_keep_native_spelling() {
    let (out, _) =
        request(br#"{"model":"m","messages":[],"functions":[{"name":"a"},{"name":"b"}],"function_call":{"name":"a"}}"#);
    assert_eq!(out["functions"], serde_json::json!([{"name":"a"},{"name":"b"}]));
    assert_eq!(out["function_call"], serde_json::json!({"name":"a"}));
    assert!(out.get("tool_choice").is_none());
}

#[test]
fn wire_legacy_marker_cannot_erase_modern_history() {
    let (out, _) = request(br#"{"model":"m","messages":[{"role":"assistant","tool_calls":[{"id":"a","type":"function","chat_legacy":false,"function":{"name":"a","arguments":"{}"}},{"id":"b","type":"function","function":{"name":"b","arguments":"{}"}}]}]}"#);
    assert_eq!(out["messages"][0]["tool_calls"][1]["id"], "b");
    assert_eq!(out["messages"][0]["tool_calls"][0]["chat_legacy"], false);
    assert!(out["messages"][0].get("function_call").is_none());
}

#[test]
fn mapped_image_extensions_keep_native_locations() {
    let (out, _) = request(br#"{"model":"m","messages":[{"role":"user","content":[{"type":"image_url","vendor_part":1,"image_url":{"url":"https://example.test/image","vendor_image":{"k":2}}}]}]}"#);
    assert_eq!(out["messages"][0]["content"][0]["vendor_part"], 1);
    assert_eq!(
        out["messages"][0]["content"][0]["image_url"]["vendor_image"],
        serde_json::json!({"k":2})
    );
}

#[test]
fn native_image_ref_collision_preserves_url_and_unknown_data() {
    let input = serde_json::json!({"model":"m","messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"https://example.invalid/a.png","ref":"literal"}}]}]});
    let (output, _) = request(input.to_string().as_bytes());
    assert_eq!(output["messages"], input["messages"]);
}

#[test]
fn malformed_request_advance_publishes_only_error_terminal() {
    let mut mapped = Mapped::new();
    let mut ingress = Ingress::new(
        &mut mapped.writer,
        &mapped.store,
        identity(Direction::Request),
        Operation::Generate,
        1024,
    )
    .unwrap();
    assert!(ingress.advance(&mut mapped.writer, b"{]").is_err());
    assert!(ingress.finish(&mut mapped.writer, &ChatCapability).is_err());
    let output = mapped.output(&mapped.writer);
    let output = std::str::from_utf8(&output).unwrap();
    assert!(output.contains("event: x_ck.error\n"));
    assert!(!output.contains("event: x_ck.request.end\n"));
    assert!(!output.contains("event: x_ck.done\n"));
}

#[test]
fn media_registration_rejects_replacement_and_another_document() {
    use codec::{
        RequestFence, RequestView,
        document::{Document, Value},
        media::{Encoding, Registry},
        source::Source,
    };
    let mut mapped = Mapped::new();
    let mut source = Source::new(&mut mapped.writer).unwrap();
    source.push_bytes(&mut mapped.writer, br#"{"model":"m","x_ck":{},"messages":[{"role":"user","content":[{"type":"audio","source":{"kind":"data","ref":"AQID","format":"wav"}}]}]}"#).unwrap();
    let mut doc = Document::parse(&mut mapped.writer, source, 4096).unwrap();
    let messages = doc.required(doc.root(), "messages").unwrap();
    let message = doc.children(messages).unwrap().next().unwrap();
    let content = doc.required(message, "content").unwrap();
    let part = doc.children(content).unwrap().next().unwrap();
    let source = doc.required(part, "source").unwrap();
    let reference = doc.required(source, "ref").unwrap();
    let Value::String(text) = doc.node(reference).unwrap().value else {
        panic!("non-string reference")
    };
    let mut media = Registry::new(&mut mapped.writer).unwrap();
    media
        .register(&mut doc, reference, text, Encoding::Base64, "audio", None)
        .unwrap();
    let mut other = Source::new(&mut mapped.writer).unwrap();
    other
        .push_bytes(&mut mapped.writer, br#"{"model":"m","x_ck":{},"messages":[]}"#)
        .unwrap();
    let other = Document::parse(&mut mapped.writer, other, 4096).unwrap();
    assert!(
        RequestFence::default()
            .end(
                RequestView {
                    document: &other,
                    media: &media,
                    operation: Operation::Generate
                },
                &ChatCapability
            )
            .is_err()
    );
    doc.replace(reference, Value::Text("replacement")).unwrap();
    assert!(
        RequestFence::default()
            .end(
                RequestView {
                    document: &doc,
                    media: &media,
                    operation: Operation::Generate,
                },
                &ChatCapability,
            )
            .is_err()
    );
    doc.remove(message, "content").unwrap();
    let ready = RequestFence::default()
        .end(
            RequestView {
                document: &doc,
                media: &media,
                operation: Operation::Generate,
            },
            &ChatCapability,
        )
        .unwrap();
    let output = Egress {
        destination: "chat",
        upstream_stream: false,
    }
    .encode(&ready, &mut mapped.writer)
    .unwrap();
    let output: serde_json::Value = serde_json::from_slice(&bytes(&output)).unwrap();
    assert!(output["messages"][0].get("content").is_none());
}

#[test]
fn codecs_reject_foreign_owners_without_publishing_errors() {
    use codec::{ResponseEgress, ResponseIngress};
    use std::task::Poll;
    let mut mapped = Mapped::new();
    let mut other = mapped.store.create().unwrap();
    let mut request = Ingress::new(
        &mut mapped.writer,
        &mapped.store,
        identity(Direction::Request),
        Operation::Generate,
        1024,
    )
    .unwrap();
    let mut response = codec::chat::response::Ingress::new(
        &mut mapped.writer,
        identity(Direction::Response),
        Operation::Generate,
        codec::BodyMode::Streaming,
        1024,
    )
    .unwrap();
    let mut egress = codec::chat::egress::Egress::new(
        &mut mapped.writer,
        identity(Direction::Response),
        Operation::Generate,
        codec::BodyMode::Streaming,
        true,
        |_| {},
    )
    .unwrap();
    let before = other.committed();
    assert!(matches!(
        request.advance(&mut other, b"{}"),
        Err(codec::Error::Position)
    ));
    assert!(matches!(
        request.finish(&mut other, &ChatCapability),
        Err(codec::Error::Position)
    ));
    assert!(matches!(
        response.advance(&mut other, b"data: {}\n\n"),
        Err(codec::Error::Position)
    ));
    assert!(matches!(response.finish(&mut other), Err(codec::Error::Position)));
    assert_eq!(other.committed(), before);
    let mut reader = mapped.store.reader(other.id(), 0).unwrap();
    let mut foreign = codec::chat::response::Ingress::new(
        &mut other,
        identity(Direction::Response),
        Operation::Generate,
        codec::BodyMode::Streaming,
        1024,
    )
    .unwrap();
    foreign.advance(&mut other, b"data: {\"id\":\"r\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hello\"},\"finish_reason\":\"stop\"}]}\n\n").unwrap();
    let Poll::Ready(Some(ck_stream::Read::Record(lease))) = reader.try_next() else {
        panic!("missing response start")
    };
    assert!(matches!(
        egress.advance(&mut other, lease, |_| panic!("foreign output")),
        Err(codec::Error::Position)
    ));
}

#[test]
fn heartbeat_does_not_replace_provider_identity() {
    let wire = concat!(
        ": ping\n\n",
        "data: {\"id\":\"provider-id\",\"model\":\"provider-model\",\"created\":123,\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hello\"},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    let (bytes, _) = response(wire.as_bytes(), codec::BodyMode::Streaming, codec::BodyMode::Buffered);
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["id"], "provider-id");
    assert_eq!(value["model"], "provider-model");
    assert_eq!(value["created"], 123);
    assert_eq!(value["choices"][0]["message"]["content"], "hello");
}

fn canonical_values(mapped: &Mapped) -> Vec<serde_json::Value> {
    let output = mapped.output(&mapped.writer);
    std::str::from_utf8(&output)
        .unwrap()
        .lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[test]
fn completed_request_fields_and_messages_publish_before_the_body_ends() {
    let mut mapped = Mapped::configured(std::sync::Arc::new(ck_stream::ManualClock::default()), 256);
    let mut ingress = Ingress::new(
        &mut mapped.writer,
        &mapped.store,
        identity(Direction::Request),
        Operation::Generate,
        4096,
    )
    .unwrap();
    ingress
        .advance(
            &mut mapped.writer,
            br#"{"model":"m","messages":[{"role":"user","content":"first"},"#,
        )
        .unwrap();
    let prefix = canonical_values(&mapped);
    assert!(
        prefix
            .iter()
            .any(|event| event["pointer"] == "/model" && event["value"] == "m")
    );
    assert!(
        prefix
            .iter()
            .any(|event| event["pointer"] == "/messages/0/content" && event["value"] == "first")
    );
    assert!(
        !String::from_utf8(mapped.output(&mapped.writer))
            .unwrap()
            .contains("event: x_ck.request.end\n")
    );
    for byte in
        br#"{"role":"user","content":"second"}],"temperature":0,"reasoning_effort":"low","reasoning":{"budget":0}}"#
    {
        ingress.advance(&mut mapped.writer, &[*byte]).unwrap();
    }
    let ready = ingress.finish(&mut mapped.writer, &ChatCapability).unwrap();
    let output = Egress {
        destination: "chat",
        upstream_stream: false,
    }
    .encode(&ready, &mut mapped.writer)
    .unwrap();
    let output: serde_json::Value = serde_json::from_slice(&bytes(&output)).unwrap();
    assert_eq!(
        output["messages"],
        serde_json::json!([
            {"role":"user","content":"first"}, {"role":"user","content":"second"}
        ])
    );
    assert_eq!(output["reasoning_effort"], "low");
    assert_eq!(output["reasoning"], serde_json::json!({"budget":0}));
    let mut assigned = std::collections::HashSet::new();
    for event in canonical_values(&mapped) {
        let Some(pointer) = event["pointer"].as_str() else {
            continue;
        };
        assert!(assigned.insert(pointer.to_owned()), "duplicate assignment: {pointer}");
        if let Some((parent, _)) = pointer.rsplit_once('/') {
            assert!(assigned.contains(parent), "missing parent: {parent}");
        }
        if event["value"].is_array() || event["value"].is_object() {
            assert!(
                event["value"]
                    .as_array()
                    .map_or_else(|| event["value"].as_object().unwrap().is_empty(), Vec::is_empty)
            );
        }
    }
}

#[test]
fn late_destination_rejection_keeps_published_prefix_without_success() {
    struct TextOnly;
    impl codec::Capability for TextOnly {
        fn destination(&self) -> &'static str {
            "text-only"
        }
        fn validate(&self, view: codec::RequestView<'_>) -> codec::Result<()> {
            let doc = view.document;
            assert!(doc.member(doc.root(), "model")?.is_some());
            if doc.member(doc.root(), "modalities")?.is_some() {
                Err(codec::Error::Unsupported)
            } else {
                Ok(())
            }
        }
    }
    let mut mapped = Mapped::new();
    let mut ingress = Ingress::new(
        &mut mapped.writer,
        &mapped.store,
        identity(Direction::Request),
        Operation::Generate,
        4096,
    )
    .unwrap();
    ingress
        .advance(&mut mapped.writer, br#"{"model":"m","messages":[],"#)
        .unwrap();
    assert!(canonical_values(&mapped).iter().any(|e| e["pointer"] == "/model"));
    ingress
        .advance(&mut mapped.writer, br#""modalities":["audio"]}"#)
        .unwrap();
    assert!(matches!(
        ingress.finish(&mut mapped.writer, &TextOnly),
        Err(codec::Error::Unsupported)
    ));
    assert!(ingress.finish(&mut mapped.writer, &ChatCapability).is_err());
    let output = String::from_utf8(mapped.output(&mapped.writer)).unwrap();
    assert!(output.contains("event: x_ck.error\n"));
    assert!(!output.contains("event: x_ck.request.end\n"));
    assert!(!output.contains("event: x_ck.done\n"));
}

#[test]
fn normalized_alias_collisions_fail_in_either_source_order() {
    for input in [
        br#"{"model":"m","messages":[],"functions":[],"tools":[]}"#.as_slice(),
        br#"{"model":"m","messages":[],"tools":[],"functions":[]}"#,
        br#"{"model":"m","messages":[],"function_call":"auto","tool_choice":"none"}"#,
        br#"{"model":"m","messages":[],"tool_choice":"auto","function_call":"none"}"#,
    ] {
        let mut mapped = Mapped::new();
        let mut ingress = Ingress::new(
            &mut mapped.writer,
            &mapped.store,
            identity(Direction::Request),
            Operation::Generate,
            4096,
        )
        .unwrap();
        let result = ingress.advance(&mut mapped.writer, input);
        assert!(result.is_err() || ingress.finish(&mut mapped.writer, &ChatCapability).is_err());
        let output = String::from_utf8(mapped.output(&mapped.writer)).unwrap();
        assert!(!output.contains("event: x_ck.request.end\n"));
    }
}

#[test]
fn completed_message_media_is_available_before_later_request_fields() {
    let mut mapped = Mapped::new();
    let mut ingress = Ingress::new(
        &mut mapped.writer,
        &mapped.store,
        identity(Direction::Request),
        Operation::Generate,
        4096,
    )
    .unwrap();
    ingress.advance(&mut mapped.writer, br#"{"model":"m","messages":[{"role":"user","content":[{"type":"input_audio","input_audio":{"data":"AAECAw==","format":"wav"}}]}],"#).unwrap();
    let prefix = canonical_values(&mapped);
    let reference = prefix
        .iter()
        .find(|event| event["pointer"] == "/messages/0/content/0/source/ref")
        .unwrap();
    assert_eq!(reference["value"]["value_kind"], "bytes");
    let media_id = &reference["value"]["media_id"];
    assert!(
        prefix
            .iter()
            .any(|event| event["x_ck"]["media_id"] == *media_id && event["bytes"] == "AAECAw==")
    );
    let output = String::from_utf8(mapped.output(&mapped.writer)).unwrap();
    assert!(output.contains("event: x_ck.media.end\n"));
    assert!(!output.contains("event: x_ck.request.end\n"));
    ingress.advance(&mut mapped.writer, br#""top_p":0.5}"#).unwrap();
    let ready = ingress.finish(&mut mapped.writer, &ChatCapability).unwrap();
    let output = Egress {
        destination: "chat",
        upstream_stream: true,
    }
    .encode(&ready, &mut mapped.writer)
    .unwrap();
    let output: serde_json::Value = serde_json::from_slice(&bytes(&output)).unwrap();
    assert_eq!(output["messages"][0]["content"][0]["input_audio"]["data"], "AAECAw==");
    assert_eq!(output["top_p"], 0.5);
    let events = String::from_utf8(mapped.output(&mapped.writer)).unwrap();
    assert_eq!(events.matches("event: x_ck.media.start\n").count(), 1);
    assert_eq!(events.matches("event: x_ck.media.end\n").count(), 1);
}

#[test]
fn invalid_suffix_cannot_complete_an_incrementally_published_request() {
    for suffix in [
        br#""model":"replacement"}"#.as_slice(),
        br#""late":true}false"#,
        br#""late":"\uD800"}"#,
    ] {
        let mut mapped = Mapped::new();
        let mut ingress = Ingress::new(
            &mut mapped.writer,
            &mapped.store,
            identity(Direction::Request),
            Operation::Generate,
            4096,
        )
        .unwrap();
        ingress
            .advance(
                &mut mapped.writer,
                br#"{"model":"m","messages":[{"role":"user","content":"kept"}],"#,
            )
            .unwrap();
        assert!(
            canonical_values(&mapped)
                .iter()
                .any(|e| e["pointer"] == "/messages/0/content" && e["value"] == "kept")
        );
        let result = ingress.advance(&mut mapped.writer, suffix);
        assert!(result.is_err() || ingress.finish(&mut mapped.writer, &ChatCapability).is_err());
        let before = mapped.output(&mapped.writer);
        assert!(ingress.advance(&mut mapped.writer, b" ").is_err());
        assert_eq!(mapped.output(&mapped.writer), before);
        let events = String::from_utf8(before).unwrap();
        assert_eq!(events.matches("event: x_ck.error\n").count(), 1);
        assert!(!events.contains("event: x_ck.request.end\n"));
        assert!(!events.contains("event: x_ck.done\n"));
    }
}
