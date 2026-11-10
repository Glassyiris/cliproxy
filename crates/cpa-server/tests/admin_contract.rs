//! Admin contract tests use a disposable SQLite database and real loopback HTTP.
//! No provider requests, real credentials, or default auth directory are involved.
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use axum::extract::Request;
use axum::middleware::Next;
use cpa_server::config_store::{ConfigStore, Kind, Op};
use cpa_server::management::{Management, Options};
use cpa_server::{Runtime, management, request_logging};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

const KEY: &str = "admin-http-test-key";
const BODY_LIMIT: usize = 16 * 1024 * 1024;
static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Fixture {
    dir: PathBuf,
    state: Arc<Management>,
    rt: Arc<Runtime>,
    client: wreq::Client,
    base: String,
    server: tokio::task::JoinHandle<()>,
}

impl Fixture {
    async fn new(name: &str, trusted_proxy: bool) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "admin-contract-{name}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(dir.join("auth")).unwrap();
        let hash = bcrypt::hash(KEY, 4).unwrap();
        let trusted = if trusted_proxy {
            "trusted-proxies: ['127.0.0.1']"
        } else {
            "trusted-proxies: []"
        };
        let store = Arc::new(ConfigStore::open(&dir.join("config.db")).unwrap());
        store.import_yaml(&format!(
            "config-version: 8\nserver: {{host: '127.0.0.1', port: 0, {trusted}}}\nmanagement: {{secret-key: '{hash}', allow-remote: false}}\noauth: {{auth-dir: {}}}\nrouting: {{retry: {{request-retry: 3}}}}\naccess: {{api-keys: [client-http-test-secret]}}\nobservability: {{logs: {{request-log: true}}}}\n",
            dir.join("auth").display()
        ), "test", "fixture").unwrap();
        let cfg = store.load().unwrap().config;
        let credentials = cpa_core::config::credentials::from_config(&cfg);
        let rt = Arc::new(cpa_server::testing::runtime(
            cfg,
            credentials,
            cpa_exec::Executors {
                claude: cpa_exec::claude::ClaudeExecutor::new("http://127.0.0.1:9").unwrap(),
                codex: Default::default(),
                devices: Default::default(),
                openai: Default::default(),
                google: Default::default(),
            },
        ));
        let state = Management::with_options(
            rt.clone(),
            store,
            Options {
                management_password: Some(String::new()),
                log_dir: Some(dir.join("logs")),
                ..Default::default()
            },
        );
        let app = management::router(state.clone())
            .route(
                "/capture-probe",
                axum::routing::post(
                    |axum::Extension(_): axum::Extension<request_logging::RequestLog>| async { "capture-active" },
                ),
            )
            .layer(axum::middleware::from_fn(|request: Request, next: Next| async move {
                if request.uri().path() != "/capture-probe" {
                    assert!(
                        request.extensions().get::<request_logging::RequestLog>().is_none(),
                        "admin capture must be bypassed before reading secrets"
                    );
                }
                next.run(request).await
            }));
        let app = request_logging::router(&state, cpa_server::app(rt.clone(), app));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .unwrap();
        });
        let client = wreq::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap();
        Self {
            dir,
            state,
            rt,
            client,
            base,
            server,
        }
    }

    fn request(&self, method: wreq::Method, path: &str) -> wreq::RequestBuilder {
        self.client
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(KEY)
    }

    async fn export(&self) -> (String, Value) {
        let response = self
            .request(wreq::Method::GET, "/admin/v1/export")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let tag = response.headers()["etag"].to_str().unwrap().to_owned();
        let revision = response.headers()["x-cook-revision"]
            .to_str()
            .unwrap()
            .parse::<u64>()
            .unwrap();
        let body = response.json::<Value>().await.unwrap();
        assert_eq!(body["revision"], revision);
        assert_eq!(tag, format!("\"{revision}\""));
        (tag, body)
    }

    fn head(&self) -> u64 {
        self.state.config_store().snapshot().unwrap().0
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn rejected(response: wreq::Response, status: u16, code: &str) -> Value {
    assert_eq!(response.status().as_u16(), status);
    assert!(
        response.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("application/json")
    );
    assert_eq!(response.headers()["cache-control"], "no-store");
    let body = response.json::<Value>().await.unwrap();
    assert_eq!(body["error"], code);
    assert!(body["message"].as_str().is_some());
    body
}

#[tokio::test]
async fn admin_auth_failures_use_the_admin_error_contract_and_expose_revisions() {
    let f = Fixture::new("auth-contract", false).await;
    for (key, status) in [(None, 401), (Some("wrong"), 401)] {
        let mut request = f.client.get(format!("{}/admin/v1/effective/config", f.base));
        if let Some(key) = key {
            request = request.bearer_auth(key);
        }
        let response = request.send().await.unwrap();
        assert!(response.headers().contains_key("x-cook-published-revision"));
        for name in ["x-cook-revision", "x-cook-published-revision"] {
            assert!(
                response
                    .headers()
                    .get_all("access-control-expose-headers")
                    .iter()
                    .any(|field| {
                        field
                            .to_str()
                            .unwrap()
                            .split(',')
                            .any(|value| value.trim().eq_ignore_ascii_case(name))
                    })
            );
        }
        rejected(response, status, "unauthorized").await;
    }
    let response = f
        .request(wreq::Method::GET, "/admin/v1/effective/config")
        .header("x-forwarded-for", "203.0.113.5")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let remote = Fixture::new("remote-auth-contract", true).await;
    rejected(
        remote
            .request(wreq::Method::GET, "/admin/v1/effective/config")
            .header("x-forwarded-for", "203.0.113.5")
            .send()
            .await
            .unwrap(),
        403,
        "forbidden",
    )
    .await;
}

#[tokio::test]
async fn validation_faults_locate_fields_and_reject_partial_plugin_placeholders() {
    let f = Fixture::new("validation-pointers", false).await;
    let fault = rejected(
        f.request(wreq::Method::PUT, "/admin/v1/r/setting/observability")
            .json(&json!({"spec": {"logs": {"debug": []}}}))
            .send()
            .await
            .unwrap(),
        422,
        "invalid_config",
    )
    .await;
    assert_eq!(fault["resource"], "setting/observability");
    assert_eq!(fault["pointer"], "/logs/debug");
    let response = f
        .request(wreq::Method::PUT, "/admin/v1/r/plugin/opaque")
        .json(&json!({"spec": {"token": "plugin-replacement-secret"}}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    for method in [wreq::Method::PUT, wreq::Method::PATCH] {
        let body = if method == wreq::Method::PUT {
            json!({"spec": {"token": "$secret"}})
        } else {
            json!({"token": "$secret"})
        };
        let fault = rejected(
            f.request(method, "/admin/v1/r/plugin/opaque")
                .json(&body)
                .send()
                .await
                .unwrap(),
            422,
            "opaque_config_requires_replacement",
        )
        .await;
        assert_eq!(fault["resource"], "plugin/opaque");
        assert_eq!(fault["pointer"], "/token");
    }
    let response = f
        .request(wreq::Method::PUT, "/admin/v1/r/plugin/opaque")
        .json(&json!({"spec": "$secret"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    for method in [wreq::Method::GET, wreq::Method::PUT, wreq::Method::PATCH] {
        assert_eq!(
            f.request(method, "/v0/management/plugins/opaque/config")
                .json(&json!({}))
                .send()
                .await
                .unwrap()
                .status(),
            404
        );
    }
}

#[tokio::test]
async fn strong_resource_conditions_include_wildcards_lists_and_absence() {
    let f = Fixture::new("conditions", false).await;
    let path = "/admin/v1/r/setting/routing";
    let response = f.request(wreq::Method::GET, path).send().await.unwrap();
    let tag = response.headers()["etag"].to_str().unwrap().to_owned();
    let original = response.json::<Value>().await.unwrap();
    assert_eq!(tag, format!("\"{}\"", original["rev"]));
    for header in ["1", "\"01\"", "\"1", "*, \"1\"", "\"1\",", ""] {
        rejected(
            f.request(wreq::Method::PATCH, path)
                .header("if-match", header)
                .json(&json!({"retry": {"request-retry": 7}}))
                .send()
                .await
                .unwrap(),
            400,
            "invalid_if_match",
        )
        .await;
    }
    rejected(
        f.request(wreq::Method::PATCH, path)
            .header("if-match", format!("W/{tag}"))
            .json(&json!({"retry": {"request-retry": 7}}))
            .send()
            .await
            .unwrap(),
        412,
        "precondition_failed",
    )
    .await;
    for method in [wreq::Method::PUT, wreq::Method::PATCH, wreq::Method::DELETE] {
        for condition in ["*", "\"99999\""] {
            let body = rejected(
                f.request(method.clone(), "/admin/v1/r/client-key/missing")
                    .header("if-match", condition)
                    .json(&json!({"spec": {"key": "must-not-be-created"}}))
                    .send()
                    .await
                    .unwrap(),
                412,
                "precondition_failed",
            )
            .await;
            assert_eq!(body["resource"], "client-key/missing");
        }
    }
    let response = f
        .request(wreq::Method::PATCH, path)
        .header("if-match", format!("W/{tag}, \"0\", {tag}"))
        .json(&json!({"retry": {"request-retry": 7}}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let next_tag = response.headers()["etag"].to_str().unwrap().to_owned();
    let done = response.json::<Value>().await.unwrap();
    assert_eq!(done["resource"]["spec"]["retry"]["request-retry"], 7);
    assert_eq!(next_tag, format!("\"{}\"", done["resource"]["rev"]));
    rejected(
        f.request(wreq::Method::PATCH, path)
            .header("if-match", &tag)
            .json(&json!({"retry": {"request-retry": 2}}))
            .send()
            .await
            .unwrap(),
        412,
        "precondition_failed",
    )
    .await;
    // Wildcard is an existence precondition, not an omitted precondition.
    let response = f
        .request(wreq::Method::PATCH, path)
        .header("if-match", "*")
        .json(&json!({"retry": {"request-retry": 7}}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["etag"], next_tag);
    let no_op = response.json::<Value>().await.unwrap();
    assert_eq!(no_op["written"], false);
    assert_eq!(no_op["resource"], done["resource"]);

    let key_path = "/admin/v1/r/client-key/create-only";
    let create = || {
        f.request(wreq::Method::PUT, key_path)
            .header("if-none-match", "*")
            .json(&json!({"spec": {"key": "create-only-test-secret"}}))
    };
    assert_eq!(create().send().await.unwrap().status(), 200);
    rejected(create().send().await.unwrap(), 412, "precondition_failed").await;
    rejected(
        f.request(wreq::Method::PUT, key_path)
            .header("if-match", "*")
            .header("if-none-match", "*")
            .json(&json!({"spec": {"key": "ignored"}}))
            .send()
            .await
            .unwrap(),
        400,
        "invalid_if_none_match",
    )
    .await;
    rejected(
        f.request(wreq::Method::PATCH, path)
            .header("if-none-match", "*")
            .json(&json!({}))
            .send()
            .await
            .unwrap(),
        400,
        "invalid_if_none_match",
    )
    .await;
}

#[tokio::test]
async fn collection_replacements_require_atomic_global_preconditions() {
    let f = Fixture::new("collection", false).await;
    let (old_tag, backup) = f.export().await;
    let initial = f.head();
    for path in [
        "/admin/v1/import".to_owned(),
        format!("/admin/v1/revisions/{initial}/restore"),
    ] {
        rejected(
            f.request(wreq::Method::POST, &path).json(&backup).send().await.unwrap(),
            428,
            "precondition_required",
        )
        .await;
        rejected(
            f.request(wreq::Method::POST, &path)
                .header("if-match", "*")
                .json(&backup)
                .send()
                .await
                .unwrap(),
            428,
            "precondition_required",
        )
        .await;
        rejected(
            f.request(wreq::Method::POST, &format!("{path}?dry_run=true"))
                .header("if-match", "*")
                .json(&backup)
                .send()
                .await
                .unwrap(),
            428,
            "precondition_required",
        )
        .await;
    }
    // A peer connection commits after the export, without this HTTP server's lock.
    let peer = ConfigStore::open(f.state.config_store().path().unwrap()).unwrap();
    peer.commit_if(
        &[Op::Patch {
            kind: "setting".into(),
            id: "routing".into(),
            patch: json!({"retry": {"request-retry": 8}}),
            if_rev: None,
        }],
        "peer",
        "",
        false,
        None,
    )
    .unwrap();
    let current = f.head();
    assert!(current > initial);
    for path in [
        "/admin/v1/import".to_owned(),
        "/admin/v1/import?dry_run=true".to_owned(),
        format!("/admin/v1/revisions/{initial}/restore"),
    ] {
        rejected(
            f.request(wreq::Method::POST, &path)
                .header("if-match", &old_tag)
                .json(&backup)
                .send()
                .await
                .unwrap(),
            412,
            "precondition_failed",
        )
        .await;
        assert_eq!(f.head(), current);
        assert_eq!(
            f.state
                .config_store()
                .load()
                .unwrap()
                .config
                .routing
                .retry
                .request_retry,
            8
        );
    }
    rejected(
        f.request(wreq::Method::POST, "/admin/v1/apply")
            .header("if-match", &old_tag)
            .json(&json!({"ops": []}))
            .send()
            .await
            .unwrap(),
        412,
        "precondition_failed",
    )
    .await;
    let current_tag = format!("\"{current}\"");
    let response = f
        .request(wreq::Method::POST, "/admin/v1/import?dry_run=true")
        .header("if-match", format!("\"0\", {current_tag}"))
        .json(&backup)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert!(response.headers().get("etag").is_none());
    let body = response.json::<Value>().await.unwrap();
    assert_eq!(body["dry_run"], true);
    assert_eq!(body["written"], false);
    assert_eq!(body["revision"], current);
    assert_eq!(f.head(), current);
    let response = f
        .request(
            wreq::Method::POST,
            &format!("/admin/v1/revisions/{initial}/restore?dry_run=true"),
        )
        .header("if-match", &current_tag)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.json::<Value>().await.unwrap()["written"], false);
    assert_eq!(f.head(), current);
    let response = f
        .request(wreq::Method::POST, "/admin/v1/import")
        .header("if-match", &current_tag)
        .json(&backup)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let head = response.headers()["x-cook-revision"]
        .to_str()
        .unwrap()
        .parse::<u64>()
        .unwrap();
    let body = response.json::<Value>().await.unwrap();
    assert_eq!(body["revision"], head);
    assert_eq!(head, current + 1);
    assert_eq!(f.rt.config().routing.retry.request_retry, 3);
    // Even an uninitialized destination requires its concrete revision 0 rather
    // than a wildcard that says nothing about the snapshot being replaced.
    let conn = rusqlite::Connection::open(f.state.config_store().path().unwrap()).unwrap();
    conn.execute_batch("DELETE FROM change; DELETE FROM resource; DELETE FROM revision;")
        .unwrap();
    assert_eq!(f.head(), 0);
    rejected(
        f.request(wreq::Method::POST, "/admin/v1/import")
            .header("if-match", "*")
            .json(&backup)
            .send()
            .await
            .unwrap(),
        428,
        "precondition_required",
    )
    .await;
    rejected(
        f.request(wreq::Method::POST, "/admin/v1/apply")
            .header("if-match", "*")
            .json(&json!({"ops": []}))
            .send()
            .await
            .unwrap(),
        412,
        "precondition_failed",
    )
    .await;
}

#[tokio::test]
async fn import_validates_the_complete_versioned_envelope_and_media_type() {
    let f = Fixture::new("export-format", false).await;
    let (tag, backup) = f.export().await;
    for (field, replacement, status, code) in [
        ("format", json!("other-config"), 422, "invalid_export"),
        ("version", json!(2), 422, "invalid_export"),
        ("version", json!("1"), 400, "invalid_body"),
        ("revision", json!(-1), 400, "invalid_body"),
        ("unexpected", json!("do-not-echo-this-secret"), 400, "invalid_body"),
    ] {
        let mut invalid = backup.clone();
        invalid[field] = replacement;
        let response = rejected(
            f.request(wreq::Method::POST, "/admin/v1/import")
                .header("if-match", &tag)
                .json(&invalid)
                .send()
                .await
                .unwrap(),
            status,
            code,
        )
        .await;
        assert!(!response.to_string().contains("do-not-echo-this-secret"));
    }
    for field in ["format", "version", "revision", "resources"] {
        let mut invalid = backup.clone();
        invalid.as_object_mut().unwrap().remove(field);
        rejected(
            f.request(wreq::Method::POST, "/admin/v1/import")
                .header("if-match", &tag)
                .json(&invalid)
                .send()
                .await
                .unwrap(),
            400,
            "invalid_body",
        )
        .await;
    }
    rejected(
        f.request(wreq::Method::POST, "/admin/v1/import")
            .header("if-match", &tag)
            .header("content-type", "application/json-not-really")
            .body(backup.to_string())
            .send()
            .await
            .unwrap(),
        415,
        "unsupported_media_type",
    )
    .await;
    let response = f
        .request(wreq::Method::POST, "/admin/v1/import?dry_run=true")
        .header("if-match", &tag)
        .header("content-type", "Application/JSON; charset=utf-8")
        .body(backup.to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(f.head(), backup["revision"].as_u64().unwrap());
}

#[tokio::test]
async fn errors_never_echo_parser_or_database_messages_and_keep_safe_locations() {
    let f = Fixture::new("safe-errors", false).await;
    let parser_secret = "parser-secret-must-not-be-serialized";
    let response = rejected(
        f.request(wreq::Method::PUT, "/admin/v1/r/setting/server")
            .json(&json!({"spec": {"port": parser_secret}}))
            .send()
            .await
            .unwrap(),
        422,
        "invalid_config",
    )
    .await;
    assert!(!response.to_string().contains(parser_secret));
    assert_eq!(response["resource"], "setting/server");
    let response = rejected(
        f.request(wreq::Method::PUT, "/admin/v1/r/provider/missing-secret")
            .json(&json!({"spec": {"type": "claude", "keys": [{"api-key": "$secret"}]}}))
            .send()
            .await
            .unwrap(),
        422,
        "secret_destination_changed",
    )
    .await;
    assert_eq!(response["resource"], "provider/missing-secret");
    // A new provider cannot bind an absent secret to a newly specified destination.
    assert_eq!(response["pointer"], "/keys/0/api-key");
    assert_eq!(response["pointers"], json!(["/keys/0/api-key"]));
    let response = rejected(
        f.request(wreq::Method::PUT, "/admin/v1/r/client-key/missing-secret")
            .json(&json!({"spec": {"key": "$secret"}}))
            .send()
            .await
            .unwrap(),
        422,
        "invalid_config",
    )
    .await;
    assert_eq!(response["resource"], "client-key/missing-secret");
    assert_eq!(response["pointer"], "/key");
    let response = f.request(wreq::Method::PUT, "/admin/v1/r/provider/destination-bound")
        .json(&json!({"spec": {"type": "claude", "base-url": "http://127.0.0.1:1",
            "headers": {"Authorization": "destination-header-secret"}, "keys": [{"api-key": "destination-key-secret"}]}}))
        .send().await.unwrap();
    assert_eq!(response.status(), 200);
    let mut candidate = response.json::<Value>().await.unwrap()["resource"]["spec"].clone();
    candidate["base-url"] = "http://127.0.0.1:2".into();
    let response = rejected(
        f.request(wreq::Method::PUT, "/admin/v1/r/provider/destination-bound")
            .json(&json!({"spec": candidate}))
            .send()
            .await
            .unwrap(),
        422,
        "secret_destination_changed",
    )
    .await;
    assert_eq!(response["resource"], "provider/destination-bound");
    let pointers = response["pointers"].as_array().unwrap();
    assert!(pointers.contains(&json!("/keys/0/api-key")));
    assert!(pointers.contains(&json!("/headers/Authorization")));
    assert!(pointers.contains(&response["pointer"]));
    assert!(!response.to_string().contains("destination-header-secret"));
    assert!(!response.to_string().contains("destination-key-secret"));
    let (tag, _) = f.export().await;
    let response = rejected(
        f.request(wreq::Method::POST, "/admin/v1/import")
            .header("if-match", &tag)
            .header("content-type", "application/yaml")
            .body(format!("server:\n  port: '{parser_secret}'\n"))
            .send()
            .await
            .unwrap(),
        422,
        "invalid_config",
    )
    .await;
    assert!(!response.to_string().contains(parser_secret));
    let response = rejected(
        f.request(wreq::Method::POST, "/admin/v1/apply")
            .json(&json!({"ops": [], "do-not-echo-this-secret": parser_secret}))
            .send()
            .await
            .unwrap(),
        400,
        "invalid_body",
    )
    .await;
    assert!(!response.to_string().contains(parser_secret));
    rejected(
        f.request(wreq::Method::POST, "/admin/v1/apply?dry_run=not-a-bool")
            .json(&json!({"ops": []}))
            .send()
            .await
            .unwrap(),
        400,
        "invalid_query",
    )
    .await;
    rejected(
        f.request(wreq::Method::GET, "/admin/v1/revisions/not-a-number")
            .send()
            .await
            .unwrap(),
        400,
        "invalid_path",
    )
    .await;
    let head = f.head();
    let conn = rusqlite::Connection::open(f.state.config_store().path().unwrap()).unwrap();
    conn.execute_batch("CREATE TRIGGER reject_secret BEFORE INSERT ON resource BEGIN SELECT RAISE(ABORT, 'db-secret-must-not-be-serialized'); END;").unwrap();
    let response = rejected(
        f.request(wreq::Method::PATCH, "/admin/v1/r/setting/routing")
            .json(&json!({"retry": {"request-retry": 9}}))
            .send()
            .await
            .unwrap(),
        500,
        "store_failed",
    )
    .await;
    assert!(!response.to_string().contains("db-secret-must-not-be-serialized"));
    assert_eq!(f.head(), head);
}

#[tokio::test]
async fn ordinary_http_reads_and_write_responses_mask_every_secret() {
    let f = Fixture::new("masked", false).await;
    let secrets = [
        "provider-http-secret",
        "header-http-secret",
        "proxy-http-secret",
        "plugin-http-secret",
        "github-http-secret",
    ];
    for (path, body) in [
        (
            "/admin/v1/r/provider/main",
            json!({"spec": {"type": "claude", "base-url": "http://127.0.0.1:1", "headers": {"Authorization": secrets[1]}, "proxy-url": format!("http://user:{}@127.0.0.1:1", secrets[2]), "keys": [{"api-key": secrets[0]}]}}),
        ),
        ("/admin/v1/r/plugin/opaque", json!({"spec": {"token": secrets[3]}})),
    ] {
        let response = f.request(wreq::Method::PUT, path).json(&body).send().await.unwrap();
        assert_eq!(response.status(), 200);
        let text = response.text().await.unwrap();
        for secret in secrets {
            assert!(!text.contains(secret));
        }
    }
    let response = f
        .request(wreq::Method::PATCH, "/admin/v1/r/setting/server")
        .json(&json!({"github-token": secrets[4]}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert!(!response.text().await.unwrap().contains(secrets[4]));
    let head = f.head();
    for path in [
        "/admin/v1/r/provider".to_owned(),
        "/admin/v1/r/provider/main".to_owned(),
        "/admin/v1/r/client-key".to_owned(),
        "/admin/v1/r/plugin".to_owned(),
        "/admin/v1/r/setting".to_owned(),
        "/admin/v1/effective/config".to_owned(),
        "/admin/v1/export".to_owned(),
        format!("/admin/v1/revisions/{head}"),
    ] {
        let response = f.request(wreq::Method::GET, &path).send().await.unwrap();
        assert_eq!(response.status(), 200, "{path}");
        let text = response.text().await.unwrap();
        for secret in secrets.into_iter().chain(["client-http-test-secret", KEY]) {
            assert!(!text.contains(secret), "{path} leaked a secret");
        }
        assert!(!text.contains("$2b$"), "{path} leaked the management hash");
        assert!(!text.contains("$2a$"), "{path} leaked the management hash");
    }
    let response = f
        .request(wreq::Method::GET, "/admin/v1/export?include_secrets=true")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let text = response.text().await.unwrap();
    for secret in secrets.into_iter().chain(["client-http-test-secret"]) {
        assert!(text.contains(secret));
    }
}

#[tokio::test]
async fn effective_config_indexes_match_live_credentials_before_secrets_are_hidden() {
    let f = Fixture::new("effective-indexes", false).await;
    let response = f.request(wreq::Method::POST, "/admin/v1/apply").json(&json!({"ops": [
        {"op": "put", "kind": "provider", "id": "gemini-index", "spec": {
            "type": "gemini", "base-url": "http://127.0.0.1:1", "headers": {"Authorization": "gemini-header-secret"},
            "keys": [{"api-key": "gemini-index-secret"}]
        }},
        {"op": "put", "kind": "provider", "id": "meta-index", "spec": {
            "type": "meta", "base-url": "http://127.0.0.1:1",
            "keys": [{"api-key": "dca:skipped-index-secret"}, {"api-key": "meta-index-secret"}]
        }}
    ]})).send().await.unwrap();
    assert_eq!(response.status(), 200);
    let credentials = f.rt.store().snapshot();
    let index = |provider: &str| {
        let matches: Vec<_> = credentials.iter().filter(|c| c.provider == provider).collect();
        assert_eq!(
            matches.len(),
            1,
            "the fixture must synthesize one {provider} credential"
        );
        let index = cpa_core::config::credentials::auth_index(matches[0]);
        assert!(!index.is_empty());
        index
    };
    let response = f
        .request(wreq::Method::GET, "/admin/v1/effective/config")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let effective = response.json::<Value>().await.unwrap();
    assert_eq!(
        effective["api-keys"]["gemini"][0]["keys"][0]["auth_index"],
        index("gemini")
    );
    let meta = effective["api-keys"]["meta"][0]["keys"].as_array().unwrap();
    assert!(
        meta[0].get("auth_index").is_none(),
        "the skipped dca: key must not steal the normal key's index"
    );
    assert_eq!(meta[1]["auth_index"], index("meta"));
    for key in effective["api-keys"]["gemini"][0]["keys"]
        .as_array()
        .unwrap()
        .iter()
        .chain(meta)
    {
        assert_eq!(key["api-key"], "$secret");
    }
    for secret in [
        "gemini-index-secret",
        "gemini-header-secret",
        "dca:skipped-index-secret",
        "meta-index-secret",
    ] {
        assert!(!effective.to_string().contains(secret));
    }
}

#[tokio::test]
async fn query_dry_runs_do_not_write_publish_or_contact_an_upstream() {
    let f = Fixture::new("dry-run", false).await;
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_url = format!("http://{}", upstream.local_addr().unwrap());
    let head = f.head();
    let response = f.request(wreq::Method::POST, "/admin/v1/apply?dry_run=true&message=query-message")
        .json(&json!({"ops": [
            {"op": "set", "path": "routing/retry/request-retry", "value": 10},
            {"op": "put", "kind": "provider", "id": "dry-only", "spec": {"type": "claude", "base-url": upstream_url, "keys": [{"api-key": "dry-run-secret"}]}}
        ]})).send().await.unwrap();
    assert_eq!(response.status(), 200);
    assert!(response.headers().get("etag").is_none());
    let body = response.json::<Value>().await.unwrap();
    assert_eq!(body["dry_run"], true);
    assert_eq!(body["written"], false);
    assert_eq!(body["revision"], head);
    assert!(!body["changes"].as_array().unwrap().is_empty());
    assert!(!body.to_string().contains("dry-run-secret"));
    for (method, path, body) in [
        (
            wreq::Method::PUT,
            "/admin/v1/r/client-key/dry-only?dry_run=true",
            json!({"spec": {"key": "dry-client-secret"}}),
        ),
        (
            wreq::Method::PATCH,
            "/admin/v1/r/setting/routing?dry_run=true",
            json!({"retry": {"request-retry": 11}}),
        ),
        (
            wreq::Method::DELETE,
            "/admin/v1/r/setting/routing?dry_run=true",
            json!(null),
        ),
    ] {
        let response = f.request(method, path).json(&body).send().await.unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.json::<Value>().await.unwrap()["written"], false);
    }
    assert_eq!(f.head(), head);
    assert_eq!(f.rt.config().routing.retry.request_retry, 3);
    assert_eq!(
        f.state
            .config_store()
            .load()
            .unwrap()
            .config
            .routing
            .retry
            .request_retry,
        3
    );
    let (_, stored) = f.state.config_store().snapshot().unwrap();
    assert!(!stored.iter().any(|r| r.kind == Kind::Provider && r.id == "dry-only"));
    assert!(!stored.iter().any(|r| r.kind == Kind::ClientKey && r.id == "dry-only"));
    assert!(
        tokio::time::timeout(Duration::from_millis(50), upstream.accept())
            .await
            .is_err(),
        "a dry run contacted an upstream"
    );
}

async fn raw_http(base: &str, headers: &str) -> String {
    let mut stream = tokio::net::TcpStream::connect(base.strip_prefix("http://").unwrap())
        .await
        .unwrap();
    stream.write_all(headers.as_bytes()).await.unwrap();
    let mut response = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut response))
        .await
        .unwrap()
        .unwrap();
    String::from_utf8(response).unwrap()
}

#[tokio::test]
async fn body_limit_is_authenticated_bounded_and_applies_to_chunked_http() {
    let f = Fixture::new("body-bound", false).await;
    for (authorization, status, code) in [
        ("".to_owned(), 401, "missing management key"),
        (format!("Authorization: Bearer {KEY}\r\n"), 413, "body_too_large"),
    ] {
        // No body is sent: authentication and declared-length rejection must not wait
        // for even the first byte of an oversized, attacker-controlled body.
        let response = raw_http(&f.base, &format!(
            "POST /admin/v1/apply HTTP/1.1\r\nHost: localhost\r\n{authorization}Content-Length: {}\r\nConnection: close\r\n\r\n", BODY_LIMIT + 1
        )).await;
        assert!(response.starts_with(&format!("HTTP/1.1 {status}")), "{response}");
        assert!(response.contains(code), "{response}");
    }
    let chunk = bytes::Bytes::from(vec![b' '; 64 * 1024]);
    let chunks = futures_util::stream::iter((0..257).map(move |_| Ok::<_, std::io::Error>(chunk.clone())));
    rejected(
        f.request(wreq::Method::POST, "/admin/v1/apply")
            .body(wreq::Body::wrap_stream(chunks))
            .send()
            .await
            .unwrap(),
        413,
        "body_too_large",
    )
    .await;
    assert_eq!(f.head(), 1);
}

fn log_files(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|path| path.extension().is_some_and(|e| e == "log"))
        .collect()
}

#[tokio::test]
async fn admin_bodies_bypass_capture_and_trusted_proxy_policy_uses_the_real_http_peer() {
    let f = Fixture::new("trust-and-logging", true).await;
    let path = "/admin/v1/effective/config";
    assert_eq!(f.request(wreq::Method::GET, path).send().await.unwrap().status(), 200);
    let forbidden = f
        .request(wreq::Method::GET, path)
        .header("x-forwarded-for", "203.0.113.44")
        .header("x-real-ip", "127.0.0.1")
        .send()
        .await
        .unwrap();
    assert_eq!(
        forbidden.status(),
        403,
        "a trusted proxy's remote client must not inherit loopback privileges"
    );
    assert_eq!(f.request(wreq::Method::POST, "/admin/v1/apply")
        .json(&json!({"ops": [{"op": "put", "kind": "client-key", "id": "logging", "spec": {"key": "capture-must-not-see-this-secret"}}]}))
        .send().await.unwrap().status(), 200);
    let response = f
        .request(wreq::Method::POST, "/%61dmin/v1/apply")
        .body("encoded-path-must-not-be-captured")
        .send()
        .await
        .unwrap();
    let _ = response.bytes().await.unwrap();
    let probe = f
        .client
        .post(format!("{}/capture-probe", f.base))
        .body("ordinary-probe-body")
        .send()
        .await
        .unwrap();
    assert_eq!(probe.status(), 200, "the capture middleware must actually be enabled");
    assert_eq!(probe.text().await.unwrap(), "capture-active");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let files = log_files(&f.dir.join("logs"));
        let contents: Vec<_> = files.iter().map(|p| std::fs::read_to_string(p).unwrap()).collect();
        if contents
            .iter()
            .any(|s| s.contains("ordinary-probe-body") && s.contains("capture-active"))
        {
            assert_eq!(contents.len(), 1, "admin requests must not create capture files");
            assert!(!contents[0].contains("capture-must-not-see-this-secret"));
            assert!(!contents[0].contains("encoded-path-must-not-be-captured"));
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "ordinary probe capture did not finish"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn concurrent_write_responses_keep_the_committed_resource_and_revision_snapshot() {
    let f = Fixture::new("response-snapshot", false).await;
    let responses = futures_util::future::join_all((0..24).map(|i| {
        let request = f
            .request(wreq::Method::PUT, "/admin/v1/r/client-key/racing")
            .json(&json!({"spec": {"key": "racing-test-secret"}, "description": format!("writer-{i}")}));
        async move {
            let response = request.send().await.unwrap();
            assert_eq!(response.status(), 200);
            let revision = response.headers()["x-cook-revision"]
                .to_str()
                .unwrap()
                .parse::<u64>()
                .unwrap();
            let tag = response.headers()["etag"].to_str().unwrap().to_owned();
            let body = response.json::<Value>().await.unwrap();
            assert_eq!(body["revision"], revision);
            assert_eq!(body["resource"]["rev"], revision);
            assert_eq!(body["resource"]["description"], format!("writer-{i}"));
            assert_eq!(body["resource"]["spec"]["key"], "$secret");
            assert_eq!(tag, format!("\"{revision}\""));
            revision
        }
    }))
    .await;
    let mut revisions = responses;
    revisions.sort_unstable();
    revisions.dedup();
    assert_eq!(revisions.len(), 24);
}
