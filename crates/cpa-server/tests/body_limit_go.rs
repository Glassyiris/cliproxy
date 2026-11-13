//! Request body limits through the binary's middleware stack in-process.
//! Unchanged routes retain recorded answers; config writes use the admin apply API.
//! Plugin routes are gone with the plugin host; their first-JSON-value vectors replay on
//! `/v0/management/reset-quota` (see `reference/body_limit/README.md`). admin_contract
//! covers admin bodies.
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::{Context, Poll};

use axum::body::{Body, Bytes, HttpBody};
use base64::Engine as _;
use cpa_exec::Executors;
use cpa_exec::claude::ClaudeExecutor;
use cpa_server::config_store::ConfigStore;
use cpa_server::management::{self, Management};
use http_body::{Frame, SizeHint};
use serde_json::Value;
use tower::ServiceExt as _;

/// The client sends this many bytes per frame.
const FRAME: usize = 16;

/// A request body that counts what the server pulled from it.
struct Counted {
    rest: Bytes,
    read: Arc<AtomicU64>,
    declared: bool,
}

impl HttpBody for Counted {
    type Data = Bytes;
    type Error = std::io::Error;

    fn poll_frame(mut self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        if self.rest.is_empty() {
            return Poll::Ready(None);
        }
        let n = self.rest.len().min(FRAME);
        let chunk = self.rest.split_to(n);
        self.read.fetch_add(n as u64, Ordering::Relaxed);
        Poll::Ready(Some(Ok(Frame::data(chunk))))
    }

    fn is_end_stream(&self) -> bool {
        self.rest.is_empty()
    }

    fn size_hint(&self) -> SizeHint {
        if self.declared {
            SizeHint::with_exact(self.rest.len() as u64)
        } else {
            SizeHint::default()
        }
    }
}

fn app(dir: &std::path::Path, yaml: &str) -> (axum::Router, Arc<cpa_server::Runtime>, Arc<ConfigStore>) {
    std::fs::create_dir_all(dir.join("auth")).unwrap();
    let store = Arc::new(ConfigStore::memory_with(yaml));
    let rt = Arc::new(cpa_server::testing::runtime(
        store.load().unwrap().config,
        vec![],
        Executors {
            claude: ClaudeExecutor::new("http://127.0.0.1:1").unwrap(),
            codex: Default::default(),
            devices: Default::default(),
            openai: Default::default(),
            google: Default::default(),
        },
    ));
    let state = Management::with_options(rt.clone(), store.clone(), management::Options::default());
    // crates/cook-router/src/main.rs, without Home, observability and the heap trimmer.
    let app = cpa_server::app(rt.clone(), management::router(state.clone()));
    let app = cpa_server::safe_mode::router(&rt, app);
    let app = app.layer(axum::middleware::from_fn(management::cors));
    let app = cpa_server::request_logging::router(&state, app);
    (cpa_server::body_limit::layer(&rt, app), rt, store)
}

/// Go answers a failed `/openai/v1/videos` request with a random video ID.
fn normalize(body: &str) -> String {
    match serde_json::from_str::<Value>(body) {
        Ok(mut v) if v["object"] == "video" => {
            v["id"] = "video_<id>".into();
            v.to_string()
        }
        Ok(v) => v.to_string(),
        Err(_) => body.to_owned(),
    }
}

#[tokio::test]
async fn body_limit_answers_match_go() {
    let fixture: Vec<Value> = serde_json::from_str(include_str!("fixtures/body_limit_go.json")).unwrap();
    let mut failures = Vec::new();
    for (i, case) in fixture.iter().enumerate() {
        let name = case["name"].as_str().unwrap();
        let dir = std::env::temp_dir().join(format!("cpa-body-limit-{}-{i}", std::process::id()));
        let (app, _, _) = app(&dir, case["yaml"].as_str().unwrap());
        let mut raw = base64::engine::general_purpose::STANDARD
            .decode(case["body_b64"].as_str().unwrap())
            .unwrap();
        if let Some(pad) = case["pad_to"].as_u64() {
            raw.resize(pad as usize, b'p');
        }
        let read = Arc::new(AtomicU64::new(0));
        let chunked = case["chunked"].as_bool().unwrap();
        let mut request = axum::http::Request::builder()
            .method(case["method"].as_str().unwrap())
            .uri(case["path"].as_str().unwrap());
        if !chunked {
            request = request.header("content-length", raw.len());
        }
        for (k, v) in case["headers"].as_object().into_iter().flatten() {
            request = request.header(k, v.as_str().unwrap());
        }
        let len = raw.len() as u64;
        let mut request = request
            .body(Body::new(Counted {
                rest: Bytes::from(raw),
                read: read.clone(),
                declared: !chunked,
            }))
            .unwrap();
        let peer: SocketAddr = "192.0.2.1:1234".parse().unwrap();
        request.extensions_mut().insert(axum::extract::ConnectInfo(peer));
        let response = app.oneshot(request).await.unwrap();
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get("content-type")
            .map(|v| v.to_str().unwrap().to_owned())
            .unwrap_or_default();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body = String::from_utf8_lossy(&body).into_owned();
        let got = (status, content_type, normalize(&body));
        let want = (
            case["status"].as_u64().unwrap() as u16,
            case["content_type"].as_str().unwrap().to_owned(),
            normalize(case["response"].as_str().unwrap()),
        );
        // `/admin/v1` is cook-router's own API: its cases record this server's
        // body-limit and authentication responses.
        if got != want {
            failures.push(format!("{name}: got {got:?}, want {want:?}"));
        }
        // Go reads at most the limit plus one byte; frames arrive whole here.
        let (go_read, rs_read) = (case["read"].as_u64().unwrap(), read.load(Ordering::Relaxed));
        let bounded = if go_read == 0 {
            rs_read == 0
        } else if go_read < len {
            rs_read < go_read + FRAME as u64
        } else {
            true
        };
        if !bounded {
            failures.push(format!("{name}: read {rs_read} of {len} bytes, Go read {go_read}"));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
    assert!(
        failures.is_empty(),
        "{} of {} cases differ:\n{}",
        failures.len(),
        fixture.len(),
        failures.join("\n")
    );
}

/// Go reads the limit from the current config on every request.
#[tokio::test]
async fn a_published_limit_applies_to_the_next_request() {
    let dir = std::env::temp_dir().join(format!("cpa-body-limit-reload-{}", std::process::id()));
    let yaml = "config-version: 8\naccess:\n  api-keys:\n    - test-key\n";
    let (app, _, store) = app(&dir, yaml);
    let send = |app: axum::Router| async move {
        let request = axum::http::Request::post("/v1/responses")
            .header("authorization", "Bearer test-key")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"model":"gpt-5","input":"ok"}"#))
            .unwrap();
        app.oneshot(request).await.unwrap().status().as_u16()
    };
    assert_eq!(send(app.clone()).await, 400, "no limit: the model lookup answers");
    let text = format!("{yaml}server:\n  max-request-body-bytes: 29\n");
    store.import_yaml(&text, "test", "reload body limit").unwrap();
    assert_eq!(send(app).await, 413);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Go stores the middleware's limit on the request: a reload while the body is still
/// arriving does not change the limit its decoding applies.
#[tokio::test]
async fn a_reload_during_a_request_keeps_its_limit() {
    use futures_util::StreamExt as _;
    let dir = std::env::temp_dir().join(format!("cpa-body-limit-mid-{}", std::process::id()));
    let yaml = "config-version: 8\nserver:\n  max-request-body-bytes: 128\naccess:\n  api-keys:\n    - test-key\n";
    let (app, rt, store) = app(&dir, yaml);
    let decoded = format!(r#"{{"model":"gpt-5","input":"{}"}}"#, "z".repeat(512));
    let compressed = zstd::encode_all(decoded.as_bytes(), 3).unwrap();
    assert!(compressed.len() < 128);
    let (tx, rx) = tokio::sync::mpsc::channel::<Bytes>(1);
    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|chunk| (Ok::<_, std::io::Error>(chunk), rx))
    });
    let request = axum::http::Request::post("/v1/responses")
        .header("authorization", "Bearer test-key")
        .header("content-type", "application/json")
        .header("content-encoding", "zstd")
        .body(Body::from_stream(stream.boxed()))
        .unwrap();
    let response = tokio::spawn(app.oneshot(request));
    let (head, tail) = compressed.split_at(compressed.len() / 2);
    tx.send(Bytes::copy_from_slice(head)).await.unwrap();
    // The handler has taken the first half, so the middleware has run.
    while tx.capacity() < tx.max_capacity() {
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let text = yaml.replace("max-request-body-bytes: 128", "max-request-body-bytes: 0");
    store.import_yaml(&text, "test", "reload body limit").unwrap();
    assert_eq!(rt.config().max_request_body_bytes(), None);
    tx.send(Bytes::copy_from_slice(tail)).await.unwrap();
    drop(tx);
    let response = response.await.unwrap().unwrap();
    let status = response.status().as_u16();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(
        (status, String::from_utf8_lossy(&body).as_ref()),
        (
            413,
            r#"{"error":{"message":"Invalid request: http: request body too large","type":"invalid_request_error"}}"#
        )
    );
    let _ = std::fs::remove_dir_all(&dir);
}
