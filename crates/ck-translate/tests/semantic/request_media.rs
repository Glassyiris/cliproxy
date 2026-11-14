use super::request;

#[test]
fn data_uri_images_and_files_decode_bytes_and_restore_native_metadata() {
    let input = br#"{"model":"m","messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,AAECAw==","detail":"high","vendor":{"a/b~c":null}}},{"type":"file","file":{"file_data":"data:application/pdf;base64,AQID","filename":"a.pdf","vendor":{"x_ck":{"attempt":9}}}},{"type":"input_audio","input_audio":{"data":"BAUG","format":"wav","sample_rate":24000,"channels":2,"timing":{"start":0,"unit":"milliseconds"}}}]}]}"#;
    let (output, events) = request(input);
    let original: serde_json::Value = serde_json::from_slice(input).unwrap();
    assert_eq!(output["messages"], original["messages"]);
    for (pointer, mime) in [
        ("/messages/0/content/0/mime", "image/png"),
        ("/messages/0/content/1/mime", "application/pdf"),
    ] {
        assert!(events.iter().any(|e| e["pointer"] == pointer && e["value"] == mime));
    }
    assert!(events.iter().any(|e| e["bytes"] == "AAECAw=="));
    assert!(events.iter().any(|e| e["bytes"] == "AQID"));
    assert!(events.iter().filter(|e| e.get("pointer").is_some()).all(|e| e["value"] != "data:image/png;base64,AAECAw==" && e["value"] != "data:application/pdf;base64,AQID"));
}

#[test]
fn unknown_content_kinds_and_refusals_keep_native_shapes() {
    let input = br#"{"model":"m","messages":[{"role":"assistant","content":[{"type":"refusal","refusal":"no","vendor":0},{"type":"video","source":{"kind":"future","x_ck":{"attempt":8}}}]}]}"#;
    let (output, events) = request(input);
    let original: serde_json::Value = serde_json::from_slice(input).unwrap();
    assert_eq!(output["messages"], original["messages"]);
    assert!(
        events
            .iter()
            .any(|e| e["pointer"] == "/messages/0/content/1/type" && e["value"] == "opaque")
    );
}

#[test]
fn ambiguous_or_invalid_embedded_media_never_authorizes_egress() {
    use super::{ChatCapability, Direction, Ingress, Mapped, Operation, RequestIngress, codec, identity};
    for part in [
        serde_json::json!({"type":"file","file":{"file_id":"id","file_data":"AQID"}}),
        serde_json::json!({"type":"image_url","image_url":{"url":"data:image/png;base64,AA=Z"}}),
        serde_json::json!({"type":"file","file":{"file_data":"data:application/pdf;base64,A"}}),
    ] {
        let input = serde_json::to_vec(&serde_json::json!({"model":"m","messages":[{"role":"user","content":[part]}]}))
            .unwrap();
        let mut mapped = Mapped::new();
        let mut ingress = Ingress::new(
            &mut mapped.writer,
            &mapped.store,
            identity(Direction::Request),
            Operation::Generate,
            4096,
        )
        .unwrap();
        let result = ingress.advance(&mut mapped.writer, &input);
        assert!(result.is_err() || ingress.finish(&mut mapped.writer, &ChatCapability).is_err());
        let events = String::from_utf8(mapped.output(&mapped.writer)).unwrap();
        assert!(!events.contains("event: x_ck.request.end\n"));
        assert!(!events.contains("event: x_ck.done\n"));
        assert!(matches!(
            ingress.finish(&mut mapped.writer, &ChatCapability),
            Err(codec::Error::Closed)
        ));
    }
}
