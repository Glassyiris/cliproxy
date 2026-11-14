use super::{Mapped, Operation, codec, identity};
use codec::{
    BodyMode, ResponseEgress, ResponseIngress,
    document::{Document, Value},
    event::{Direction, Kind},
};
use serde_json::json;
use std::task::Poll;

fn project(wire: &str, mode: BodyMode, mutate: impl Fn(Kind, &mut Document)) -> Vec<u8> {
    let mut mapped = Mapped::new();
    let mut ingress = codec::chat::response::Ingress::new(
        &mut mapped.writer,
        &mapped.store,
        identity(Direction::Response),
        Operation::Generate,
        BodyMode::Streaming,
        1_000_000,
    )
    .unwrap();
    ingress.advance(&mut mapped.writer, wire.as_bytes()).unwrap();
    ingress.finish(&mut mapped.writer).unwrap();
    let mut reader = mapped.store.reader(mapped.writer.id(), 0).unwrap();
    let mut target = mapped.store.create().unwrap();
    while let Poll::Ready(Some(ck_stream::Read::Record(lease))) = reader.try_next() {
        let record = lease.record();
        let (kind, mut doc) = codec::internal::decode(&mut mapped.writer, lease).unwrap();
        mutate(kind, &mut doc);
        let x = doc.required(doc.root(), "x_ck").unwrap();
        let seq = doc.unsigned(doc.required(x, "seq").unwrap()).unwrap();
        codec::encode::publish(&mut target, record.kind, 0, |e| {
            if let Some(name) = kind.name() {
                e.bytes(b"event: ")?;
                e.bytes(name.as_bytes())?;
                e.bytes(b"\n")?;
            }
            e.bytes(b"id: ")?;
            e.unsigned(seq)?;
            e.bytes(b"\ndata: ")?;
            doc.write(doc.root(), e)?;
            e.bytes(b"\n\n")
        })
        .unwrap();
    }
    let mut reader = mapped.store.reader(target.id(), 0).unwrap();
    let mut egress = codec::chat::egress::Egress::new(
        &mut target,
        identity(Direction::Response),
        Operation::Generate,
        mode,
        false,
        |_| {},
    )
    .unwrap();
    let mut output = Vec::new();
    while let Poll::Ready(Some(ck_stream::Read::Record(lease))) = reader.try_next() {
        egress
            .advance(&mut target, lease, |lease| {
                output.extend(super::bytes(&lease));
                Ok(())
            })
            .unwrap();
    }
    egress.finish().unwrap();
    output
}

#[test]
fn trusted_response_edits_replace_media_text_and_delete_provenance_before_delivery() {
    let wire = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"old\",\"vendor\":{\"old\":true},\"audio\":{\"data\":\"AQID\",\"transcript\":\"old\",\"id\":\"a\"}}}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"
    );
    for mode in [BodyMode::Streaming, BodyMode::Buffered] {
        let output = project(wire, mode, |kind, doc| {
            let root = doc.root();
            if kind == Kind::Data {
                doc.set(root, "bytes", Value::Text("BAUG")).unwrap();
            }
            if kind == Kind::MediaTranscript {
                doc.set(root, "text", Value::Text("new")).unwrap();
            }
            if kind == Kind::Chunk {
                let choices = doc.required(root, "choices").unwrap();
                let nodes: Vec<_> = doc.children(choices).unwrap().collect();
                for choice in nodes {
                    let delta = doc.required(choice, "delta").unwrap();
                    if doc.member(delta, "content").unwrap().is_some() {
                        doc.set(delta, "content", Value::Text("new")).unwrap();
                    }
                    doc.remove(delta, "vendor").unwrap();
                }
            }
        });
        let text = String::from_utf8(output).unwrap();
        assert!(!text.contains("old"));
        assert!(!text.contains("vendor"));
        assert!(text.contains("BAUG"));
        assert!(text.contains("new"));
        let deleted = project(wire, mode, |kind, doc| {
            if kind == Kind::MediaStart {
                let attrs = doc.required(doc.root(), "attributes").unwrap();
                doc.remove(attrs, "value").unwrap();
            }
        });
        let deleted = String::from_utf8(deleted).unwrap();
        assert!(!deleted.contains("\"audio\""));
    }
}

#[test]
fn audio_data_reaches_client_before_finish_with_one_lifetime() {
    let mut mapped = Mapped::new();
    let mut ingress = codec::chat::response::Ingress::new(
        &mut mapped.writer,
        &mapped.store,
        identity(Direction::Response),
        Operation::Generate,
        BodyMode::Streaming,
        1_000_000,
    )
    .unwrap();
    let mut reader = mapped.store.reader(mapped.writer.id(), 0).unwrap();
    let mut egress = codec::chat::egress::Egress::new(
        &mut mapped.writer,
        identity(Direction::Response),
        Operation::Generate,
        BodyMode::Streaming,
        false,
        |_| {},
    )
    .unwrap();
    let mut output = Vec::new();
    for (index, audio) in [
        json!({"data":"AQID","transcript":"he"}),
        json!({"id":"late","data":"BA==","transcript":"llo","format":"wav"}),
    ]
    .iter()
    .enumerate()
    {
        let event = json!({"choices":[{"index":7,"delta":{"audio":audio}}]});
        ingress
            .advance(&mut mapped.writer, format!("data: {event}\n\n").as_bytes())
            .unwrap();
        while let Poll::Ready(Some(ck_stream::Read::Record(lease))) = reader.try_next() {
            egress
                .advance(&mut mapped.writer, lease, |lease| {
                    output.extend(super::bytes(&lease));
                    Ok(())
                })
                .unwrap();
        }
        assert!(String::from_utf8_lossy(&output).contains(if index == 0 { "AQID" } else { "BA==" }));
        assert!(!String::from_utf8_lossy(&mapped.output(&mapped.writer)).contains("event: x_ck.media.end"));
    }
    ingress
        .advance(
            &mut mapped.writer,
            b"data: {\"choices\":[{\"index\":7,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
        )
        .unwrap();
    ingress.finish(&mut mapped.writer).unwrap();
    let canonical = String::from_utf8(mapped.output(&mapped.writer)).unwrap();
    assert_eq!(canonical.matches("event: x_ck.media.start\n").count(), 1);
    assert_eq!(canonical.matches("event: x_ck.media.end\n").count(), 1);
    assert!(canonical.contains("\"offset\":3"));
    while let Poll::Ready(Some(ck_stream::Read::Record(lease))) = reader.try_next() {
        egress
            .advance(&mut mapped.writer, lease, |lease| {
                output.extend(super::bytes(&lease));
                Ok(())
            })
            .unwrap();
    }
    egress.finish().unwrap();
    assert_eq!(String::from_utf8_lossy(&output).matches("AQID").count(), 1);
}

#[test]
fn complete_file_occurrences_stay_distinct_and_kind_mime_edits_win() {
    let part =
        json!({"type":"file","file":{"filename":"old.txt","file_data":"data:text/plain;base64,AQID"},"extra":null});
    let event = json!({"choices":[{"index":0,"delta":{"content":[part.clone(),part]},"finish_reason":"stop"}]});
    let wire = format!("data: {event}\n\ndata: [DONE]\n\n");
    for mode in [BodyMode::Streaming, BodyMode::Buffered] {
        let output = project(&wire, mode, |kind, doc| {
            if kind == Kind::MediaStart {
                doc.set(doc.root(), "mime", Value::Text("application/pdf")).unwrap();
                let attrs = doc.required(doc.root(), "attributes").unwrap();
                let value = doc.required(attrs, "value").unwrap();
                let file = doc.required(value, "file").unwrap();
                doc.set(file, "filename", Value::Text("new.pdf")).unwrap();
            }
        });
        let output = String::from_utf8(output).unwrap();
        assert_eq!(output.matches("new.pdf").count(), 2);
        assert_eq!(output.matches("data:application/pdf;base64,AQID").count(), 2);
        assert!(!output.contains("old.txt"));
        assert_eq!(output.matches("\"extra\":null").count(), 2);
    }
}
