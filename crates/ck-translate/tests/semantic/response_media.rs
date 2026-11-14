use super::{codec, response, response_fragmented};
use base64::Engine;
use serde_json::{Value, json};

fn messages(output: &[u8], mode: codec::BodyMode) -> Vec<Value> {
    if mode == codec::BodyMode::Buffered {
        return vec![serde_json::from_slice::<Value>(output).unwrap()["choices"][0]["message"].clone()];
    }
    std::str::from_utf8(output)
        .unwrap()
        .lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter(|line| *line != "[DONE]")
        .flat_map(|line| {
            serde_json::from_str::<Value>(line).unwrap()["choices"]
                .as_array()
                .unwrap()
                .clone()
        })
        .filter_map(|choice| choice.get("delta").cloned())
        .collect()
}

#[test]
fn native_audio_images_annotations_and_ordered_parts_survive_all_modes() {
    let image =
        json!({"type":"image_url","image_url":{"url":"data:image/png;base64,AAEC","detail":"high"},"vendor":{"x":2}});
    let message = json!({"role":"assistant","content":[{"type":"text","text":"before"},image.clone(),{"type":"text","text":"after"}],
        "images":[image],"audio":{"id":"audio-1","data":"AQIDBA==","transcript":"spoken","expires_at":1700000000,"format":"wav","timing":{"start":12}},
        "annotations":[{"type":"url_citation","url_citation":{"start_index":0,"end_index":3,"url":"https://example.invalid","title":"source"},"vendor":7}]});
    for upstream in [codec::BodyMode::Buffered, codec::BodyMode::Streaming] {
        let native = json!({"id":"r","model":"m","created":1,"choices":[{"index":0,if upstream == codec::BodyMode::Buffered { "message" } else { "delta" }:message,"finish_reason":"stop"}]});
        let input = if upstream == codec::BodyMode::Buffered {
            native.to_string()
        } else {
            format!("data: {native}\n\ndata: [DONE]\n\n")
        };
        for downstream in [codec::BodyMode::Buffered, codec::BodyMode::Streaming] {
            let (output, events) = response(input.as_bytes(), upstream, downstream);
            let projected = messages(&output, downstream);
            for field in ["content", "images", "annotations"] {
                let parts: Vec<_> = projected
                    .iter()
                    .filter_map(|part| part.get(field))
                    .flat_map(|array| array.as_array().unwrap().clone())
                    .collect();
                assert_eq!(
                    parts,
                    message[field].as_array().unwrap().clone(),
                    "{upstream:?}/{downstream:?}/{field}"
                );
            }
            assert_eq!(
                projected.iter().find_map(|part| part.get("audio")).unwrap(),
                &message["audio"]
            );
            assert_eq!(
                events
                    .iter()
                    .filter(|event| event["encoding"] == "base64" && event["x_ck"].get("media_id").is_some())
                    .count(),
                3
            );
            assert!(events.iter().any(|event| event["text"] == "spoken"
                && event["final"] == true
                && event["x_ck"].get("media_id").is_some()));
            assert!(
                events
                    .iter()
                    .any(|event| event["kind"] == "chat" && event["value"] == message["annotations"][0])
            );
        }
    }
}

#[test]
fn media_data_event_boundaries_preserve_exact_decoded_bytes() {
    let raw: Vec<u8> = (0..80_003).map(|index| (index % 251) as u8).collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(&raw);
    let native = json!({"id":"r","model":"m","created":1,"choices":[{"index":0,"message":{"role":"assistant","audio":{"id":"a","data":encoded,"transcript":"whole"}},"finish_reason":"stop"}]});
    let input = native.to_string();
    for downstream in [codec::BodyMode::Buffered, codec::BodyMode::Streaming] {
        let (output, events) =
            response_fragmented(input.as_bytes(), codec::BodyMode::Buffered, downstream, input.len());
        let projected = messages(&output, downstream);
        let audio = projected.iter().find_map(|part| part.get("audio")).unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(audio["data"].as_str().unwrap())
                .unwrap(),
            raw
        );
        let data: Vec<_> = events
            .iter()
            .filter(|event| event["bytes"].is_string() && event["x_ck"].get("media_id").is_some())
            .collect();
        assert!(data.len() > 1);
        let mut recovered = Vec::new();
        for (index, event) in data.iter().enumerate() {
            assert_eq!(event["index"], index);
            assert_eq!(event["offset"], recovered.len());
            assert!(format!("event: x_ck.data\nid: {}\ndata: {}\n\n", event["x_ck"]["seq"], event).len() <= 50_000);
            recovered.extend(
                base64::engine::general_purpose::STANDARD
                    .decode(event["bytes"].as_str().unwrap())
                    .unwrap(),
            );
        }
        assert_eq!(recovered, raw);
    }
}

#[test]
fn empty_structured_fields_remain_present() {
    let input = br#"{"id":"r","model":"m","created":1,"choices":[{"index":0,"message":{"role":"assistant","content":[],"images":[],"annotations":[]},"finish_reason":"stop"}]}"#;
    let (output, _) = response(input, codec::BodyMode::Buffered, codec::BodyMode::Buffered);
    let message = &messages(&output, codec::BodyMode::Buffered)[0];
    for field in ["content", "images", "annotations"] {
        assert_eq!(message[field], json!([]));
    }
}
