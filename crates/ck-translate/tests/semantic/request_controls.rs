use super::codec::event::Direction;
use super::{ChatCapability, Ingress, Mapped, Operation, RequestIngress, identity, request};
use serde_json::json;

#[test]
fn native_controls_custom_declarations_and_nullable_values_survive_fence() {
    let input = json!({"model":"m","messages":[{"role":"user","content":"x"}],"temperature":0,"top_p":0.8,"max_tokens":4,"max_completion_tokens":8,"seed":-7,"parallel_tool_calls":false,"stream_options":{"include_usage":true},"modalities":["text","audio"],"audio":{"voice":"alloy","format":"wav"},"response_format":{"type":"json_schema","json_schema":{"name":"r","schema":{"type":"object"},"strict":true}},"tools":[{"type":"custom","custom":{"name":"free","format":{"type":"grammar","grammar":{"syntax":"regex","definition":"a+"}}}}],"tool_choice":{"type":"custom","custom":{"name":"free"}},"reasoning_effort":"high","reasoning":{"enabled":true},"prediction":{"type":"content","content":"known"},"vendor":{"future":true}});
    let (output, _) = request(input.to_string().as_bytes());
    for (key, value) in input.as_object().unwrap() {
        assert_eq!(&output[key], value, "{key}");
    }
    let input = json!({"model":"m","messages":[{"role":"assistant","content":null}],"temperature":null,"top_p":null,"tools":null,"tool_choice":null,"audio":null,"modalities":null,"response_format":null,"stream_options":null,"logprobs":null});
    let (output, _) = request(input.to_string().as_bytes());
    for (key, value) in input.as_object().unwrap() {
        assert_eq!(&output[key], value, "{key}");
    }
}

#[test]
fn late_invalid_native_semantics_never_publish_request_end() {
    let invalid = [
        json!({"temperature":"hot"}),
        json!({"top_p":true}),
        json!({"max_completion_tokens":-1}),
        json!({"n":1.5}),
        json!({"seed":1.5}),
        json!({"parallel_tool_calls":"yes"}),
        json!({"stop":["ok",3]}),
        json!({"stream_options":{"include_usage":1}}),
        json!({"modalities":["video"]}),
        json!({"audio":{"voice":"alloy"}}),
        json!({"response_format":{"type":"json_schema","json_schema":{"name":"r","schema":7}}}),
        json!({"tools":[{"type":"function","function":{"name":3}}]}),
        json!({"tools":[{"type":"custom","custom":{"name":"x","format":{"type":"grammar","grammar":{"syntax":"regex"}}}}]}),
        json!({"tool_choice":{"type":"function","function":{"name":"missing"}}}),
        json!({"prediction":{"type":"content","content":[{"type":"text","text":false}]}}),
        json!({"reasoning":false}),
    ];
    for extension in invalid {
        let mut mapped = Mapped::new();
        let mut ingress = Ingress::new(
            &mut mapped.writer,
            &mapped.store,
            identity(Direction::Request),
            Operation::Generate,
            1024 * 1024,
        )
        .unwrap();
        ingress
            .advance(
                &mut mapped.writer,
                br#"{"model":"m","messages":[{"role":"user","content":"prefix"}],"#,
            )
            .unwrap();
        let encoded = extension.to_string();
        let result = ingress.advance(&mut mapped.writer, &encoded.as_bytes()[1..]);
        assert!(
            result.is_err() || ingress.finish(&mut mapped.writer, &ChatCapability).is_err(),
            "accepted {extension}"
        );
        let output = mapped.output(&mapped.writer);
        let text = std::str::from_utf8(&output).unwrap();
        assert!(text.contains("event: x_ck.request.field\n"));
        assert!(text.contains("event: x_ck.error\n"));
        assert!(!text.contains("event: x_ck.request.end\n"));
        assert!(!text.contains("event: x_ck.done\n"));
    }
}
