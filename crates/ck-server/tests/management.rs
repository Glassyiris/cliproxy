//! Disposable local server only: no provider endpoints or credential exchanges.
use ck_core::config::Config;
use ck_core::gostr::GoStr;
use ck_exec::Executors;
use ck_exec::claude::ClaudeExecutor;
use ck_server::credential_store::CredentialDb;
use ck_server::management::Management;
use ck_server::{Runtime, management, watching};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;

struct Fixture {
    dir: PathBuf,
    state: Arc<Management>,
    rt: Arc<Runtime>,
}
#[tokio::test]
async fn codex_passive_quota_snapshots_appear_in_credential_entries() {
    let f = Fixture::from_yaml("codex-quota", |auth, hash| {
        std::fs::write(
            auth.join("codex-a.json"),
            r#"{"type":"codex","email":"a@example.invalid"}"#,
        )
        .unwrap();
        std::fs::write(
            auth.join("claude-b.json"),
            r#"{"type":"claude","email":"b@example.invalid"}"#,
        )
        .unwrap();
        format!("config-version: 8\nmanagement:\n  secret-key: '{hash}'\n",)
    });
    let snapshot = f.rt.store().snapshot();
    let id = |provider: &str| snapshot.iter().find(|c| c.provider == provider).unwrap().id.clone();
    let (codex, claude) = (id("codex"), id("claude"));
    let mut headers = axum::http::HeaderMap::new();
    headers.insert("x-codex-plan-type", "pro".parse().unwrap());
    headers.insert("x-codex-primary-used-percent", "12".parse().unwrap());
    headers.insert("x-unrelated", "1".parse().unwrap());
    // Signals recorded for another provider's credential never surface (Go keys
    // observation by provider).
    f.rt.executors.codex.quota().observe(&codex, "", &headers);
    f.rt.executors.codex.quota().observe(&claude, "", &headers);
    let (base, server) = f.server().await;
    let list = || async {
        wreq::Client::new()
            .get(format!("{base}/v8/management/credentials"))
            .bearer_auth("fake-management-only")
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap()
    };
    let listed = list().await;
    let entry_in = |listed: &Value, name: &str| {
        listed["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["name"] == name)
            .unwrap()
            .clone()
    };
    let entry = |name: &str| entry_in(&listed, name);
    let quota = entry("codex-a.json")["quota"].clone();
    assert_eq!(
        quota["signals"],
        json!({"X-Codex-Plan-Type": "pro", "X-Codex-Primary-Used-Percent": "12"})
    );
    // Go time.Time JSON (RFC 3339 with an offset), close to now.
    let observed = chrono::DateTime::parse_from_rfc3339(quota["observed_at"].as_str().unwrap()).unwrap();
    assert!((chrono::Utc::now() - observed.to_utc()).num_seconds().abs() < 60);
    assert_eq!(entry("claude-b.json")["quota"], json!({"signals": {}}));
    assert!(entry("codex-a.json").get("model_quotas").is_none());

    // Per-model observations (Go model_quotas): keyed by the model without its
    // thinking suffix; the credential quota is the latest snapshot.
    let mut mini = axum::http::HeaderMap::new();
    mini.insert("x-codex-primary-used-percent", "70".parse().unwrap());
    f.rt.executors.codex.quota().observe(&codex, "gpt-5.4(high)", &headers);
    f.rt.executors.codex.quota().observe(&codex, "gpt-5.4-mini", &mini);
    f.rt.executors
        .codex
        .quota()
        .observe(&claude, "claude-sonnet-4-6", &headers);
    let listed = list().await;
    server.abort();
    let codex_entry = entry_in(&listed, "codex-a.json");
    let models = codex_entry["model_quotas"].as_object().unwrap();
    assert_eq!(models.keys().collect::<Vec<_>>(), ["gpt-5.4", "gpt-5.4-mini"]);
    assert_eq!(
        models["gpt-5.4"]["signals"],
        json!({"X-Codex-Plan-Type": "pro", "X-Codex-Primary-Used-Percent": "12"})
    );
    assert_eq!(
        models["gpt-5.4-mini"]["signals"],
        json!({"X-Codex-Primary-Used-Percent": "70"})
    );
    assert!(models["gpt-5.4-mini"]["observed_at"].is_string());
    assert_eq!(
        codex_entry["quota"]["signals"],
        json!({"X-Codex-Primary-Used-Percent": "70"})
    );
    assert!(entry_in(&listed, "claude-b.json").get("model_quotas").is_none());
}

impl Fixture {
    fn new(name: &str) -> Self {
        Self::from_yaml(name, |_, hash| {
            format!(
                "config-version: 8\nserver: {{host: '127.0.0.1', port: 0}}\nmanagement: {{secret-key: '{hash}'}}\nrouting: {{retry: {{request-retry: 3}}}}\naccess: {{api-keys: [fake-client]}}\n",
            )
        })
    }
    /// A fixture whose runtime holds the credentials `yaml` synthesizes. `yaml` gets the
    /// directory where it stages credential files, saved to the database before the runtime starts.
    fn from_yaml(name: &str, yaml: impl Fn(&std::path::Path, &str) -> String) -> Self {
        Self::from_yaml_with(name, yaml, Default::default())
    }
    /// [`Self::from_yaml`] with its Codex executor.
    fn from_yaml_with(
        name: &str,
        yaml: impl Fn(&std::path::Path, &str) -> String,
        codex: ck_exec::codex::CodexExecutor,
    ) -> Self {
        let dir = std::env::temp_dir().join(format!("manage-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("auth")).unwrap();
        let hash = bcrypt::hash("fake-management-only", 4).unwrap();
        let store = Arc::new(ck_server::testing::config_store(&dir.join("config.db")).unwrap());
        store.import_yaml(&yaml(&dir.join("auth"), &hash), "test", "").unwrap();
        let mut cfg = store.load().unwrap().config;
        let db = CredentialDb::initialize(store.clone()).unwrap();
        ck_server::testing::seed_credentials(&db, &dir.join("auth"));
        cfg.auth_dir = db.auth_dir();
        let scan = db.scan(&cfg).unwrap();
        let mut loaded = scan.credentials;
        loaded.extend(ck_core::config::credentials::from_config(&cfg));
        let rt = Arc::new(ck_server::testing::runtime_with_db(
            cfg.clone(),
            loaded,
            Executors {
                claude: ClaudeExecutor::new("http://127.0.0.1:1").unwrap(),
                codex,
                devices: Default::default(),
                openai: Default::default(),
                google: Default::default(),
            },
            db,
        ));
        // As the binary records what it loaded.
        rt.store().note_loaded(&scan.read);
        let state = Management::new(rt.clone(), store);
        Self { dir, state, rt }
    }
    fn auth(&self) -> PathBuf {
        self.rt.store().credential_backend().auth_dir()
    }
    /// A fixture command adapter sharing the live owner's canonical state.
    fn writer(&self) -> Arc<CredentialDb> {
        self.rt.store().credential_backend()
    }
    fn reject_saves(&self) -> ck_server::testing::BlockedCheckpoint {
        ck_server::testing::block_checkpoint_install(self.state.config_store())
    }
    async fn server(&self) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let app = management::router(self.state.clone());
        let handle = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .unwrap();
        });
        (base, handle)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[tokio::test]
async fn authorized_credential_reads_and_cooldown_views_need_no_storage() {
    use ck_server::cooldown_store::{Backend, Record};
    let raw = b"{ \"type\": \"claude\", \"access_token\": \"test-only\", \"opaque\": [1,2] }\n";
    let f = Fixture::from_yaml("credential-memory", |auth, hash| {
        std::fs::write(auth.join("raw.json"), raw).unwrap();
        format!("config-version: 8\nmanagement: {{secret-key: '{hash}'}}\n",)
    });
    let db = f.rt.store().credential_backend();
    let name = f.auth().join("raw.json");
    let revision = f.state.config_store().snapshot().unwrap().0;
    let now = std::time::SystemTime::now();
    Backend::save(
        db.as_ref(),
        vec![Record {
            auth_id: "raw.json".into(),
            reason: "test cooldown".into(),
            ..Default::default()
        }],
        now,
    )
    .unwrap();
    let cooldown = Backend::load(db.as_ref()).unwrap();
    assert_eq!(cooldown[0].reason, "test cooldown");
    assert_eq!(cooldown[0].updated_at, Some(now));
    let (base, server) = f.server().await;
    let client = wreq::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap();
    let storage = ck_server::testing::database_connection(f.state.config_store());
    storage.execute_batch("BEGIN EXCLUSIVE").unwrap();
    let response = client
        .get(format!("{base}/v8/management/credentials/download?name=raw.json"))
        .bearer_auth("fake-management-only")
        .send()
        .await
        .unwrap();
    let status = response.status();
    let body = response.bytes().await.unwrap();
    let documents = db.documents();
    let checkpoint = Backend::load(db.as_ref());
    let canonical_bytes = db.read(&name);
    storage.execute_batch("ROLLBACK").unwrap();
    assert_eq!(status, 200);
    assert_eq!(body.as_ref(), raw);
    assert_eq!(canonical_bytes.unwrap().as_deref(), Some(raw.as_slice()));
    assert_eq!(documents.unwrap(), vec![(name.clone(), raw.to_vec())]);
    assert_eq!(checkpoint.unwrap(), cooldown);
    assert_eq!(
        f.state.config_store().snapshot().unwrap().0,
        revision,
        "credential domains do not advance configuration history"
    );
    let replacement = b"{\"type\":\"claude\",\"access_token\":\"replacement-test-only\"}\n";
    db.save(&name, replacement).unwrap();
    assert_eq!(db.read(&name).unwrap().unwrap(), replacement);
    db.delete(&name).unwrap();
    assert!(db.read(&name).unwrap().is_none());
    assert!(db.documents().unwrap().is_empty());
    server.abort();
    let _ = server.await;
}

#[tokio::test]
async fn real_http_config_rejections_publication_and_panel_assets() {
    let f = Fixture::new("http");
    let (base, server) = f.server().await;
    let client = wreq::Client::new();
    assert_eq!(
        client
            .get(format!("{base}/admin/v1/effective/config"))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    let before = f.state.config_store().snapshot().unwrap().0;
    for (path, value, status) in [
        ("server/port", json!("bad"), 422),
        ("routing/retry/request-retry", json!({"value": 2}), 422),
    ] {
        let response = client
            .post(format!("{base}/admin/v1/apply"))
            .bearer_auth("fake-management-only")
            .json(&json!({"ops": [{"op": "set", "path": path, "value": value}]}))
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status().as_u16(),
            status,
            "{path}: {}",
            response.text().await.unwrap()
        );
        assert_eq!(f.state.config_store().snapshot().unwrap().0, before);
        assert_eq!(f.rt.config().routing.retry.request_retry, 3);
    }
    let response = client
        .post(format!("{base}/admin/v1/apply"))
        .bearer_auth("fake-management-only")
        .json(&json!({"ops": [
            {"op": "set", "path": "routing/retry/request-retry", "value": 0},
            {"op": "set", "path": "access/api-keys", "value": []}
        ]}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(f.rt.config().routing.retry.request_retry, 0);
    assert!(f.rt.config().api_keys.is_empty());
    let html = client.get(format!("{base}/management.html")).send().await.unwrap();
    assert_eq!(html.status(), 200);
    let html = html.text().await.unwrap();
    for piece in html
        .split('"')
        .filter(|p| p.starts_with("./assets/") || p.starts_with("./fonts/"))
    {
        assert_eq!(
            client
                .get(format!("{base}/{}", piece.trim_start_matches("./")))
                .send()
                .await
                .unwrap()
                .status(),
            200,
            "asset {piece}"
        );
    }
    server.abort();
}

#[tokio::test]
async fn dashboard_negotiates_embedded_gzip_and_preserves_identity_bytes() {
    use tokio::io::AsyncReadExt;

    let f = Fixture::new("panel-encoding");
    let (base, server) = f.server().await;
    let client = wreq::Client::builder()
        .no_proxy()
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .build()
        .unwrap();
    let dist = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../ui/dist");
    let html = std::fs::read_to_string(dist.join("index.html")).unwrap();
    let mut paths = vec!["/management.html".to_owned()];
    paths.extend(
        html.split('"')
            .filter(|p| p.starts_with("./assets/"))
            .map(|p| p.trim_start_matches('.').to_owned()),
    );
    let font = std::fs::read_dir(dist.join("assets"))
        .unwrap()
        .flatten()
        .find(|entry| entry.path().extension().is_some_and(|ext| ext == "woff2"))
        .unwrap();
    paths.push(format!("/assets/{}", font.file_name().to_str().unwrap()));
    for path in paths {
        let original = std::fs::read(dist.join(if path == "/management.html" {
            "index.html"
        } else {
            path.trim_start_matches('/')
        }))
        .unwrap();
        let compressible = !path.ends_with(".woff2");
        for (accept, gzip) in [
            (None, false),
            (Some("gzip"), true),
            (Some("br, GZip ; q=0.5"), true),
            (Some("gzip;q=0"), false),
            (Some("*"), true),
            (Some("*;q=0"), false),
            (Some("gzip;q=0, *;q=1"), false),
            (Some("*;q=1, gzip;q=0.000"), false),
            (Some("gzip;q=1, *;q=0"), true),
            (Some("br"), false),
        ] {
            let mut request = client.get(format!("{base}{path}"));
            if let Some(accept) = accept {
                request = request.header("accept-encoding", accept);
            }
            let response = request.send().await.unwrap();
            assert_eq!(response.status(), 200, "{path}: {accept:?}");
            assert_eq!(response.headers()["cache-control"], "no-cache");
            let mime = if path.ends_with(".html") {
                "text/html; charset=utf-8"
            } else if path.ends_with(".js") {
                "text/javascript; charset=utf-8"
            } else if path.ends_with(".css") {
                "text/css; charset=utf-8"
            } else {
                "font/woff2"
            };
            assert_eq!(response.headers()["content-type"], mime);
            if compressible {
                assert_eq!(response.headers()["vary"], "Accept-Encoding");
            }
            let encoded = gzip && compressible;
            assert_eq!(
                response.headers().get("content-encoding").map(|v| v.to_str().unwrap()),
                encoded.then_some("gzip"),
                "{path}: {accept:?}"
            );
            let body = response.bytes().await.unwrap();
            if encoded {
                let mut decoded = Vec::new();
                async_compression::tokio::bufread::GzipDecoder::new(body.as_ref())
                    .read_to_end(&mut decoded)
                    .await
                    .unwrap();
                assert_eq!(decoded, original, "{path}: {accept:?}");
            } else {
                assert_eq!(body.as_ref(), original, "{path}: {accept:?}");
            }
        }
    }
    server.abort();
}

#[tokio::test]
async fn watcher_keeps_last_good_auth_and_reconciles_disabled_deleted_and_self_writes() {
    let f = Fixture::new("reload");
    let auth = f.auth().join("fake.json");
    let original =
        br#"{"type":"claude","access_token":"fake-token","email":"fake@example.invalid","unknown":{"keep":7}}"#;
    f.writer().save(&auth, original).unwrap();
    watching::reload(&f.state).unwrap();
    let revision = f.rt.store().get("fake.json").unwrap().revision;
    watching::reload(&f.state).unwrap();
    assert_eq!(f.rt.store().get("fake.json").unwrap().revision, revision);
    f.writer().save(&auth, b"{incomplete").unwrap();
    watching::reload(&f.state).unwrap();
    assert_eq!(f.rt.store().get("fake.json").unwrap().revision, revision);
    f.writer().save(&auth, original).unwrap();
    let (base, server) = f.server().await;
    let client = wreq::Client::new();
    let value: Value = client
        .patch(format!("{base}/v8/management/credentials/status"))
        .bearer_auth("fake-management-only")
        .json(&json!({"name":"fake.json","disabled":true}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(value["disabled"], true);
    let saved: Value =
        serde_json::from_slice(&f.rt.store().credential_backend().read(&auth).unwrap().unwrap()).unwrap();
    assert_eq!(saved["unknown"]["keep"], 7);
    let disabled_revision = f.rt.store().get("fake.json").unwrap().revision;
    watching::reload(&f.state).unwrap();
    assert!(f.rt.store().get("fake.json").unwrap().disabled);
    assert_eq!(f.rt.store().get("fake.json").unwrap().revision, disabled_revision);
    f.writer().delete(&auth).unwrap();
    watching::reload(&f.state).unwrap();
    assert!(f.rt.store().snapshot().is_empty(), "deleted auth must be removed");
    assert_eq!(f.rt.config().api_keys, ["fake-client"]);
    f.writer().save(&auth, &serde_json::to_vec(&saved).unwrap()).unwrap();
    watching::reload(&f.state).unwrap();
    assert!(f.rt.store().get("fake.json").unwrap().disabled);
    assert!(
        f.state
            .config_store()
            .import_yaml("access: null\n", "test", "")
            .is_err()
    );
    assert_eq!(f.rt.config().api_keys, ["fake-client"]);
    f.writer().delete(&auth).unwrap();
    watching::reload(&f.state).unwrap();
    assert!(
        f.rt.store().snapshot().is_empty(),
        "rejected config must not retain deleted auth"
    );
    let text = f
        .state
        .config_store()
        .load()
        .unwrap()
        .text
        .replace("request-retry: 3", "request-retry: 7");
    f.state.config_store().import_yaml(&text, "test", "").unwrap();
    watching::reload(&f.state).unwrap();
    assert_eq!(f.rt.config().routing.retry.request_retry, 7);
    assert!(f.rt.store().snapshot().is_empty());
    server.abort();
}

#[tokio::test]
async fn remote_policy_does_not_trust_forwarded_headers() {
    let f = Fixture::new("auth");
    let (base, server) = f.server().await;
    let client = wreq::Client::new();
    let r = client
        .get(format!("{base}/admin/v1/effective/config"))
        .header("X-Forwarded-For", "203.0.113.5")
        .bearer_auth("fake-management-only")
        .send()
        .await
        .unwrap();
    assert_eq!(
        r.status(),
        200,
        "untrusted forwarded header must not change local identity"
    );
    for _ in 0..5 {
        assert_eq!(
            client
                .get(format!("{base}/admin/v1/effective/config"))
                .bearer_auth("wrong")
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
    }
    assert_eq!(
        client
            .get(format!("{base}/admin/v1/effective/config"))
            .bearer_auth("fake-management-only")
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    server.abort();
}

#[tokio::test]
async fn management_bodies_are_unbounded_but_the_open_callback_is_not() {
    let f = Fixture::new("body-limit");
    let (base, server) = f.server().await;
    let client = wreq::Client::new();
    let note = "x".repeat(3 * 1024 * 1024);
    let r = client
        .post(format!("{base}/v8/management/credentials?name=large.json"))
        .bearer_auth("fake-management-only")
        .header("Content-Type", "application/json")
        .body(format!(r#"{{"type":"codex","note":"{note}"}}"#))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap());
    assert!(
        f.rt.store()
            .credential_backend()
            .read(&f.auth().join("large.json"))
            .unwrap()
            .unwrap()
            .len()
            > 3 * 1024 * 1024
    );
    let r = client
        .post(format!("{base}/v8/management/oauth/callback"))
        .header("Content-Type", "application/json")
        .body(format!(r#"{{"state":"s","code":"{note}"}}"#))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 413);
    server.abort();
}

/// Waits up to four seconds for `done`.
async fn eventually(done: impl Fn() -> bool) {
    tokio::time::timeout(std::time::Duration::from_secs(4), async {
        while !done() {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("condition not reached");
}

#[tokio::test]
async fn watcher_reconciles_auth_independently_of_config_writes() {
    let f = Fixture::new("missing-config");
    let watcher = watching::start(&f.state);
    let (base, server) = f.server().await;
    let client = wreq::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap();
    // Online changes enter the owner through its authenticated command adapter,
    // not a second store whose files the watcher would have to hot-adopt.
    let upload = |name: &str, token: &str| {
        client
            .post(format!("{base}/v8/management/credentials?name={name}"))
            .bearer_auth("fake-management-only")
            .json(&json!({"type": "claude", "access_token": token}))
    };
    let config_revision = f.state.config_store().snapshot().unwrap().0;
    assert_eq!(upload("a.json", "fake-a").send().await.unwrap().status(), 200);
    eventually(|| f.rt.store().get("a.json").is_some()).await;
    assert_eq!(upload("b.json", "fake-b").send().await.unwrap().status(), 200);
    assert_eq!(
        client
            .delete(format!("{base}/v8/management/credentials?name=a.json"))
            .bearer_auth("fake-management-only")
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    eventually(|| f.rt.store().get("b.json").is_some() && f.rt.store().get("a.json").is_none()).await;
    assert_eq!(f.state.config_store().snapshot().unwrap().0, config_revision);
    assert_eq!(f.rt.config().api_keys, ["fake-client"], "last good config kept");
    let text = f
        .state
        .config_store()
        .load()
        .unwrap()
        .text
        .replace("fake-client", "fake-next");
    f.state.config_store().import_yaml(&text, "test", "").unwrap();
    watching::reload(&f.state).unwrap();
    eventually(|| f.rt.config().api_keys == ["fake-next"]).await;
    let revision = f.rt.store().get("b.json").unwrap().revision;
    assert_eq!(upload("b.json", "fake-b").send().await.unwrap().status(), 200);
    watching::reload(&f.state).unwrap();
    assert_eq!(f.rt.store().get("b.json").unwrap().revision, revision);
    // The owner's changed grant is admitted even when its byte length is unchanged.
    assert_eq!(upload("b.json", "fake-c").send().await.unwrap().status(), 200);
    eventually(|| f.rt.store().get("b.json").unwrap().revision != revision).await;
    watcher.shutdown().await.unwrap();
    server.abort();
    let _ = server.await;
}

#[tokio::test]
async fn polling_reconciles_auth_and_ignores_non_auth_directories() {
    let f = Fixture::new("polling");
    std::fs::create_dir_all(f.auth().join("static")).unwrap();
    std::fs::create_dir_all(f.auth().join("logs")).unwrap();
    let watcher = watching::start(&f.state);
    let text = f
        .state
        .config_store()
        .load()
        .unwrap()
        .text
        .replace("fake-client", "owner-fake-client")
        .replace("request-retry: 3", "request-retry: 5");
    f.state.config_store().import_yaml(&text, "test", "").unwrap();
    watching::reload(&f.state).unwrap();
    f.writer()
        .save(
            &f.auth().join("fake.json"),
            br#"{"type":"claude","access_token":"fake","disabled":true}"#,
        )
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(4), async {
        loop {
            if f.rt.config().routing.retry.request_retry == 5 && f.rt.store().snapshot().len() == 1 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(f.rt.config().api_keys, ["owner-fake-client"]);
    assert!(!f.rt.config().management.allow_remote);
    assert!(f.rt.store().get("fake.json").unwrap().disabled);
    watcher.shutdown().await.unwrap();
}

#[tokio::test]
async fn nonlocal_socket_requires_allow_remote_even_with_a_valid_key() {
    let f = Fixture::new("nonlocal");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/admin/v1/effective/config", listener.local_addr().unwrap());
    // Inject a nonlocal socket identity, not a forwarded header, into real HTTP.
    let app = management::router(f.state.clone()).layer(axum::middleware::from_fn(
        |mut req: axum::extract::Request, next: axum::middleware::Next| async move {
            let peer = req
                .headers()
                .get("X-Test-Peer")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("203.0.113.8:3456")
                .parse::<std::net::SocketAddr>()
                .unwrap();
            req.extensions_mut().insert(axum::extract::ConnectInfo(peer));
            next.run(req).await
        },
    ));
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = wreq::Client::new();
    assert_eq!(
        client
            .get(&url)
            .bearer_auth("fake-management-only")
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        client
            .get(&url)
            .header("X-Test-Peer", "[::ffff:127.0.0.1]:3456")
            .bearer_auth("fake-management-only")
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    f.state
        .config_store()
        .edit("test", "allow remote management", |document| {
            document["management"]["allow-remote"] = serde_json::json!(true);
            Ok(())
        })
        .unwrap();
    assert_eq!(
        client
            .get(&url)
            .bearer_auth("fake-management-only")
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(client.get(&url).send().await.unwrap().status(), 401);
    server.abort();
}

/// The binary's composition (`ck_server::app`): API routes first, management and its
/// NoRoute behind them. The API keeps gin's NoRoute rules (bare 404, no `Allow`, HEAD on
/// `/healthz` only); management keeps its own HEAD handling, so a HEAD under
/// `/v0/management` reaches the guard before its NoRoute.
#[tokio::test]
async fn served_app_keeps_api_and_management_no_route_rules() {
    let f = Fixture::new("served-app");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app = ck_server::app(f.rt.clone(), management::router(f.state.clone()));
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap()
    });
    let client = wreq::Client::new();
    let send = |method: wreq::Method, path: &str, key: Option<&str>| {
        let mut req = client.request(method, format!("{base}{path}"));
        if let Some(key) = key {
            req = req.bearer_auth(key);
        }
        async move { req.send().await.unwrap() }
    };
    let get = wreq::Method::GET;
    let head = wreq::Method::HEAD;
    assert_eq!(
        send(get.clone(), "/admin/v1/effective/config", Some("fake-management-only"))
            .await
            .status(),
        200
    );
    assert_eq!(send(get.clone(), "/v1/models", None).await.status(), 401);
    assert_eq!(send(get.clone(), "/v1/models", Some("fake-client")).await.status(), 200);
    for (method, path) in [
        (get.clone(), "/v1/chat/completions"),
        (head.clone(), "/v1/models"),
        (get.clone(), "/v2/nothing"),
        (head.clone(), "/v2/nothing"),
    ] {
        let res = send(method.clone(), path, Some("fake-client")).await;
        assert_eq!(res.status(), 404, "{method} {path}");
        assert!(
            res.headers().get("allow").is_none(),
            "{method} {path}: {:?}",
            res.headers()
        );
    }
    assert_eq!(send(head.clone(), "/healthz", None).await.status(), 200);
    // Go's NoRoute guards /v0/management before answering 404.
    assert_eq!(send(head.clone(), "/v0/management/nothing", None).await.status(), 401);
    let res = send(head, "/v0/management/nothing", Some("fake-management-only")).await;
    assert_eq!(res.status(), 404);
    server.abort();
}

/// The plugin routes are removed, not tombstoned: through the binary's composition, with
/// the management key, every former plugin method and path answers the ordinary bare 404,
/// as an unknown path does, while a retained route on the same prefix still answers its
/// own method and keeps the bare 404 for HEAD and other methods.
#[tokio::test]
async fn removed_plugin_routes_answer_the_ordinary_not_found() {
    let f = Fixture::new("removed-plugin-routes");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app = ck_server::app(f.rt.clone(), management::router(f.state.clone()));
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap()
    });
    let client = wreq::Client::new();
    let send = |method: &str, path: &str| {
        let mut req = client
            .request(
                wreq::Method::from_bytes(method.as_bytes()).unwrap(),
                format!("{base}{path}"),
            )
            .bearer_auth("fake-management-only");
        if method != "HEAD" {
            req = req.header("content-type", "application/json").body("{}");
        }
        async move {
            let res = req.send().await.unwrap();
            let allow = res.headers().get("allow").cloned();
            (res.status().as_u16(), allow, res.text().await.unwrap())
        }
    };
    let mut removed = Vec::new();
    for v in ["/v0/management", "/v8/management"] {
        for (method, path) in [
            ("GET", "/plugins"),
            ("DELETE", "/plugins/demo"),
            ("GET", "/plugins/demo/quota"),
            ("POST", "/plugins/demo/quota"),
            ("DELETE", "/plugins/demo/quota"),
        ] {
            removed.push((method, format!("{v}{path}")));
        }
    }
    for (method, path) in [
        ("GET", "/v8/management/plugins/store"),
        ("POST", "/v8/management/plugins/store/demo/install"),
        ("GET", "/v0/management/plugin-store"),
        ("POST", "/v0/management/plugin-store/demo/install"),
        ("PATCH", "/v0/management/plugins/demo/enabled"),
        ("POST", "/v0/management/plugins/demo/quota/reset"),
        ("GET", "/v0/management/quota/providers"),
        ("POST", "/v0/management/quota/reset"),
        ("GET", "/v0/management/plugins/demo/config"),
        ("PUT", "/v0/management/plugins/demo/config"),
        ("GET", "/v0/management/plugins/demo/route"),
        ("GET", "/v0/resource/plugins/demo/route"),
        ("POST", "/v0/resource/plugins/demo/route"),
        ("GET", "/plugins/demo/route"),
        ("POST", "/plugins/demo/route"),
    ] {
        removed.push((method, path.to_owned()));
    }
    // The ordinary answers for an unknown path under each prefix.
    let management_unknown = send("GET", "/v0/management/nothing").await;
    let api_unknown = send("GET", "/v2/nothing").await;
    for unknown in [&management_unknown, &api_unknown] {
        assert_eq!((unknown.0, &unknown.1), (404, &None), "{unknown:?}");
    }
    for (method, path) in &removed {
        let unknown = if path.contains("/management/") {
            &management_unknown
        } else {
            &api_unknown
        };
        assert_eq!(&send(method, path).await, unknown, "{method} {path}");
    }
    // The retained quota route on the same prefix: POST reaches its handler, HEAD and other
    // methods get the bare 404.
    let (status, _, body) = send("POST", "/v0/management/quota/fetch").await;
    assert_eq!((status, body.as_str()), (400, r#"{"error":"auth_index is required"}"#));
    for method in ["GET", "HEAD", "PUT", "DELETE"] {
        let (status, allow, _) = send(method, "/v0/management/quota/fetch").await;
        assert_eq!((status, allow), (404, None), "{method}");
    }
    server.abort();
}

#[tokio::test]
async fn config_api_keys_become_scheduled_credentials_on_write_and_reload() {
    use ck_server::runtime::Selection;
    let f = Fixture::new("synth");
    let (base, server) = f.server().await;
    let client = wreq::Client::new();
    let put = |path: &str, value: Value| {
        client
            .post(format!("{base}/admin/v1/apply"))
            .bearer_auth("fake-management-only")
            .json(&json!({"ops": [{"op": "set", "path": path, "value": value}]}))
    };
    let r = put(
        "api-keys/claude",
        json!([{"name": "team", "base-url": "https://claude.example.invalid", "prefix": "team", "priority": 4,
                "keys": [{"api-key": "fake-key-a"}, {"api-key": "fake-key-b", "priority": 9, "weight": 0,
                          "disable-cooling": false, "excluded-models": ["Opus-*"]}]}]),
    )
    .send()
    .await
    .unwrap();
    assert_eq!(r.status(), 200);
    // Published immediately by the write, without waiting for the watcher.
    let claude: Vec<_> =
        f.rt.store()
            .snapshot()
            .into_iter()
            .filter(|c| c.provider == "claude")
            .collect();
    assert_eq!(claude.len(), 2);
    let b = claude.iter().find(|c| c.attributes["api_key"] == "fake-key-b").unwrap();
    assert!(b.id.starts_with("claude:apikey:"));
    assert_eq!(b.attributes["priority"], "9");
    assert_eq!(b.attributes["weight"], "0");
    assert_eq!(b.attributes["prefix"], "team");
    assert_eq!(b.attributes["base_url"], "https://claude.example.invalid");
    assert_eq!(b.attributes["excluded_models"], "opus-*");
    assert_eq!(b.metadata["disable_cooling"], false);
    // The scheduler honours the synthesized priority and prefix.
    let sel = |model: &str| Selection {
        provider: "claude".into(),
        model: model.into(),
        ..Selection::default()
    };
    let lease = f.rt.store().select(sel("team/claude-sonnet-4-6")).unwrap();
    assert_eq!(lease.credential.attributes["api_key"], "fake-key-b", "priority 9 wins");
    assert_eq!(lease.execution_model, "claude-sonnet-4-6");
    drop(lease);
    let lease = f.rt.store().select(sel("team/opus-4")).unwrap();
    assert_eq!(
        lease.credential.attributes["api_key"], "fake-key-a",
        "b excludes opus-*"
    );
    drop(lease);
    // Credentials listing never shows config API keys (Go lists files only).
    let listed: Value = client
        .get(format!("{base}/v8/management/credentials"))
        .bearer_auth("fake-management-only")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(listed["files"], json!([]));

    // OAuth request-scoped rules reach the policy; invalid rules are dropped.
    let r = put(
        "oauth/request-scoped-errors",
        json!({"Claude": [{"status": 400, "match": [" overloaded "], "action": " STOP "},
                          {"status": 0, "match": ["x"], "action": "stop"}]}),
    )
    .send()
    .await
    .unwrap();
    assert_eq!(r.status(), 200);
    let rules = &f.rt.policy().oauth_request_scoped_errors["claude"];
    assert_eq!(rules.len(), 1);
    assert_eq!(
        (rules[0].r#match[0].as_str(), rules[0].action.as_str()),
        ("overloaded", "stop")
    );

    let text = f
        .state
        .config_store()
        .load()
        .unwrap()
        .text
        .replace("fake-key-a", "fake-key-c");
    f.state.config_store().import_yaml(&text, "test", "").unwrap();
    watching::reload(&f.state).unwrap();
    let keys: Vec<String> =
        f.rt.store()
            .snapshot()
            .iter()
            .filter_map(|c| c.attributes.get("api_key").cloned())
            .collect();
    assert!(keys.contains(&"fake-key-c".to_owned()) && !keys.contains(&"fake-key-a".to_owned()));
    server.abort();
}

#[tokio::test]
async fn management_secret_keys_are_hashed_and_rotated() {
    let f = Fixture::from_yaml("secret", |_, _| {
        "management: {secret-key: fake-management-only}\n".to_owned()
    });
    assert!(
        bcrypt::verify(
            "fake-management-only",
            &f.state.config_store().load().unwrap().config.management.secret_key
        )
        .unwrap()
    );
    let (base, server) = f.server().await;
    let client = wreq::Client::new();
    let response = client
        .patch(format!("{base}/admin/v1/r/setting/management"))
        .bearer_auth("fake-management-only")
        .json(&json!({"secret-key": "fake-rotated"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    for (key, expected) in [("fake-management-only", 401), ("fake-rotated", 200)] {
        assert_eq!(
            client
                .get(format!("{base}/admin/v1/effective/config"))
                .bearer_auth(key)
                .send()
                .await
                .unwrap()
                .status()
                .as_u16(),
            expected
        );
    }
    let saved = f.state.config_store().load().unwrap();
    assert!(bcrypt::verify("fake-rotated", &saved.config.management.secret_key).unwrap());
    assert!(!saved.text.contains("fake-rotated"));
    let response = client
        .patch(format!("{base}/admin/v1/r/setting/management"))
        .bearer_auth("fake-rotated")
        .json(&json!({"secret-key": null}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(
        client
            .get(format!("{base}/admin/v1/effective/config"))
            .bearer_auth("fake-rotated")
            .send()
            .await
            .unwrap()
            .status(),
        403,
        "no key left: management is refused by name"
    );
    server.abort();
}

#[tokio::test]
async fn unreadable_auth_dir_never_blocks_secret_rotation_or_removal() {
    let f = Fixture::new("authfile");
    // An auth-dir that is not a directory changes nothing: credentials live in SQLite.
    let blocker = f.dir.join("not-a-dir");
    std::fs::write(&blocker, "x").unwrap();
    let text = f.state.config_store().load().unwrap().text.replace(
        &f.dir.join("auth").display().to_string(),
        &blocker.display().to_string(),
    );
    f.state
        .config_store()
        .import_yaml(
            &(text + "api-keys: {claude: [{keys: [{api-key: fake-cfg-key}]}]}\n"),
            "test",
            "",
        )
        .unwrap();
    watching::reload(&f.state).unwrap();
    assert_eq!(f.rt.config().auth_dir, f.auth());
    assert!(f.rt.store().snapshot().iter().any(|c| c.provider == "claude"));
    let (base, server) = f.server().await;
    let client = wreq::Client::new();
    let get = |key: &str| {
        client
            .get(format!("{base}/admin/v1/effective/config"))
            .bearer_auth(key)
            .send()
    };
    let r = client
        .patch(format!("{base}/admin/v1/r/setting/management"))
        .bearer_auth("fake-management-only")
        .json(&json!({"secret-key": "fake-rotated"}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(
        get("fake-management-only").await.unwrap().status(),
        401,
        "old key revoked"
    );
    assert_eq!(get("fake-rotated").await.unwrap().status(), 200);
    let text = f.state.config_store().load().unwrap().text;
    assert!(!text.contains("fake-rotated"), "secret stored hashed");
    let mut doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&text).unwrap();
    doc["management"].as_mapping_mut().unwrap().remove("secret-key");
    f.state
        .config_store()
        .import_yaml(&serde_yaml_ng::to_string(&doc).unwrap(), "test", "")
        .unwrap();
    watching::reload(&f.state).unwrap();
    let r = get("fake-rotated").await.unwrap();
    assert_eq!(r.status().as_u16(), 403);
    let body: Value = r.json().await.unwrap();
    assert_eq!(
        body["message"],
        "management key not set: start the server with CK_MANAGEMENT_PASSWORD"
    );
    server.abort();
}

#[tokio::test]
async fn config_writes_honour_per_resource_if_match() {
    let f = Fixture::new("etag");
    let (base, server) = f.server().await;
    let client = wreq::Client::new();
    let url = format!("{base}/admin/v1/r/setting/routing");
    let read = client
        .get(&url)
        .bearer_auth("fake-management-only")
        .send()
        .await
        .unwrap();
    assert_eq!(read.status(), 200);
    let tag = read.headers()["etag"].to_str().unwrap().to_owned();
    let response = client
        .patch(&url)
        .bearer_auth("fake-management-only")
        .header("If-Match", &tag)
        .json(&json!({"retry": {"request-retry": 1}}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let before = f.state.config_store().snapshot().unwrap().0;
    for method in [wreq::Method::PUT, wreq::Method::PATCH, wreq::Method::DELETE] {
        let body = if method == wreq::Method::PUT {
            json!({"spec": {"strategy": "fill-first"}})
        } else {
            json!({"strategy": "fill-first"})
        };
        let response = client
            .request(method.clone(), &url)
            .bearer_auth("fake-management-only")
            .header("If-Match", &tag)
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 412, "{method}");
        assert_eq!(response.json::<Value>().await.unwrap()["error"], "precondition_failed");
        assert_eq!(f.state.config_store().snapshot().unwrap().0, before);
    }
    assert_eq!(f.rt.config().routing.retry.request_retry, 1);
    // A change to another resource does not invalidate this resource's revision.
    assert_eq!(
        client
            .patch(format!("{base}/admin/v1/r/setting/server"))
            .bearer_auth("fake-management-only")
            .header("If-Match", &tag)
            .json(&json!({"port": 8318}))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    server.abort();
}

/// A status toggle locates the key in the current stored config, even before reload.
#[tokio::test]
async fn config_key_toggle_edits_only_the_target_key_in_the_current_store() {
    let groups = |first: &str, second: &str| {
        format!(
            "api-keys:\n  claude:\n    - base-url: https://claude.example.invalid # group one\n      keys:\n        {first}\n        {second}\n    - keys:\n        - api-key: fake-c # third\n"
        )
    };
    let (a, b) = ("- api-key: fake-a # first key", "- api-key: fake-b # second key");
    let f = Fixture::from_yaml("toggle", |_, hash| {
        format!(
            "config-version: 8\nmanagement:\n  secret-key: '{hash}'\n{}",
            groups(a, b)
        )
    });
    let cfg = f.rt.config();
    let ids = ck_core::config::credentials::from_config(&cfg);
    let id_b = ids
        .iter()
        .find(|c| c.attributes.get("api_key").map(String::as_str) == Some("fake-b"))
        .unwrap()
        .id
        .clone();
    let mut doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&f.state.config_store().load().unwrap().text).unwrap();
    doc["api-keys"]["claude"][0]["keys"]
        .as_sequence_mut()
        .unwrap()
        .swap(0, 1);
    f.state
        .config_store()
        .import_yaml(&serde_yaml_ng::to_string(&doc).unwrap(), "test", "")
        .unwrap();
    let (base, server) = f.server().await;
    let r = wreq::Client::new()
        .patch(format!("{base}/v8/management/credentials/status"))
        .bearer_auth("fake-management-only")
        .json(&json!({"name": id_b, "disabled": true}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap());
    let doc = f.state.config_store().load().unwrap().config.document;
    assert_eq!(doc["api-keys"]["claude"][1]["keys"][0]["api-key"], "fake-c");
    assert_eq!(
        doc["api-keys"]["claude"][0]["base-url"],
        "https://claude.example.invalid"
    );
    let keys = &doc["api-keys"]["claude"][0]["keys"];
    assert_eq!(keys[0]["api-key"], "fake-b");
    assert_eq!(keys[0]["excluded-models"], serde_yaml_ng::Value::from(vec!["*"]));
    assert!(keys[1].get("excluded-models").is_none(), "fake-a must stay enabled");
    server.abort();
}

/// A config API key is not an auth file; field patches must not alter it.
#[tokio::test]
async fn config_key_field_patch_is_not_found() {
    let f = Fixture::from_yaml("cfgfields", |_, hash| {
        format!(
            "config-version: 8\nmanagement:\n  secret-key: '{hash}'\napi-keys:\n  claude:\n    - excluded-models: [config-*]\n      keys:\n        - api-key: fake-k\n",
        )
    });
    let before = f.rt.store().snapshot()[0].clone();
    let revision = f.state.config_store().snapshot().unwrap().0;
    let (base, server) = f.server().await;
    let r = wreq::Client::new()
        .patch(format!("{base}/v8/management/credentials/fields"))
        .bearer_auth("fake-management-only")
        .json(&json!({"name": before.id, "note": " updated ", "excluded_models": []}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 404);
    assert_eq!(
        r.json::<Value>().await.unwrap(),
        json!({"error": "auth file not found"})
    );
    let after = f.rt.store().snapshot()[0].clone();
    assert_eq!(
        (&after.attributes, &after.metadata),
        (&before.attributes, &before.metadata)
    );
    assert_eq!(f.state.config_store().snapshot().unwrap().0, revision);
    server.abort();
}

/// Go d9451cb6: the fields patch writes `openapi-location` and `openapi-models` under
/// their canonical names, and a Vertex file then registers the partner models it lists.
#[tokio::test]
async fn openapi_field_aliases_patch_their_canonical_keys() {
    let f = Fixture::from_yaml("openapi-fields", |auth, hash| {
        std::fs::write(auth.join("vertex.json"), r#"{"type":"vertex","project_id":"p"}"#).unwrap();
        format!("config-version: 8\nmanagement:\n  secret-key: '{hash}'\n",)
    });
    let id = f.rt.store().snapshot()[0].id.clone();
    let (base, server) = f.server().await;
    assert!(!f.rt.registry().client_supports(&id, "meta/llama-4"));
    let r = wreq::Client::new()
        .patch(format!("{base}/v8/management/credentials/fields"))
        .bearer_auth("fake-management-only")
        .json(&json!({"name": "vertex.json", "openapi-location": "us-east5", "openapi-models": ["meta/llama-4"]}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap());
    let saved: Value = serde_json::from_slice(
        &f.rt
            .store()
            .credential_backend()
            .read(&f.auth().join("vertex.json"))
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(saved["openapi_location"], "us-east5", "{saved}");
    assert_eq!(saved["openapi_models"], json!(["meta/llama-4"]), "{saved}");
    assert!(
        saved.get("openapi-location").is_none() && saved.get("openapi-models").is_none(),
        "{saved}"
    );
    assert!(f.rt.registry().client_supports(&id, "meta/llama-4"));
    server.abort();
}

/// Go d9451cb6 `AccountInfo`: a service-account file without a top-level `email` is an
/// OAuth account named by the service account's trimmed `client_email`, in both the v0
/// and v8 auth-file lists; no `email` key is listed (Go `buildAuthFileEntryLocked`).
#[tokio::test]
async fn a_service_account_file_lists_its_client_email_as_the_account() {
    let f = Fixture::from_yaml("sa-account", |auth, hash| {
        std::fs::write(
            auth.join("vertex-sa.json"),
            r#"{"type":"vertex","project_id":"p","service_account":{"client_email":" sa@p.iam.gserviceaccount.com ","private_key":"unused"}}"#,
        )
        .unwrap();
        format!("config-version: 8\nmanagement:\n  secret-key: '{hash}'\n",)
    });
    let (base, server) = f.server().await;
    for path in ["/v8/management/credentials", "/v0/management/auth-files"] {
        let listed: Value = wreq::Client::new()
            .get(format!("{base}{path}"))
            .bearer_auth("fake-management-only")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let entry = &listed["files"][0];
        assert_eq!(entry["account"], "sa@p.iam.gserviceaccount.com", "{path}: {entry}");
        assert_eq!(entry["account_type"], "oauth", "{path}: {entry}");
        assert_eq!(entry["project_id"], "p", "{path}: {entry}");
        assert!(entry.get("email").is_none(), "{path}: {entry}");
    }
    server.abort();
}

/// Go `TestCodexExcludedModelsCredentialPriorityAfterPatchAndReload` (b015f208,
/// 94d1a9a0): a credential's own excluded models replace the global
/// `oauth.excluded-models`; with none, the current global list applies, so a later
/// config change reaches the same credential without rewriting it.
#[tokio::test]
async fn credential_excluded_models_take_priority_over_the_global_list() {
    let empty = Config::parse("").unwrap();
    let probe = std::path::Path::new("/auth/codex.json");
    let probe = ck_core::config::credentials::from_file(&empty, probe.parent().unwrap(), probe, br#"{"type":"codex"}"#)
        .unwrap()
        .unwrap();
    let models = ck_core::registry::dynamic::models_for(&empty, &Default::default(), &probe, 0);
    let (global, own) = (models[0].id.clone(), models[models.len() - 1].id.clone());
    let f = Fixture::from_yaml("excl-priority", |auth, hash| {
        std::fs::write(auth.join("codex.json"), r#"{"type":"codex"}"#).unwrap();
        format!(
            "config-version: 8\nmanagement:\n  secret-key: '{hash}'\noauth:\n  excluded-models:\n    codex: ['{global}']\n",
        )
    });
    let id = f.rt.store().snapshot()[0].id.clone();
    let (base, server) = f.server().await;
    let client = wreq::Client::new();
    let available = |stage: &str, want_global: bool, want_own: bool| {
        let registry = f.rt.registry();
        let got = (
            registry.client_supports(&id, &global),
            registry.client_supports(&id, &own),
        );
        assert_eq!(got, (want_global, want_own), "{stage}");
    };
    let patch = |rules: Value| {
        client
            .patch(format!("{base}/v8/management/credentials/fields"))
            .bearer_auth("fake-management-only")
            .json(&json!({"name": "codex.json", "excluded_models": rules}))
            .send()
    };
    available("global fallback", false, true);
    assert_eq!(patch(json!([own.go_upper()])).await.unwrap().status(), 200);
    available("credential override", true, false);
    assert_eq!(patch(json!([])).await.unwrap().status(), 200);
    available("empty falls back to the global list", false, true);
    let cred = f.rt.store().snapshot().into_iter().find(|c| c.id == id).unwrap();
    assert!(
        !cred.attributes.contains_key("excluded_models"),
        "global rules are not copied in"
    );
    let r = client
        .post(format!("{base}/admin/v1/apply"))
        .bearer_auth("fake-management-only")
        .json(&json!({"ops": [{"op": "set", "path": "oauth/excluded-models/codex", "value": [own]}]}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    available("updated global list", true, false);
    server.abort();
}

/// Go `auth_files_excluded_models_test` (1a28c61e, 3e309fb4): the fields patch takes a
/// string array or null and stores only the credential's normalized rules; any other
/// shape, and an upload with invalid rules, is a 400 that changes nothing.
#[tokio::test]
async fn excluded_models_writes_are_validated() {
    let f = Fixture::from_yaml("excl-writes", |auth, hash| {
        std::fs::write(
            auth.join("credential.json"),
            r#"{"type":"codex","excluded-models":["old-*"]}"#,
        )
        .unwrap();
        format!(
            "config-version: 8\nmanagement:\n  secret-key: '{hash}'\noauth:\n  excluded-models:\n    codex: [global-*]\n",
        )
    });
    let auth = f.auth();
    let (base, server) = f.server().await;
    let client = wreq::Client::new();
    let patch = |fields: &str| {
        client
            .patch(format!("{base}/v8/management/credentials/fields"))
            .bearer_auth("fake-management-only")
            .header("content-type", "application/json")
            .body(format!(r#"{{"name":"credential.json",{fields}}}"#))
            .send()
    };
    let current = || {
        f.rt.store()
            .snapshot()
            .into_iter()
            .find(|c| c.id == "credential.json")
            .unwrap()
    };
    for (fields, want) in [
        (
            r#""excluded_models":[" Local-* ","LOCAL-*","b-*"]"#,
            Some("b-*,local-*"),
        ),
        (r#""excluded-models":["alias-*"]"#, Some("alias-*")),
        (r#""excluded_models":[],"excluded-models":["alias-*"]"#, None),
        (r#""excluded_models":["x"]"#, Some("x")),
        (r#""excluded_models":[" ","\t"]"#, None),
        (r#""excluded_models":["y"]"#, Some("y")),
        (r#""excluded_models":null"#, None),
    ] {
        let r = patch(fields).await.unwrap();
        assert_eq!(r.status(), 200, "{fields}");
        let c = current();
        assert_eq!(
            c.attributes.get("excluded_models").map(String::as_str),
            want,
            "{fields}"
        );
        assert!(
            !c.metadata.contains_key("excluded-models"),
            "{fields}: legacy alias retained"
        );
    }
    let before = (
        current().metadata.clone(),
        f.rt.store()
            .credential_backend()
            .read(&auth.join("credential.json"))
            .unwrap()
            .unwrap(),
    );
    for fields in [
        r#""excluded_models":123"#,
        r#""excluded-models":true"#,
        r#""excluded_models":{}"#,
        r#""excluded_models":["codex-new",null]"#,
        r#""excluded_models":[42,false]"#,
        r#""excluded_models":[["codex-new"]]"#,
        r#""excluded_models":"codex-new""#,
        r#""excluded-models":"codex-new""#,
        r#""excluded_models.child":["codex-new"]"#,
        r#""excluded-models.0":"codex-new""#,
    ] {
        let r = patch(&format!(r#""abc":true,{fields}"#)).await.unwrap();
        assert_eq!(r.status(), 400, "{fields}");
        let after = (
            current().metadata.clone(),
            f.rt.store()
                .credential_backend()
                .read(&auth.join("credential.json"))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(after, before, "{fields}: a rejected patch changes nothing");
    }
    for content in [
        r#"{"type":"codex","excluded_models":123}"#,
        r#"{"type":"gemini-cli","excluded_models":123}"#,
        r#"{"type":"codex","excluded_models":["codex-new",1]}"#,
    ] {
        let r = client
            .post(format!("{base}/v8/management/credentials?name=bad.json"))
            .bearer_auth("fake-management-only")
            .body(content)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 400, "{content}");
        let error = r.json::<Value>().await.unwrap()["error"].as_str().unwrap().to_owned();
        assert!(
            error.starts_with("invalid auth file: metadata excluded_models"),
            "{error}"
        );
        assert!(!auth.join("bad.json").exists(), "{content}: nothing is written");
    }
    // The alias is canonicalized first, as Go's NormalizeCredentialMetadata does.
    let r = client
        .post(format!("{base}/v8/management/credentials?name=bad.json"))
        .bearer_auth("fake-management-only")
        .body(r#"{"type":"codex","excluded-models":["a",true]}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 400);
    assert_eq!(
        r.text().await.unwrap(),
        r#"{"error":"invalid auth file: metadata excluded_models[1] must be a string, got bool"}"#
    );
    assert!(!auth.join("bad.json").exists());
    server.abort();
}

/// `/credentials/models` reports what the credential registers in the dynamic
/// registry (Go `GetModelsForClient`): config aliases here, nothing once disabled.
#[tokio::test]
async fn fields_refuses_values_its_auth_loader_cannot_read() {
    // Go writes these values (DIFFERENCES-FROM-GO.md): serde holds the file, so a
    // number past f64 or nesting past its 127 levels, counted from the file's root
    // object, is refused before anything is written.
    let f = Fixture::from_yaml("fields-limits", |auth, hash| {
        std::fs::write(auth.join("credential.json"), r#"{"type":"claude"}"#).unwrap();
        format!("config-version: 8\nmanagement:\n  secret-key: '{hash}'\n",)
    });
    let auth = f.auth();
    let (base, server) = f.server().await;
    let client = wreq::Client::new();
    let nested = |n: usize| format!("{}{}", "[".repeat(n), "]".repeat(n));
    let deep = ["q"; 128].join(".");
    let deep_error = format!("invalid field {deep}");
    for (fields, want) in [
        (format!(r#""x":{}"#, nested(126)), None),
        (format!(r#""x":{}"#, nested(127)), Some("invalid field x")),
        (format!(r#""a.b":{}"#, nested(125)), None),
        (format!(r#""a.b":{}"#, nested(126)), Some("invalid field a.b")),
        // A dotted path's objects count too, around a scalar as around a container.
        (format!(r#""{}":1"#, ["p"; 127].join(".")), None),
        (format!(r#""{deep}":1"#), Some(deep_error.as_str())),
        (r#""note":1e400"#.to_owned(), Some("invalid field note")),
        (r#""note":1e308"#.to_owned(), None),
    ] {
        let before =
            f.rt.store()
                .credential_backend()
                .read(&auth.join("credential.json"))
                .unwrap()
                .unwrap();
        let r = client
            .patch(format!("{base}/v8/management/credentials/fields"))
            .bearer_auth("fake-management-only")
            .body(format!(r#"{{"name":"credential.json",{fields}}}"#))
            .send()
            .await
            .unwrap();
        let status = r.status().as_u16();
        let body: Value = r.json().await.unwrap();
        let label = &fields[..fields.len().min(12)];
        match want {
            Some(message) => {
                assert_eq!((status, body), (400, json!({ "error": message })), "{label}");
                assert_eq!(
                    f.rt.store()
                        .credential_backend()
                        .read(&auth.join("credential.json"))
                        .unwrap()
                        .unwrap(),
                    before,
                    "{label}"
                );
            }
            None => {
                assert_eq!((status, body), (200, json!({ "status": "ok" })), "{label}");
                assert!(f.rt.store().get("credential.json").is_some(), "{label}: reloads");
            }
        }
    }
    server.abort();
}

/// A committed Codex document whose preserved SIWC subtree exceeds the auth loader's
/// nesting limit cannot be patched into an unreadable credential.
#[tokio::test]
async fn a_codex_save_refuses_a_stored_subtree_its_loader_cannot_read() {
    let f = Fixture::from_yaml("codex-deep", |auth, hash| {
        std::fs::write(auth.join("codex.json"), r#"{"type":"codex","access_token":"fake-a"}"#).unwrap();
        format!("config-version: 8\nmanagement:\n  secret-key: '{hash}'\n",)
    });
    let file = f.auth().join("codex.json");
    let nested = |n: usize| format!("{}{}", "[".repeat(n), "]".repeat(n));
    let before = f.rt.store().get("codex.json").unwrap();
    let (base, server) = f.server().await;
    // As edited, and already in the bytes the save would write (an equal save, which
    // writes nothing but would still publish what the bytes synthesize).
    let edited = format!(
        r#"{{"type":"codex","access_token":"fake-a","siwc":{{"x":{}}}}}"#,
        nested(200)
    );
    let canonical = format!(
        r#"{{"access_token":"fake-a","disabled":false,"siwc":{{"x":{}}},"type":"codex"}}"#,
        nested(200)
    );
    for (disk, disabled) in [(&edited, true), (&canonical, false)] {
        f.writer().save(&file, disk.as_bytes()).unwrap();
        let r = wreq::Client::new()
            .patch(format!("{base}/v8/management/credentials/status"))
            .bearer_auth("fake-management-only")
            .body(format!(r#"{{"name":"codex.json","disabled":{disabled}}}"#))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status().as_u16(), 500, "disabled {disabled}");
        assert_eq!(
            r.json::<Value>().await.unwrap(),
            json!({"error": "failed to update auth: Io(\"the saved auth file could not be read back\")"})
        );
        assert_eq!(
            f.rt.store().credential_backend().read(&file).unwrap().unwrap(),
            disk.as_bytes()
        );
        let after = f.rt.store().get("codex.json").unwrap();
        assert_eq!((after.revision, after.disabled), (before.revision, false));
    }
    server.abort();
}

#[tokio::test]
async fn credential_models_come_from_registrations() {
    let f = Fixture::from_yaml("models", |_, hash| {
        format!(
            "config-version: 8\nmanagement:\n  secret-key: '{hash}'\napi-keys:\n  claude:\n    - models: [{{name: claude-sonnet-4-6, alias: sonnet}}]\n      keys:\n        - api-key: fake-k\n",
        )
    });
    let id = f.rt.store().snapshot()[0].id.clone();
    let (base, server) = f.server().await;
    let client = wreq::Client::new();
    let models = |client: wreq::Client, base: String, id: String| async move {
        let v: Value = client
            .get(format!("{base}/v8/management/credentials/models?name={id}"))
            .bearer_auth("fake-management-only")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        v["models"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["id"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    assert_eq!(models(client.clone(), base.clone(), id.clone()).await, ["sonnet"]);
    let r = client
        .patch(format!("{base}/v8/management/credentials/status"))
        .bearer_auth("fake-management-only")
        .json(&json!({"name": id, "disabled": true}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap());
    assert!(models(client, base, id).await.is_empty());
    server.abort();
}

/// Go v8.0.35 `GetStaticModelDefinitions` (`50cfd238`): a channel without a built-in
/// catalog lists the models its credentials registered, sorted by ID, as Go's
/// `registry.ModelInfo` encodes them; a channel with neither is still unknown
/// (`TestGetStaticModelDefinitions_FallsBackToRegistryModelsForPerAuthPlugin`,
/// `TestGetStaticModelDefinitions_BuiltInChannel`,
/// `TestGetStaticModelDefinitions_RejectsUnknownChannel`).
#[tokio::test]
async fn model_definitions_fall_back_to_registered_models_by_channel() {
    let f = Fixture::from_yaml("definitions", |_, hash| {
        format!(
            "config-version: 8\nmanagement:\n  secret-key: '{hash}'\napi-keys:\n  openai-compatibility:\n    - name: Acme\n      base-url: http://127.0.0.1:9/v1\n      models: [{{name: up-z, alias: zeta}}, {{name: up-a, alias: alpha}}]\n      keys: [{{api-key: fake-acme}}]\n",
        )
    });
    let (base, server) = f.server().await;
    let get = |channel: &str| {
        wreq::Client::new()
            .get(format!("{base}/v8/management/routing/model-definitions/{channel}"))
            .bearer_auth("fake-management-only")
            .send()
    };
    let r = get("OpenAI-Compatible-Acme").await.unwrap();
    assert_eq!(r.status(), 200);
    let v: Value = r.json().await.unwrap();
    assert_eq!(v["channel"], "openai-compatible-acme");
    let models = v["models"].as_array().unwrap();
    let ids: Vec<_> = models.iter().map(|m| m["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["alpha", "zeta"]);
    for internal in [
        "user_defined",
        "is_compat",
        "max_context_length",
        "support_configuration_update",
    ] {
        assert!(
            models.iter().all(|m| m.get(internal).is_none()),
            "{internal}: {models:?}"
        );
    }
    let v0: Value = wreq::Client::new()
        .get(format!("{base}/v0/management/model-definitions/openai-compatible-acme"))
        .bearer_auth("fake-management-only")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(v0, v, "v0 serves the same handler");
    let r = get("claude").await.unwrap();
    assert_eq!(r.status(), 200, "the built-in catalog still wins");
    let r = get("nobody").await.unwrap();
    assert_eq!(r.status(), 400);
    assert_eq!(
        r.json::<Value>().await.unwrap(),
        json!({"channel": "nobody", "error": "unknown channel"})
    );
    server.abort();
}

/// Go v8.0.35 `GetStaticModelDefinitionsByChannel` renders the live static catalog with
/// the Codex, xAI and Devin built-ins. Every channel answers Go's bytes, recorded by
/// `reference/manage` (its second output).
#[tokio::test]
async fn model_definitions_match_go_by_channel() {
    let go: serde_json::Map<String, Value> =
        serde_json::from_str(include_str!("fixtures/model_definitions_go.json")).unwrap();
    let f = Fixture::from_yaml("definitions-go", |_, hash| {
        format!("config-version: 8\nmanagement:\n  secret-key: '{hash}'\n",)
    });
    let (base, server) = f.server().await;
    let get = |channel: String| {
        wreq::Client::new()
            .get(format!("{base}/v8/management/routing/model-definitions/{channel}"))
            .bearer_auth("fake-management-only")
            .send()
    };
    // Aliases answer their canonical section under the requested (lowercased) name.
    let aliases = [
        ("kimi-ai", "kimi"),
        ("Kimi.AI", "kimi"),
        ("kimi.com", "kimi"),
        ("x-ai", "xai"),
        ("GROK", "xai"),
        ("muse", "meta"),
    ];
    let requests = go.keys().map(|c| (c.as_str(), c.as_str())).chain(aliases);
    let mut compared = 0;
    for (channel, section) in requests {
        let r = get(channel.to_owned()).await.unwrap();
        assert_eq!(r.status(), 200, "{channel}");
        let want = format!(
            r#"{{"channel":{},"models":{}}}"#,
            Value::from(channel.go_lower()),
            serde_json::to_string(&go[section]).unwrap()
        );
        assert_eq!(r.text().await.unwrap(), want, "{channel}");
        compared += 1;
    }
    assert_eq!(compared, 17);
    server.abort();
}

/// Effective config annotates provider keys; writing it back keeps only stored fields.
#[tokio::test]
async fn effective_api_keys_carry_auth_indexes_and_writes_drop_them() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/config_v8_auth_index_go.json")).unwrap();
    let f = Fixture::from_yaml("authindex", |_, hash| {
        fixture["config"].as_str().unwrap().replace(
            "config-version: 8\n",
            &format!("config-version: 8\nmanagement:\n  secret-key: '{hash}'\n",),
        )
    });
    let (base, server) = f.server().await;
    let client = wreq::Client::new();
    let read: Value = client
        .get(format!("{base}/admin/v1/effective/config"))
        .bearer_auth("fake-management-only")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let keys = read["api-keys"].clone();
    // Entries and keys carry `@id` here; Go's keys and header values are plaintext,
    // masked as `$secret` here when non-empty. `auth_index` values are Go's.
    let mut got = keys.clone();
    for group in got
        .as_object_mut()
        .unwrap()
        .values_mut()
        .flat_map(|g| g.as_array_mut().unwrap())
    {
        let group = group.as_object_mut().unwrap();
        group.remove("@id");
        for key in group
            .get_mut("keys")
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            key.as_object_mut().unwrap().remove("@id");
        }
    }
    let mut want = fixture["response"].clone();
    for group in want
        .as_object_mut()
        .unwrap()
        .values_mut()
        .flat_map(|g| g.as_array_mut().unwrap())
    {
        for value in group
            .get_mut("headers")
            .and_then(Value::as_object_mut)
            .into_iter()
            .flat_map(|h| h.values_mut())
        {
            *value = "$secret".into();
        }
        for key in group
            .get_mut("keys")
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            if let Some(k) = key
                .get_mut("api-key")
                .filter(|k| k.as_str().is_some_and(|s| !s.is_empty()))
            {
                *k = "$secret".into();
            }
        }
    }
    assert_eq!(got, want);
    let response = client
        .post(format!("{base}/admin/v1/apply"))
        .bearer_auth("fake-management-only")
        .json(&json!({"ops": [{"op": "set", "path": "api-keys", "value": keys}]}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200, "{}", response.text().await.unwrap());
    let text = f.state.config_store().load().unwrap().text;
    assert!(!text.contains("auth_index") && !text.contains("auth-index"), "{text}");
    let again: Value = client
        .get(format!("{base}/admin/v1/effective/config"))
        .bearer_auth("fake-management-only")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(again["api-keys"], keys);
    server.abort();
}

/// An unclaimed upload gets one credential, which becomes synthesized when its type is
/// patched.
#[tokio::test]
async fn an_unclaimed_upload_is_retired_once_synthesized() {
    let f = Fixture::new("relfallback");
    let (base, server) = f.server().await;
    let client = wreq::Client::new();
    let call = |method: wreq::Method, path: &str, body: &str| {
        client
            .request(method, format!("{base}/v8/management{path}"))
            .bearer_auth("fake-management-only")
            .body(body.to_owned())
            .send()
    };
    let ids = |f: &Fixture| {
        f.rt.store()
            .snapshot()
            .iter()
            .map(|c| (c.id.clone(), c.provider.clone()))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        call(wreq::Method::POST, "/credentials?name=a.json", "{}")
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(ids(&f), [("a.json".to_owned(), "unknown".to_owned())]);
    let r = call(
        wreq::Method::PATCH,
        "/credentials/fields",
        r#"{"name":"a.json","type":"claude"}"#,
    )
    .await
    .unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(ids(&f), [("a.json".to_owned(), "claude".to_owned())]);
    server.abort();
}

/// Store reloads racing with saves never publish an older committed config.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn config_reloads_never_publish_a_value_older_than_a_save() {
    let f = Fixture::new("reloadfence");
    let (base, server) = f.server().await;
    let state = f.state.clone();
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let reloader = std::thread::spawn({
        let stop = stop.clone();
        move || {
            let mut reloads = 0;
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                watching::reload(&state).unwrap();
                reloads += 1;
            }
            reloads
        }
    });
    let client = wreq::Client::new();
    let retry = || f.rt.config().document["routing"]["retry"]["request-retry"].clone();
    for i in 0..30 {
        let r = client
            .post(format!("{base}/admin/v1/apply"))
            .bearer_auth("fake-management-only")
            .json(&json!({"ops": [{"op": "set", "path": "routing/retry/request-retry", "value": i}]}))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
        assert_eq!(r.headers()["X-Ck-Revision"], r.headers()["X-Ck-Published-Revision"]);
        for _ in 0..5 {
            assert_eq!(retry().as_i64(), Some(i), "save {i} was replaced by an older reload");
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    assert!(reloader.join().unwrap() > 30, "the reloads raced the saves");
    server.abort();
}

/// An auth-file field patch invalidates the cached registry: a new prefix is routable
/// at once.
#[tokio::test]
async fn file_credential_prefix_patch_refreshes_the_registry() {
    let f = Fixture::from_yaml("fileprefix", |auth, hash| {
        std::fs::write(auth.join("claude.json"), r#"{"type":"claude"}"#).unwrap();
        format!("config-version: 8\nmanagement:\n  secret-key: '{hash}'\n",)
    });
    assert!(
        !f.rt.registry().ids().any(|m| m.starts_with("new/")),
        "warm cache without the prefix"
    );
    let (base, server) = f.server().await;
    let r = wreq::Client::new()
        .patch(format!("{base}/v8/management/credentials/fields"))
        .bearer_auth("fake-management-only")
        .json(&json!({"name": "claude.json", "prefix": "new"}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert!(f.rt.registry().ids().any(|m| m.starts_with("new/")));
    server.abort();
}

/// Update checks use exactly one credential-free HEAD, never follow redirects,
/// cache success, reject unrelated locations and honor the kill switch.
#[tokio::test]
async fn latest_version_is_anonymous_cached_and_explicit() {
    use axum::http::{HeaderMap, Method, StatusCode};
    use std::sync::Mutex;
    let seen: Arc<Mutex<Vec<(Method, HeaderMap)>>> = Arc::default();
    let record = seen.clone();
    let release = axum::Router::new().route(
        "/{case}",
        axum::routing::any(
            move |axum::extract::Path(case): axum::extract::Path<String>, method: Method, headers: HeaderMap| {
                let record = record.clone();
                async move {
                    record.lock().unwrap().push((method, headers));
                    let location = match case.as_str() {
                        "tag" => "https://github.com/prep-cook/cooker/releases/tag/v1.2.3",
                        "other" => "https://example.invalid/releases/tag/v9",
                        "empty" => "https://github.com/prep-cook/cooker/releases/tag/",
                        _ => "",
                    };
                    (
                        if case == "limited" {
                            StatusCode::FORBIDDEN
                        } else {
                            StatusCode::FOUND
                        },
                        [("location", location)],
                    )
                }
            },
        ),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream = format!("http://{}", listener.local_addr().unwrap());
    let release_server = tokio::spawn(async move { axum::serve(listener, release).await.unwrap() });

    let get = |case: &'static str, disabled: bool| {
        let url = format!("{upstream}/{case}");
        async move {
            let f = Fixture::new(&format!("latest-{}", case));
            let options = management::Options {
                latest_release_url: Some(url),
                update_check_disabled: Some(disabled),
                ..Default::default()
            };
            let state = Management::with_options(f.rt.clone(), f.state.config_store().clone(), options);
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let app = management::router(state);
            let server = tokio::spawn(async move {
                axum::serve(
                    listener,
                    app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
                )
                .await
                .unwrap()
            });
            let mut out = (0, Value::Null);
            for _ in 0..2 {
                let r = wreq::Client::new()
                    .get(format!("{base}/v8/management/server/latest-version"))
                    .bearer_auth("fake-management-only")
                    .header("Cookie", "secret-cookie=FAKE")
                    .send()
                    .await
                    .unwrap();
                out = (r.status().as_u16(), r.json::<Value>().await.unwrap());
            }
            server.abort();
            out
        }
    };
    assert_eq!(
        get("tag", true).await,
        (
            503,
            json!({"error": "update_check_disabled", "message": "Update checks are disabled by CK_NO_UPDATE_CHECK=1."})
        )
    );
    assert!(seen.lock().unwrap().is_empty(), "nothing is asked when disabled");
    assert_eq!(get("tag", false).await, (200, json!({"latest-version": "v1.2.3"})));
    assert_eq!(seen.lock().unwrap().len(), 1, "second click uses the cache");
    assert_eq!(
        get("empty", false).await,
        (
            502,
            json!({"error": "invalid_response", "message": "missing release version"})
        )
    );
    let (status, body) = get("other", false).await;
    assert_eq!((status, body["error"].as_str()), (502, Some("invalid_response")));
    assert_eq!(
        get("limited", false).await,
        (502, json!({"error": "unexpected_status", "message": "status 403"}))
    );
    assert!(seen.lock().unwrap().iter().all(|(method, h)| *method == Method::HEAD
        && h["user-agent"] == "cooker"
        && !h.contains_key("authorization")
        && !h.contains_key("proxy-authorization")
        && !h.contains_key("cookie")));
    release_server.abort();
}

/// Separate processes give the environment fallback a fresh proxy snapshot without
/// changing the environment of concurrently running tests. Every address is local;
/// the unresolvable release host forces the check to use the configured transport.
#[tokio::test]
async fn latest_version_uses_configured_and_environment_proxies() {
    use axum::http::{HeaderMap, Method, Uri};
    use std::sync::Mutex;
    if let Ok(case) = std::env::var("CK_TEST_RELEASE_PROXY") {
        let configured = std::env::var("CK_TEST_PROXY_URL").unwrap_or_default();
        let f = Fixture::from_yaml(&format!("release-proxy-{case}"), |_, hash| {
            format!("config-version: 8\nmanagement:\n  secret-key: '{hash}'\nrequests:\n  proxy-url: '{configured}'\n",)
        });
        let state = Management::with_options(
            f.rt.clone(),
            f.state.config_store().clone(),
            management::Options {
                latest_release_url: Some("http://release.example.invalid/latest".into()),
                update_check_disabled: Some(false),
                ..Default::default()
            },
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                management::router(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .unwrap()
        });
        let client = wreq::Client::builder().no_proxy().build().unwrap();
        for _ in 0..2 {
            let response = client
                .get(format!("{base}/v8/management/server/latest-version"))
                .bearer_auth("fake-management-only")
                .header("Cookie", "FAKE-browser-cookie")
                .send()
                .await
                .unwrap();
            if case == "direct" {
                assert_eq!(
                    response.status(),
                    502,
                    "direct must bypass the proxy for an unresolvable origin"
                );
                continue;
            }
            assert_eq!(response.status(), 200);
            assert_eq!(
                response.json::<Value>().await.unwrap(),
                json!({"latest-version": "v4.5.6"})
            );
        }
        server.abort();
        return;
    }
    for case in ["configured", "environment", "direct"] {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let record = seen.clone();
        let proxy = axum::Router::new().fallback(move |method: Method, uri: Uri, headers: HeaderMap| {
            record.lock().unwrap().push((method, uri, headers));
            async {
                (
                    axum::http::StatusCode::FOUND,
                    [("location", "https://github.com/prep-cook/cooker/releases/tag/v4.5.6")],
                )
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_url = format!("http://proxy-user:proxy-password@{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, proxy).await.unwrap() });
        let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "latest_version_uses_configured_and_environment_proxies",
                "--nocapture",
            ])
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("SYSTEMROOT", std::env::var("SYSTEMROOT").unwrap_or_default())
            .env("HOME", std::env::temp_dir())
            .env("CK_TEST_RELEASE_PROXY", case)
            .env(
                "CK_TEST_PROXY_URL",
                match case {
                    "configured" => &proxy_url,
                    "direct" => "direct",
                    _ => "",
                },
            )
            .env(
                "HTTP_PROXY",
                if case != "configured" {
                    &proxy_url
                } else {
                    "http://127.0.0.1:9"
                },
            )
            .env("HTTPS_PROXY", "http://127.0.0.1:9")
            .env("GITHUB_TOKEN", "FAKE-github-token")
            .env("GITSTORE_GIT_TOKEN", "FAKE-store-token")
            .env("OPENAI_API_KEY", "FAKE-provider-token")
            .kill_on_drop(true);
        let output = tokio::time::timeout(std::time::Duration::from_secs(30), command.output())
            .await
            .unwrap()
            .unwrap();
        server.abort();
        assert!(
            output.status.success(),
            "{case}: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let seen = seen.lock().unwrap();
        if case == "direct" {
            assert!(seen.is_empty(), "direct must not reach the environment proxy");
            continue;
        }
        assert_eq!(
            seen.len(),
            1,
            "two clicks share one HEAD without following the redirect"
        );
        let (method, uri, headers) = &seen[0];
        assert_eq!(*method, Method::HEAD);
        assert_eq!(uri.to_string(), "http://release.example.invalid/latest");
        assert_eq!(
            headers["proxy-authorization"],
            "Basic cHJveHktdXNlcjpwcm94eS1wYXNzd29yZA=="
        );
        assert!(!headers.contains_key("authorization"));
        assert!(!headers.contains_key("cookie"));
        assert_eq!(headers["user-agent"], "cooker");
    }
}

/// A valid but self-signed origin certificate must still fail behind an authenticated
/// CONNECT proxy. Disabling certificate checks would turn this response into a 200.
#[tokio::test]
async fn latest_version_keeps_tls_verification_through_proxy() {
    use btls::asn1::Asn1Time;
    use btls::bn::BigNum;
    use btls::ec::{EcGroup, EcKey};
    use btls::hash::MessageDigest;
    use btls::nid::Nid;
    use btls::pkey::PKey;
    use btls::ssl::{SslAcceptor, SslMethod};
    use btls::x509::extension::SubjectAlternativeName;
    use btls::x509::{X509, X509NameBuilder};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let key =
        PKey::from_ec_key(EcKey::generate(&EcGroup::from_curve_name(Nid::X9_62_PRIME256V1).unwrap()).unwrap()).unwrap();
    let mut name = X509NameBuilder::new().unwrap();
    name.append_entry_by_nid(Nid::COMMONNAME, "127.0.0.1").unwrap();
    let name = name.build();
    let mut cert = X509::builder().unwrap();
    cert.set_version(2).unwrap();
    cert.set_serial_number(&BigNum::from_u32(1).unwrap().to_asn1_integer().unwrap())
        .unwrap();
    cert.set_subject_name(&name).unwrap();
    cert.set_issuer_name(&name).unwrap();
    cert.set_pubkey(&key).unwrap();
    cert.set_not_before(&Asn1Time::days_from_now(0).unwrap()).unwrap();
    cert.set_not_after(&Asn1Time::days_from_now(1).unwrap()).unwrap();
    cert.append_extension(
        &SubjectAlternativeName::new()
            .ip("127.0.0.1")
            .build(&cert.x509v3_context(None, None))
            .unwrap(),
    )
    .unwrap();
    cert.sign(&key, MessageDigest::sha256()).unwrap();
    let mut tls = SslAcceptor::mozilla_intermediate_v5(SslMethod::tls()).unwrap();
    tls.set_certificate(&cert.build()).unwrap();
    tls.set_private_key(&key).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = listener.local_addr().unwrap();
    let tls_server = tokio::spawn(ck_server::listener::serve(
        listener,
        axum::Router::new().fallback(|| async {
            (
                axum::http::StatusCode::FOUND,
                [("location", "https://github.com/prep-cook/cooker/releases/tag/v4.5.6")],
            )
        }),
        Some(Arc::new(tls.build())),
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = listener.local_addr().unwrap();
    let proxy_server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            assert!(head.len() < 8192);
            head.push(socket.read_u8().await.unwrap());
        }
        socket
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .await
            .unwrap();
        let mut upstream = tokio::net::TcpStream::connect(origin).await.unwrap();
        let _ = tokio::io::copy_bidirectional(&mut socket, &mut upstream).await;
        String::from_utf8(head).unwrap()
    });
    let f = Fixture::from_yaml("release-proxy-tls", |_, hash| {
        format!(
            "config-version: 8\nmanagement:\n  secret-key: '{hash}'\nrequests:\n  proxy-url: 'http://proxy-user:proxy-password@{proxy}'\n",
        )
    });
    let state = Management::with_options(
        f.rt.clone(),
        f.state.config_store().clone(),
        management::Options {
            latest_release_url: Some(format!("https://{origin}/latest")),
            update_check_disabled: Some(false),
            ..Default::default()
        },
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            management::router(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap()
    });
    let response = wreq::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .get(format!("http://{base}/v8/management/server/latest-version"))
        .bearer_auth("fake-management-only")
        .header("Cookie", "FAKE-browser-cookie")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 502);
    assert_eq!(response.json::<Value>().await.unwrap()["error"], "request_failed");
    let head = tokio::time::timeout(std::time::Duration::from_secs(2), proxy_server)
        .await
        .unwrap()
        .unwrap()
        .to_ascii_lowercase();
    assert!(head.starts_with(&format!("connect {origin} http/1.1\r\n")));
    assert!(
        head.contains(&"\r\nProxy-Authorization: Basic cHJveHktdXNlcjpwcm94eS1wYXNzd29yZA==\r\n".to_ascii_lowercase())
    );
    assert!(!head.contains("\r\nauthorization:") && !head.contains("\r\ncookie:"));
    server.abort();
    tls_server.abort();
}

/// AI Studio relay credentials: disabling one through the status or fields endpoint
/// clears its cooldowns (Go `Manager.Update`), so re-enabling routes to it at once.
#[tokio::test]
async fn runtime_credential_disable_clears_its_cooldowns() {
    use ck_core::credential::Credential;
    use ck_core::exec::{ExecError, FailureScope};
    use ck_server::runtime::{Outcome, Selection};
    let f = Fixture::new("runtime-cooldown");
    let id = "aistudio-0123456789abcdef";
    assert!(f.rt.store().add_runtime(Credential::relay_session(id)));
    let selection = || Selection {
        provider: "aistudio".into(),
        ..Selection::default()
    };
    let (base, server) = f.server().await;
    let client = wreq::Client::new();
    for endpoint in ["status", "fields"] {
        let lease = f.rt.store().select(selection()).unwrap();
        assert_eq!(lease.credential.id, id);
        let mut quota = ExecError::local(429, FailureScope::Credential, "rate limited");
        quota.retry_after = Some(std::time::Duration::from_secs(600));
        lease.complete(Outcome::Failure(quota));
        assert!(!f.rt.store().cooldowns(id).is_empty(), "{endpoint}: cooling");
        assert!(f.rt.store().select(selection()).is_none(), "{endpoint}: blocked");
        for disabled in [true, false] {
            let r = client
                .patch(format!("{base}/v8/management/credentials/{endpoint}"))
                .bearer_auth("fake-management-only")
                .json(&json!({"name": id, "disabled": disabled}))
                .send()
                .await
                .unwrap();
            assert_eq!(r.status(), 200, "{endpoint} disabled={disabled}");
            assert_eq!(f.rt.store().get(id).unwrap().disabled, disabled);
            assert!(f.rt.store().cooldowns(id).is_empty(), "{endpoint} disabled={disabled}");
        }
        let lease = f.rt.store().select(selection());
        assert_eq!(
            lease.map(|l| l.credential.id.clone()).as_deref(),
            Some(id),
            "{endpoint}"
        );
    }
    server.abort();
}

/// Deleting an AI Studio relay credential (no file) answers 404 and never removes a
/// file in `auth-dir` that shares its ID.
#[tokio::test]
async fn runtime_credential_delete_spares_same_named_file() {
    let f = Fixture::new("runtime-delete");
    let id = "aistudio-0123456789abcdef";
    assert!(
        f.rt.store()
            .add_runtime(ck_core::credential::Credential::relay_session(id))
    );
    let sentinel = f.auth().join(id);
    f.writer().save(&sentinel, b"keep").unwrap();
    let (base, server) = f.server().await;
    let r = wreq::Client::new()
        .delete(format!("{base}/v8/management/credentials?name={id}"))
        .bearer_auth("fake-management-only")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 404);
    assert_eq!(r.json::<Value>().await.unwrap()["error"], "auth file not found");
    assert_eq!(
        f.rt.store().credential_backend().read(&sentinel).unwrap().unwrap(),
        b"keep"
    );
    assert!(f.rt.store().get(id).is_some());
    server.abort();
}

/// `GET /observability/usage/queue` drains queued records oldest first; a record that
/// is not JSON comes back as a string. Disabling statistics stops queueing.
#[tokio::test]
async fn usage_queue_pops_records_in_order() {
    let f = Fixture::from_yaml("usageq", |_, hash| {
        format!(
            "config-version: 8\nmanagement:\n  secret-key: '{hash}'\nobservability:\n  usage:\n    usage-statistics-enabled: true\n",
        )
    });
    let (base, server) = f.server().await;
    let queue = f.rt.usage_queue();
    queue.enqueue(br#"{"model":"a","tokens":{"total_tokens":3}}"#.to_vec());
    queue.enqueue(b"not json".to_vec());
    queue.enqueue(br#"{"model":"c"}"#.to_vec());
    let client = wreq::Client::new();
    let pop = |q: &str| {
        client
            .get(format!("{base}/v8/management/observability/usage/queue{q}"))
            .bearer_auth("fake-management-only")
            .send()
    };
    let first: Value = pop("").await.unwrap().json().await.unwrap();
    assert_eq!(first, json!([{"model": "a", "tokens": {"total_tokens": 3}}]));
    let rest: Value = pop("?count=10").await.unwrap().json().await.unwrap();
    assert_eq!(rest, json!(["not json", {"model": "c"}]));
    let r = client
        .post(format!("{base}/admin/v1/apply"))
        .bearer_auth("fake-management-only")
        .json(&json!({"ops": [{"op": "set", "path": "observability/usage/usage-statistics-enabled", "value": false}]}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert!(!queue.accepts());
    queue.enqueue(br#"{"model":"d"}"#.to_vec());
    let none: Value = pop("?count=10").await.unwrap().json().await.unwrap();
    assert_eq!(none, json!([]));
    server.abort();
}

/// api-call HEAD: Go's transport never asks for gzip on HEAD, so the upstream sees no
/// Accept-Encoding and a gzip Content-Encoding on the answer is relayed untouched.
#[tokio::test]
async fn api_call_head_does_not_negotiate_gzip() {
    use axum::http::{HeaderMap, HeaderValue};
    let upstream = axum::Router::new().route(
        "/h",
        axum::routing::head(|headers: HeaderMap| async move {
            let ae = headers
                .get("accept-encoding")
                .cloned()
                .unwrap_or_else(|| HeaderValue::from_static("none"));
            (
                [("x-ae", ae), ("content-encoding", HeaderValue::from_static("gzip"))],
                "",
            )
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/h", listener.local_addr().unwrap());
    let up = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let f = Fixture::new("apihead");
    let (base, server) = f.server().await;
    let r: Value = wreq::Client::new()
        .post(format!("{base}/v8/management/requests/api-call"))
        .bearer_auth("fake-management-only")
        .json(&json!({"method": "HEAD", "url": url}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(r["status_code"], 200);
    assert_eq!(r["header"]["X-Ae"], json!(["none"]));
    assert_eq!(r["header"]["Content-Encoding"], json!(["gzip"]));
    assert_eq!(r["body"], "");
    server.abort();
    up.abort();
}

/// Fake provider login endpoints (Claude, Codex, Kimi) on one local server; records
/// the form or JSON bodies it receives.
async fn fake_logins() -> (
    String,
    Arc<std::sync::Mutex<Vec<(String, String)>>>,
    tokio::task::JoinHandle<()>,
) {
    use base64::Engine;
    let seen: Arc<std::sync::Mutex<Vec<(String, String)>>> = Arc::default();
    let record = seen.clone();
    let b64 = |v: &Value| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(v.to_string());
    let id_token = format!(
        "{}.{}.sig",
        b64(&json!({"alg": "none"})),
        b64(&json!({"email": "c@example.invalid",
            "https://api.openai.com/auth": {"chatgpt_plan_type": "plus", "chatgpt_account_id": "acc-fake"}}))
    );
    let xai_id_token = format!(
        "{}.{}.sig",
        b64(&json!({"alg": "none"})),
        b64(&json!({"email": "x@example.invalid", "sub": "xai-user-1"}))
    );
    let app = axum::Router::new().fallback(move |uri: axum::http::Uri, body: axum::body::Bytes| {
        let record = record.clone();
        let id_token = id_token.clone();
        let xai_id_token = xai_id_token.clone();
        async move {
            record
                .lock()
                .unwrap()
                .push((uri.path().to_owned(), String::from_utf8_lossy(&body).into_owned()));
            let v = match uri.path() {
                "/oauth/token" => json!({"id_token": id_token, "access_token": "fake-codex-at",
                    "refresh_token": "fake-codex-rt", "expires_in": 3600}),
                "/v1/oauth/token" => json!({"access_token": "sk-ant-oat-fake", "refresh_token": "fake-r",
                    "expires_in": 3600, "account": {"uuid": "acct-1", "email_address": "a@example.invalid"},
                    "organization": {"uuid": "org-1", "name": "Org"}}),
                "/api/oauth/profile" => json!({"account": {"uuid": "acct-1", "email": "a@example.invalid"},
                    "organization": {"uuid": "org-1", "name": "Org"}}),
                "/api/oauth/device_authorization" => json!({"device_code": "dc", "user_code": "UC-1",
                    "verification_uri": "https://kimi.example.invalid/device",
                    "verification_uri_complete": "https://kimi.example.invalid/device?code=UC-1",
                    "expires_in": 600, "interval": 1}),
                "/api/oauth/token" => json!({"access_token": "fake-kimi-at", "refresh_token": "fake-kimi-rt",
                    "token_type": "Bearer", "expires_in": 3600, "scope": "s"}),
                // xAI: discovery names auth.x.ai endpoints, which the test seam redirects here.
                "/.well-known/openid-configuration" => json!({
                    "device_authorization_endpoint": "https://auth.x.ai/oauth2/device/code",
                    "token_endpoint": "https://auth.x.ai/oauth2/token"}),
                "/oauth2/device/code" => json!({"device_code": "xdc", "user_code": "XU-1",
                    "verification_uri": "https://accounts.x.ai/device",
                    "verification_uri_complete": "https://accounts.x.ai/device?user_code=XU-1",
                    "expires_in": 600, "interval": 1}),
                "/oauth2/token" => json!({"access_token": "fake-xai-at", "refresh_token": "fake-xai-rt",
                    "id_token": xai_id_token, "token_type": "Bearer", "expires_in": 3600}),
                // Devin: code exchange and profile (the user-status RPC gets `{}` and fails,
                // which the login tolerates).
                "/auth/cli/token" => json!({"token": "fake-devin-session"}),
                "/v3/self" => json!({"user_name": "dev-user", "user_id": "u-1", "org_id": "o-1"}),
                _ => json!({}),
            };
            axum::Json(v)
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let handle = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (base, seen, handle)
}

/// Serves `state` like `Fixture::server` but with login endpoints redirected.
async fn login_server(f: &Fixture, login_base: &str) -> (String, Arc<Management>, tokio::task::JoinHandle<()>) {
    let options = management::Options {
        login_base: Some(login_base.to_owned()),
        ..Default::default()
    };
    serve_with(f, options).await
}

/// A management server over `f`'s runtime with `options`.
async fn serve_with(
    f: &Fixture,
    options: management::Options,
) -> (String, Arc<Management>, tokio::task::JoinHandle<()>) {
    let state = Management::with_options(f.rt.clone(), f.state.config_store().clone(), options);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app = management::router(state.clone());
    let handle = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap()
    });
    (base, state, handle)
}

async fn oauth_get(base: &str, path: &str) -> Value {
    wreq::Client::new()
        .get(format!("{base}/v8/management{path}"))
        .bearer_auth("fake-management-only")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

/// Polls `/oauth/status` until it leaves `wait` (at most `secs`).
async fn final_status(base: &str, state: &str, secs: u64) -> Value {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(secs);
    loop {
        let v = oauth_get(base, &format!("/oauth/status?state={state}")).await;
        if v["status"] != "wait" || std::time::Instant::now() > deadline {
            return v;
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
}

/// xAI: Go `RequestXAIToken` answers with the device URL and code, and the poller
/// saves the credential through the file store and publishes it.
#[tokio::test]
async fn xai_login_polls_the_device_flow_and_saves_the_credential() {
    let (fake, seen, fake_server) = fake_logins().await;
    let f = Fixture::new("xailogin");
    let (base, _state, server) = login_server(&f, &fake).await;
    let started = oauth_get(&base, "/oauth/auth-url?provider=xai").await;
    let state = started["state"].as_str().unwrap().to_owned();
    assert!(state.starts_with("xai-"), "{state}");
    assert_eq!(started["status"], "ok");
    assert_eq!(started["flow"], "device");
    assert_eq!(started["url"], "https://accounts.x.ai/device?user_code=XU-1");
    assert_eq!(started["user_code"], "XU-1");
    assert_eq!(started["expires_in"], 600);
    assert_eq!(final_status(&base, &state, 10).await, json!({"status": "ok"}));
    let auth = f.auth();
    let names: Vec<String> =
        f.rt.store()
            .credential_backend()
            .documents()
            .unwrap()
            .into_iter()
            .map(|(path, _)| path.file_name().unwrap().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("xai-"))
            .collect();
    assert_eq!(names.len(), 1, "{names:?}");
    let path = auth.join(&names[0]);
    let saved: Value =
        serde_json::from_slice(&f.rt.store().credential_backend().read(&path).unwrap().unwrap()).unwrap();
    for (key, want) in [
        ("type", json!("xai")),
        ("access_token", json!("fake-xai-at")),
        ("refresh_token", json!("fake-xai-rt")),
        ("email", json!("x@example.invalid")),
        ("sub", json!("xai-user-1")),
        ("base_url", json!("https://api.x.ai/v1")),
        ("token_endpoint", json!("https://auth.x.ai/oauth2/token")),
        ("auth_kind", json!("oauth")),
        ("expires_in", json!(3600)),
        ("disabled", json!(false)),
    ] {
        assert_eq!(saved[key], want, "{key}");
    }
    let last_refresh = saved["last_refresh"].as_str().unwrap();
    assert!(chrono::DateTime::parse_from_rfc3339(last_refresh).is_ok() && last_refresh.ends_with('Z'));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    }
    let forms = seen.lock().unwrap().clone();
    let device = forms.iter().find(|(p, _)| p == "/oauth2/device/code").unwrap();
    assert!(
        device.1.contains("client_id=b1a00492-073a-47ea-816f-4c329264a828"),
        "{}",
        device.1
    );
    let token = forms.iter().find(|(p, _)| p == "/oauth2/token").unwrap();
    assert!(token.1.contains("device_code=xdc"), "{}", token.1);
    assert!(f.rt.store().snapshot().iter().any(|c| c.provider == "xai"), "published");
    server.abort();
    fake_server.abort();
}

/// Devin: Go `RequestDevinToken` needs the listener port for its fixed loopback
/// redirect; the main listener's `/callback` completes the login.
#[tokio::test]
async fn devin_login_completes_through_the_main_listener_callback() {
    let (fake, seen, fake_server) = fake_logins().await;
    // Port 0: no redirect URI can be built.
    let f = Fixture::new("devinlogin-noport");
    let (base, _state, server) = login_server(&f, &fake).await;
    let r = oauth_get(&base, "/oauth/auth-url?provider=devin").await;
    assert_eq!(r, json!({"error": "callback server unavailable"}));
    server.abort();

    let f = Fixture::from_yaml("devinlogin", |_, hash| {
        format!("config-version: 8\nserver:\n  port: 18999\nmanagement:\n  secret-key: '{hash}'\n",)
    });
    let (base, _state, server) = login_server(&f, &fake).await;
    let deliver = |state: &str, code: &str, error: &str| {
        f.rt.deliver_oauth_callback(&ck_server::runtime::OAuthCallback {
            provider: "devin",
            state: state.to_owned(),
            code: code.to_owned(),
            error: error.to_owned(),
        }) == ck_server::runtime::OAuthDelivery::Delivered
    };
    // A denied authorization ends the session with Go's message.
    let started = oauth_get(&base, "/oauth/auth-url?provider=devin").await;
    let denied = started["state"].as_str().unwrap().to_owned();
    assert!(deliver(&denied, "", "access_denied"));
    assert_eq!(
        final_status(&base, &denied, 5).await,
        json!({"status": "error", "error": "Devin authorization denied"})
    );
    // A callback for another provider or an unknown state is not delivered.
    let started = oauth_get(&base, "/oauth/auth-url?provider=devin").await;
    assert_eq!(started["status"], "ok");
    let state = started["state"].as_str().unwrap().to_owned();
    assert_eq!(state.len(), 32, "Go misc.GenerateRandomState");
    let url = url::Url::parse(started["url"].as_str().unwrap()).unwrap();
    let query: std::collections::HashMap<String, String> = url.query_pairs().into_owned().collect();
    assert_eq!(query["redirect_uri"], "http://127.0.0.1:18999/callback");
    assert_eq!(query["state"], state);
    assert!(!deliver("unknown-state", "c", ""));
    assert_ne!(
        f.rt.deliver_oauth_callback(&ck_server::runtime::OAuthCallback {
            provider: "codex",
            state: state.clone(),
            code: "c".into(),
            error: String::new(),
        }),
        ck_server::runtime::OAuthDelivery::Delivered
    );
    assert!(deliver(&state, "fake-devin-code", ""));
    assert_eq!(final_status(&base, &state, 10).await, json!({"status": "ok"}));
    let path = f.auth().join("devin-dev-user.json");
    let saved: Value =
        serde_json::from_slice(&f.rt.store().credential_backend().read(&path).unwrap().unwrap()).unwrap();
    for (key, want) in [
        ("type", "devin"),
        ("api_key", "fake-devin-session"),
        ("session_token", "fake-devin-session"),
        ("user_name", "dev-user"),
        ("user_id", "u-1"),
        ("org_id", "o-1"),
        ("auth_kind", "oauth"),
    ] {
        assert_eq!(saved[key], want, "{key}");
    }
    assert_eq!(saved["disabled"], false);
    let exchange = seen
        .lock()
        .unwrap()
        .iter()
        .find(|(p, _)| p == "/auth/cli/token")
        .unwrap()
        .1
        .clone();
    let exchange: Value = serde_json::from_str(&exchange).unwrap();
    assert_eq!(exchange["code"], "fake-devin-code");
    let verifier = exchange["code_verifier"].as_str().unwrap();
    // The challenge sent to the browser is S256(verifier).
    use base64::Engine;
    use sha2::Digest;
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sha2::Sha256::digest(verifier.as_bytes()));
    assert_eq!(query["code_challenge"], challenge);
    assert!(f.rt.store().get("devin-dev-user.json").is_some(), "published");
    server.abort();
    fake_server.abort();
}

/// A login worker that panics fails its session at once, with a fixed message,
/// instead of leaving the dashboard waiting until the session expires: here the panic
/// is on the blocking task that saves the credential, which the worker passes on.
#[tokio::test]
async fn a_panicking_login_worker_fails_the_session() {
    let (fake, _seen, fake_server) = fake_logins().await;
    let f = Fixture::new("panicklogin");
    let options = management::Options {
        login_base: Some(fake.clone()),
        login_panic: true,
        ..Default::default()
    };
    let (base, _state, server) = serve_with(&f, options).await;
    let started = oauth_get(&base, "/oauth/auth-url?provider=codex").await;
    let state = started["state"].as_str().unwrap().to_owned();
    let delivered = f.rt.deliver_oauth_callback(&ck_server::runtime::OAuthCallback {
        provider: "codex",
        state: state.clone(),
        code: "fake-code".into(),
        error: String::new(),
    });
    assert_eq!(delivered, ck_server::runtime::OAuthDelivery::Delivered);
    assert_eq!(
        final_status(&base, &state, 5).await,
        json!({"status": "error", "error": "Sign-in failed because of an internal error. Start the sign-in again."})
    );
    server.abort();
    fake_server.abort();
}

/// Codex: the main listener's `/codex/callback` hands the code to the pending login,
/// which exchanges it (PKCE verifier, Go's redirect URI) and saves the credential.
#[tokio::test]
async fn codex_login_completes_through_the_main_listener_callback() {
    let (fake, seen, fake_server) = fake_logins().await;
    let f = Fixture::new("codexlogin");
    let (base, _state, server) = login_server(&f, &fake).await;
    let started = oauth_get(&base, "/oauth/auth-url?provider=codex").await;
    let state = started["state"].as_str().unwrap().to_owned();
    assert!(
        started["url"]
            .as_str()
            .unwrap()
            .starts_with("https://auth.openai.com/oauth/authorize?")
    );
    let delivered = f.rt.deliver_oauth_callback(&ck_server::runtime::OAuthCallback {
        provider: "codex",
        state: state.clone(),
        code: "fake-code".into(),
        error: String::new(),
    });
    assert_eq!(delivered, ck_server::runtime::OAuthDelivery::Delivered);
    assert_eq!(final_status(&base, &state, 10).await, json!({"status": "ok"}));
    let token_request = seen
        .lock()
        .unwrap()
        .iter()
        .find(|(p, _)| p == "/oauth/token")
        .unwrap()
        .1
        .clone();
    assert!(token_request.contains("code=fake-code"), "{token_request}");
    assert!(
        token_request.contains("redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback"),
        "{token_request}"
    );
    assert!(token_request.contains("code_verifier="), "{token_request}");
    let creds = f.rt.store().snapshot();
    let codex = creds
        .iter()
        .find(|c| c.provider == "codex")
        .expect("saved and published");
    assert_eq!(codex.str("email"), Some("c@example.invalid"));
    assert_ne!(
        f.rt.deliver_oauth_callback(&ck_server::runtime::OAuthCallback {
            provider: "codex",
            state,
            code: "again".into(),
            error: String::new(),
        }),
        ck_server::runtime::OAuthDelivery::Delivered
    );
    server.abort();
    fake_server.abort();
}

/// Antigravity management login permits a missing project (unlike CLI completion),
/// validates the token/email, and never saves a cancelled exchange.
#[tokio::test]
async fn antigravity_management_login_flows() {
    use axum::response::IntoResponse;
    let exchanging = Arc::new(tokio::sync::Notify::new());
    let resume = Arc::new(tokio::sync::Semaphore::new(0));
    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let (notice, gate, record) = (exchanging.clone(), resume.clone(), seen.clone());
    let app = axum::Router::new().fallback(move |uri: axum::http::Uri, headers: axum::http::HeaderMap, body: axum::body::Bytes| {
        let (notice, gate, record) = (notice.clone(), gate.clone(), record.clone());
        async move {
            assert_ne!(headers.get("authorization").and_then(|v| v.to_str().ok()), Some("Bearer fake-management-only"));
            let access = headers.get("authorization").and_then(|v| v.to_str().ok()).unwrap_or("").trim_start_matches("Bearer ");
            let value = match uri.path() {
                "/token" => {
                    let form: std::collections::HashMap<String, String> = url::form_urlencoded::parse(&body).into_owned().collect();
                    record.lock().unwrap().push(form.clone());
                    let code = form.get("code").map(String::as_str).unwrap_or("");
                    if code == "denied" {
                        return (axum::http::StatusCode::FORBIDDEN, "secret-sentinel").into_response();
                    }
                    if code == "cancelled" {
                        notice.notify_one();
                        let _ = gate.acquire().await.unwrap();
                    }
                    json!({"access_token": if code == "empty-token" { "" } else { code }, "refresh_token": "fake-ag-rt", "expires_in": 3600})
                }
                "/oauth2/v2/userinfo" => {
                    if access == "bad-user" {
                        return (axum::http::StatusCode::FORBIDDEN, "secret-sentinel").into_response();
                    }
                    json!({"email": if access == "empty-email" { "".into() } else { format!("{access}@example.invalid") }})
                }
                "/v1internal:loadCodeAssist" if access == "no-project" => {
                    return (axum::http::StatusCode::FORBIDDEN, "secret-sentinel").into_response();
                }
                "/v1internal:loadCodeAssist" => json!({"cloudaicompanionProject": "fake-project"}),
                _ => panic!("unexpected login request: {uri}"),
            };
            axum::Json(value).into_response()
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let fake = format!("http://{}", listener.local_addr().unwrap());
    let upstream = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let f = Fixture::new("antigravitylogin");
    let (settled_tx, mut settled) = tokio::sync::mpsc::unbounded_channel();
    let options = management::Options {
        login_base: Some(fake.clone()),
        login_settled: Some(settled_tx),
        ..Default::default()
    };
    let (base, _management, server) = serve_with(&f, options).await;
    for (code, error) in [
        ("success", ""),
        ("no-project", ""),
        ("denied", "Failed to exchange token"),
        ("empty-token", "Failed to exchange token"),
        ("bad-user", "Failed to fetch user info"),
        ("empty-email", "Failed to fetch user info"),
        ("cancelled", "unknown or expired state"),
    ] {
        let started = if code == "success" {
            wreq::Client::new()
                .get(format!("{base}/v0/management/antigravity-auth-url"))
                .bearer_auth("fake-management-only")
                .send()
                .await
                .unwrap()
                .json::<Value>()
                .await
                .unwrap()
        } else {
            oauth_get(&base, "/oauth/auth-url?provider=antigravity").await
        };
        assert_eq!(started["status"], "ok", "{started}");
        let sid = started["state"].as_str().unwrap();
        assert_eq!(sid.len(), 32);
        let url = url::Url::parse(started["url"].as_str().unwrap()).unwrap();
        assert_eq!(url.origin().ascii_serialization(), "https://accounts.google.com");
        let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(query["state"], sid);
        assert_eq!(query["redirect_uri"], "http://localhost:51121/oauth-callback");
        assert_eq!(query["access_type"], "offline");
        let callback: Value = wreq::Client::new().post(format!("{base}/v8/management/oauth/callback"))
            .json(&json!({"provider":"anti-gravity", "redirect_url":format!("http://localhost:51121/oauth-callback?state={sid}&code={code}")}))
            .send().await.unwrap().json().await.unwrap();
        assert_eq!(callback, json!({"status":"ok"}));
        if code == "cancelled" {
            tokio::time::timeout(std::time::Duration::from_secs(5), exchanging.notified())
                .await
                .unwrap();
            let cancelled: Value = wreq::Client::new()
                .delete(format!("{base}/v8/management/oauth/session?state={sid}"))
                .bearer_auth("fake-management-only")
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(cancelled["cancelled"], true);
            resume.add_permits(1);
        }
        // Barrier: the login worker has finished, including a cancelled exchange.
        let finished = tokio::time::timeout(std::time::Duration::from_secs(5), settled.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(finished, sid);
        let status = final_status(&base, sid, 5).await;
        if error.is_empty() {
            assert_eq!(status, json!({"status":"ok"}));
            let name = format!("antigravity-{code}@example.invalid.json");
            let saved: Value = serde_json::from_slice(
                &f.rt
                    .store()
                    .credential_backend()
                    .read(&f.auth().join(&name))
                    .unwrap()
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(saved["type"], "antigravity");
            assert_eq!(saved["access_token"], code);
            assert_eq!(saved["refresh_token"], "fake-ag-rt");
            assert_eq!(
                saved["project_id"],
                if code == "no-project" {
                    Value::Null
                } else {
                    json!("fake-project")
                }
            );
            assert!(f.rt.store().get(&name).is_some(), "published");
        } else {
            assert_eq!(status, json!({"status":"error", "error":error}));
            assert!(
                f.rt.store()
                    .credential_backend()
                    .read(&f.auth().join(format!("antigravity-{code}@example.invalid.json")))
                    .unwrap()
                    .is_none()
            );
        }
    }
    for form in seen.lock().unwrap().iter() {
        assert_eq!(form["redirect_uri"], "http://localhost:51121/oauth-callback");
        assert_eq!(form["grant_type"], "authorization_code");
    }
    assert_eq!(
        f.rt.store()
            .snapshot()
            .iter()
            .filter(|c| c.provider == "antigravity")
            .count(),
        2
    );
    server.abort();
    // A rejected checkpoint install fails the login without publishing a credential.
    let down = Fixture::new("antigravitystore");
    let _down_blocked = down.reject_saves();
    let options = management::Options {
        login_base: Some(fake.clone()),
        ..Default::default()
    };
    let (base, _management, server) = serve_with(&down, options).await;
    let started = oauth_get(&base, "/oauth/auth-url?provider=antigravity").await;
    let sid = started["state"].as_str().unwrap();
    wreq::Client::new()
        .post(format!("{base}/v8/management/oauth/callback"))
        .json(&json!({"provider": "antigravity", "redirect_url": format!("http://localhost:51121/oauth-callback?state={sid}&code=stored")}))
        .send()
        .await
        .unwrap();
    assert_eq!(
        final_status(&base, sid, 5).await,
        json!({"status": "error", "error": "Failed to save token to file"})
    );
    assert!(down.rt.store().credential_backend().documents().unwrap().is_empty());
    assert!(down.rt.store().snapshot().is_empty());
    server.abort();
    upstream.abort();
}

/// Vertex service-account upload (Go `ImportVertexCredential`) through v8
/// `/oauth/import?provider=vertex` and v0 `/vertex/import`: Go's error answers, the
/// form location winning over the query, Go's file bytes, and settings of an existing
/// file kept.
#[tokio::test]
async fn vertex_service_account_import() {
    let fixture: Value = serde_json::from_str(include_str!("../../ck-exec/tests/fixtures/vertex_go.json")).unwrap();
    let basic = &fixture["import"][0];
    assert_eq!(basic["name"], "basic");
    let key = basic["input"].as_str().unwrap();
    let f = Fixture::new("verteximport");
    let (base, server) = f.server().await;
    let upload = |path: &str, body: Vec<u8>, content_type: &str| {
        let request = wreq::Client::new()
            .post(format!("{base}{path}"))
            .bearer_auth("fake-management-only")
            .header("content-type", content_type)
            .body(body);
        async move {
            let response = request.send().await.unwrap();
            (response.status().as_u16(), response.json::<Value>().await.unwrap())
        }
    };
    let form = |file: &str, location: Option<&str>| {
        let mut body = String::new();
        if let Some(location) = location {
            body.push_str(&format!(
                "--b\r\nContent-Disposition: form-data; name=\"location\"\r\n\r\n{location}\r\n"
            ));
        }
        body.push_str(&format!(
            "--b\r\nContent-Disposition: form-data; name=\"file\"; filename=\"key.json\"\r\nContent-Type: application/json\r\n\r\n{file}\r\n--b--\r\n"
        ));
        body.into_bytes()
    };
    const FORM: &str = "multipart/form-data; boundary=b";
    let v8 = "/v8/management/oauth/import?provider=vertex";
    let no_project = {
        let mut sa: Value = serde_json::from_str(key).unwrap();
        sa.as_object_mut().unwrap().remove("project_id");
        sa.to_string()
    };
    for (body, content_type, want) in [
        (b"{}".to_vec(), "application/json", json!({"error": "file required"})),
        (
            b"--b\r\nContent-Disposition: form-data; name=\"location\"\r\n\r\nx\r\n--b--\r\n".to_vec(),
            FORM,
            json!({"error": "file required"}),
        ),
        (
            form("[1]", None),
            FORM,
            json!({"error": "invalid json", "message": "json: cannot unmarshal array into Go value of type map[string]interface {}"}),
        ),
        (
            form("null", None),
            FORM,
            json!({"error": "invalid service account", "message": "service account payload is empty"}),
        ),
        (
            form("{}", None),
            FORM,
            json!({"error": "invalid service account", "message": "service account missing private_key"}),
        ),
        (form(&no_project, None), FORM, json!({"error": "project_id missing"})),
    ] {
        assert_eq!(upload(v8, body, content_type).await, (400, want));
    }
    let auth = f.auth();
    assert!(f.rt.store().credential_backend().documents().unwrap().is_empty());

    // A fresh import writes Go's bytes: the CLI golden without its empty prefix.
    let (status, body) = upload(
        "/v8/management/oauth/import?provider=VERTEX&location=us-east1",
        form(key, None),
        FORM,
    )
    .await;
    let path = auth.join("vertex-proj-1.json");
    assert_eq!(
        (status, body),
        (
            200,
            json!({"status": "ok", "auth-file": path.to_str().unwrap(), "project_id": "proj-1",
                "email": "svc@proj-1.iam.gserviceaccount.com", "location": "us-east1"})
        )
    );
    let golden = basic["files"]["vertex-proj-1.json"]
        .as_str()
        .unwrap()
        .replace("  \"prefix\": \"\",\n", "")
        .replace("us-central1", "us-east1");
    assert_eq!(
        f.rt.store().credential_backend().read(&path).unwrap().unwrap(),
        golden.as_bytes()
    );
    // The service account holds a private key: never world-readable.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    }
    let published = f.rt.store().get("vertex-proj-1.json").expect("published");
    assert_eq!(published.provider, "vertex");

    // Importing again keeps the user's settings and disabled flag, not token payload;
    // the form location wins over the query.
    f.writer()
        .save(
            &path,
            br#"{"type":"vertex","prefix":"team","disabled":true,"access_token":"fake-stale"}"#,
        )
        .unwrap();
    for edited in [false, true] {
        if edited {
            std::fs::write(
                &path,
                br#"{"type":"vertex","prefix":"cache-edit","disabled":false,"cache_only":true}"#,
            )
            .unwrap();
        } else {
            std::fs::remove_file(&path).unwrap();
        }
        let (status, body) = upload(
            "/v0/management/vertex/import?location=us-east1",
            form(key, Some(" europe-west4 ")),
            FORM,
        )
        .await;
        assert_eq!((status, &body["location"]), (200, &json!("europe-west4")));
        let saved: Value =
            serde_json::from_slice(&f.rt.store().credential_backend().read(&path).unwrap().unwrap()).unwrap();
        assert_eq!(
            (
                &saved["prefix"],
                &saved["disabled"],
                saved.get("access_token"),
                &saved["location"],
                saved.get("cache_only"),
            ),
            (&json!("team"), &json!(true), None, &json!("europe-west4"), None)
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&std::fs::read(&path).unwrap()).unwrap(),
            saved
        );
    }

    // Non-string project IDs name the file as Go's fmt.Sprint prints the float64 and
    // composite values json.Unmarshal decodes (names from Go v8.0.35 with these literals).
    for (project, file) in [
        ("1000000", "vertex-1e+06.json"),
        ("51.248178375505404", "vertex-51.248178375505404.json"),
        ("12345678901234567890", "vertex-1.2345678901234567e+19.json"),
        ("9007199254740993", "vertex-9.007199254740992e+15.json"),
        ("0.000001", "vertex-1e-06.json"),
        (r#"["a", "b"]"#, "vertex-[a-b].json"),
        (
            r#"{"b":[1.5,2e-7,true,null],"a":{"c":100000}}"#,
            "vertex-map[a_map[c_100000]-b_[1.5-2e-07-true-<nil>]].json",
        ),
    ] {
        let mut sa: Value = serde_json::from_str(key).unwrap();
        sa["project_id"] = json!("@project@");
        let sa = sa.to_string().replace(r#""@project@""#, project);
        let (status, body) = upload(v8, form(&sa, None), FORM).await;
        assert_eq!(status, 200, "{body}");
        assert!(auth.join(file).exists(), "{file}: {body}");
    }
    server.abort();

    // A rejected checkpoint install fails the import without publishing a credential.
    let down = Fixture::new("vertexstore");
    let _down_blocked = down.reject_saves();
    let (base, server) = down.server().await;
    let response = wreq::Client::new()
        .post(format!("{base}{v8}"))
        .bearer_auth("fake-management-only")
        .header("content-type", FORM)
        .body(form(key, None))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 500);
    let body = response.json::<Value>().await.unwrap();
    assert_eq!(body["error"], "save_failed");
    assert!(
        body["message"]
            .as_str()
            .unwrap()
            .contains("publish config database snapshot"),
        "{body}"
    );
    assert!(down.rt.store().credential_backend().documents().unwrap().is_empty());
    assert!(down.rt.store().get("vertex-proj-1.json").is_none(), "not published");
    server.abort();

    // A writer that succeeds before storage rejects its new document restores the
    // exact prior bytes and leaves the published credential untouched.
    let failed = Fixture::new("vertexrollback");
    let path = failed.auth().join("vertex-proj-1.json");
    let original = br#"{ "type":"vertex", "prefix":"team", "disabled":true }"#;
    failed.writer().save(&path, original).unwrap();
    watching::reload(&failed.state).unwrap();
    let before = failed.rt.store().get("vertex-proj-1.json").unwrap();
    std::fs::write(&path, br#"{"type":"vertex","prefix":"cache-edit","disabled":false}"#).unwrap();
    let _failed_blocked = failed.reject_saves();
    let (base, server) = failed.server().await;
    let response = wreq::Client::new()
        .post(format!("{base}{v8}"))
        .bearer_auth("fake-management-only")
        .header("content-type", FORM)
        .body(form(key, None))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 500);
    assert_eq!(
        failed.rt.store().credential_backend().read(&path).unwrap().unwrap(),
        original
    );
    assert_eq!(std::fs::read(&path).unwrap(), original);
    let after = failed.rt.store().get("vertex-proj-1.json").unwrap();
    assert_eq!((after.revision, after.disabled), (before.revision, true));
    server.abort();
}

/// Actual initial provider grants can finish behind a failed publication, but
/// their file preservation does not report successful login/runtime publication.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn initial_codex_and_claude_grants_merge_while_new_login_starts_are_paused() {
    use base64::Engine as _;
    use std::sync::atomic::{AtomicUsize, Ordering};
    let (arrived_tx, mut arrived_rx) = tokio::sync::mpsc::unbounded_channel();
    let codex_gate = Arc::new(tokio::sync::Semaphore::new(0));
    let claude_gate = Arc::new(tokio::sync::Semaphore::new(0));
    let requests = Arc::new(AtomicUsize::new(0));
    let id = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
        json!({"email":"pending@example.invalid",
        "https://api.openai.com/auth":{"chatgpt_plan_type":"plus","chatgpt_account_id":"pending-account"}})
        .to_string(),
    );
    let token = format!("e30.{id}.sig");
    let app=axum::Router::new().fallback({
        let (codex_gate,claude_gate,requests)=(codex_gate.clone(),claude_gate.clone(),requests.clone());
        move |uri:axum::http::Uri| {
            let (codex_gate,claude_gate,requests,arrived_tx,token)=(codex_gate.clone(),claude_gate.clone(),requests.clone(),arrived_tx.clone(),token.clone());
            async move {
                requests.fetch_add(1,Ordering::SeqCst);
                let value=match uri.path() {
                    "/oauth/token"=>{
                        arrived_tx.send("codex").unwrap();
                        codex_gate.acquire().await.unwrap().forget();
                        json!({"id_token":token,"access_token":"pending-codex-access","refresh_token":"pending-codex-refresh","expires_in":3600})
                    }
                    "/v1/oauth/token"=>{
                        arrived_tx.send("claude").unwrap();
                        claude_gate.acquire().await.unwrap().forget();
                        json!({"access_token":"sk-ant-oat-pending","refresh_token":"pending-claude-refresh","expires_in":3600,
                            "account":{"uuid":"pending-claude-account","email_address":"pending@example.invalid"},"organization":{"uuid":"pending-org","name":"Private fixture"}})
                    }
                    "/api/oauth/profile"=>json!({"account":{"uuid":"pending-claude-account","email":"pending@example.invalid"},"organization":{"uuid":"pending-org","name":"Private fixture"}}),
                    _=>json!({})
                };
                axum::Json(value)
            }
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let fake = format!("http://{}", listener.local_addr().unwrap());
    let fake_server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let f = Fixture::new("initial-pending");
    let (settled_tx, mut settled_rx) = tokio::sync::mpsc::unbounded_channel();
    let (base, state, server) = serve_with(
        &f,
        management::Options {
            login_base: Some(fake),
            login_settled: Some(settled_tx),
            ..Default::default()
        },
    )
    .await;
    struct Jobs {
        handles: Vec<tokio::task::JoinHandle<()>>,
        gates: [Arc<tokio::sync::Semaphore>; 2],
    }
    impl Drop for Jobs {
        fn drop(&mut self) {
            for gate in &self.gates {
                gate.add_permits(2);
            }
            for handle in &self.handles {
                handle.abort();
            }
        }
    }
    let mut jobs = Jobs {
        handles: vec![server, fake_server],
        gates: [codex_gate.clone(), claude_gate.clone()],
    };
    let mut sessions = std::collections::BTreeMap::new();
    for provider in ["codex", "claude"] {
        let start = oauth_get(&base, &format!("/oauth/auth-url?provider={provider}")).await;
        let sid = start["state"].as_str().unwrap().to_owned();
        let response = wreq::Client::new()
            .post(format!("{base}/v8/management/oauth/callback"))
            .json(&json!({"provider":provider,"state":sid,"code":"private-fixture-code"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 200);
        sessions.insert(provider, sid);
    }
    for _ in 0..2 {
        tokio::time::timeout(std::time::Duration::from_secs(10), arrived_rx.recv())
            .await
            .unwrap()
            .unwrap();
    }
    struct Blocked(PathBuf, std::fs::Permissions);
    impl Drop for Blocked {
        fn drop(&mut self) {
            std::fs::set_permissions(&self.0, self.1.clone()).unwrap();
        }
    }
    let publication = f.state.config_store().path().unwrap();
    #[cfg(unix)]
    let publication = publication.parent().unwrap();
    let permissions = std::fs::metadata(publication).unwrap().permissions();
    let mut blocked_permissions = permissions.clone();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        blocked_permissions.set_mode(0o500);
    }
    #[cfg(not(unix))]
    blocked_permissions.set_readonly(true);
    std::fs::set_permissions(publication, blocked_permissions).unwrap();
    let blocked = Blocked(publication.to_owned(), permissions);
    let events = Arc::new(std::sync::Mutex::new(Vec::new()));
    // Subscribe before the fault only reads the accepted view; this fixture has no
    // pending candidate until the import below.
    let _events = f
        .state
        .config_store()
        .subscribe_configuration({
            let events = events.clone();
            move |view| {
                events.lock().unwrap().push((view.revision, view.digest.clone()));
                Ok(())
            }
        })
        .unwrap();
    let mut config = f.state.config_store().load().unwrap().config.document;
    config["server"]["port"] = 8318.into();
    assert!(
        f.state
            .config_store()
            .import_yaml(&serde_yaml_ng::to_string(&config).unwrap(), "test", "pending-login")
            .is_err()
    );
    for (provider, gate) in [("codex", codex_gate), ("claude", claude_gate)] {
        gate.add_permits(1);
        let settled = tokio::time::timeout(std::time::Duration::from_secs(10), settled_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(settled, sessions[provider]);
        assert_eq!(
            oauth_get(&base, &format!("/oauth/status?state={settled}")).await["status"],
            "error",
            "no false login success"
        );
    }
    assert!(f.writer().documents().unwrap().is_empty());
    assert!(f.rt.store().snapshot().is_empty(), "no activation while pending");
    let before = requests.load(Ordering::SeqCst);
    for provider in [
        "codex",
        "claude",
        "antigravity",
        "kimi",
        "kimi-ai",
        "meta",
        "xai",
        "devin",
    ] {
        let response = wreq::Client::new()
            .get(format!("{base}/v8/management/oauth/auth-url?provider={provider}"))
            .bearer_auth("fake-management-only")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 503, "new {provider} login is paused");
    }
    assert_eq!(
        requests.load(Ordering::SeqCst),
        before,
        "new upstream grant starts are zero"
    );
    assert!(
        f.writer()
            .save(
                &f.auth().join("manual.json"),
                br#"{"type":"codex","access_token":"manual"}"#
            )
            .is_err()
    );
    assert_eq!(events.lock().unwrap().len(), 1);
    drop(blocked);
    f.writer().restore(&f.auth().join("absent.json")).unwrap();
    let documents = f.writer().documents().unwrap();
    assert_eq!(
        documents.len(),
        2,
        "both completed results survive latest-pending merges"
    );
    let refreshes: std::collections::BTreeSet<_> = documents
        .iter()
        .map(|(_, bytes)| {
            serde_json::from_slice::<Value>(bytes).unwrap()["refresh_token"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    assert_eq!(
        refreshes,
        std::collections::BTreeSet::from(["pending-codex-refresh".to_owned(), "pending-claude-refresh".to_owned()])
    );
    assert_eq!(
        events.lock().unwrap().len(),
        2,
        "the original configuration event is retained once"
    );
    assert_eq!(
        requests.load(Ordering::SeqCst),
        before,
        "recovery must not repeat grants"
    );
    // All finite login workers have sent settled. Stop and join the owned listeners.
    for handle in jobs.handles.drain(..) {
        handle.abort();
        assert!(handle.await.unwrap_err().is_cancelled());
    }
    drop(state);
}

/// Claude: a pasted callback URL posted to `/oauth/callback` finishes the login.
#[tokio::test]
async fn claude_login_completes_from_a_posted_redirect_url() {
    let (fake, _seen, fake_server) = fake_logins().await;
    let f = Fixture::new("claudelogin");
    let (base, _state, server) = login_server(&f, &fake).await;
    let started = oauth_get(&base, "/oauth/auth-url?provider=claude").await;
    let state = started["state"].as_str().unwrap().to_owned();
    let r: Value = wreq::Client::new()
        .post(format!("{base}/v8/management/oauth/callback"))
        .json(&json!({"provider": "claude",
            "redirect_url": format!("http://localhost:54545/callback?code=fake-code&state={state}")}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(r, json!({"status": "ok"}), "the callback needs no management key");
    assert_eq!(final_status(&base, &state, 10).await, json!({"status": "ok"}));
    let creds = f.rt.store().snapshot();
    let claude = creds
        .iter()
        .find(|c| c.provider == "claude")
        .expect("saved and published");
    assert_eq!(claude.str("access_token"), Some("sk-ant-oat-fake"));
    server.abort();
    fake_server.abort();
}

/// A Claude login stores its credential under its own name only when the store
/// accepts it; an email-only file of the same account is neither merged nor removed.
#[tokio::test]
async fn claude_login_stores_its_own_file_and_keeps_other_names() {
    let (fake, _seen, fake_server) = fake_logins().await;
    for down in [true, false] {
        let f = Fixture::new(&format!("claudelogin-{down}"));
        let other = f.auth().join("claude-a@example.invalid.json");
        let original = br#"{"type":"claude","email":"a@example.invalid","organization_uuid":"org-1"}"#;
        f.writer().save(&other, original).unwrap();
        let _blocked = down.then(|| f.reject_saves());
        let options = management::Options {
            login_base: Some(fake.clone()),
            ..Default::default()
        };
        let (base, _state, server) = serve_with(&f, options).await;
        let started = oauth_get(&base, "/oauth/auth-url?provider=claude").await;
        let state = started["state"].as_str().unwrap().to_owned();
        wreq::Client::new()
            .post(format!("{base}/v8/management/oauth/callback"))
            .json(&json!({"provider": "claude",
                "redirect_url": format!("http://localhost:54545/callback?code=fake-code&state={state}")}))
            .send()
            .await
            .unwrap();
        let status = final_status(&base, &state, 10).await;
        let documents = f.rt.store().credential_backend().documents().unwrap();
        if down {
            assert_eq!(
                status,
                json!({"status": "error", "error": "Failed to save authentication tokens"})
            );
            assert_eq!(documents, [(other.clone(), original.to_vec())]);
        } else {
            assert_eq!(status, json!({"status": "ok"}));
            assert_eq!(std::fs::read(&other).unwrap(), original);
            assert_eq!(documents.len(), 2);
            let (path, bytes) = documents.iter().find(|(path, _)| *path != other).unwrap();
            let name = path.file_name().unwrap().to_str().unwrap();
            assert!(
                name.starts_with("claude-") && name.ends_with("-a@example.invalid.json"),
                "{name}"
            );
            assert_eq!(
                serde_json::from_slice::<Value>(bytes).unwrap()["refresh_token"],
                "fake-r"
            );
        }
        server.abort();
    }
    fake_server.abort();
}

/// Kimi device login saves after authorization; a cancelled one saves nothing.
#[tokio::test]
async fn kimi_device_login_saves_and_a_cancelled_one_does_not() {
    let (fake, _seen, fake_server) = fake_logins().await;
    let f = Fixture::new("kimilogin");
    let (base, _state, server) = login_server(&f, &fake).await;
    let started = oauth_get(&base, "/oauth/auth-url?provider=kimi").await;
    assert_eq!(started["flow"], "device");
    assert_eq!(started["user_code"], "UC-1");
    assert_eq!(started["expires_in"], 600);
    assert_eq!(started["url"], "https://kimi.example.invalid/device?code=UC-1");
    let state = started["state"].as_str().unwrap().to_owned();
    assert!(state.starts_with("kmi-"));
    let cancelled = oauth_get(&base, "/oauth/auth-url?provider=kimi-ai").await;
    let other = cancelled["state"].as_str().unwrap().to_owned();
    let r: Value = wreq::Client::new()
        .delete(format!("{base}/v8/management/oauth/session?state={other}"))
        .bearer_auth("fake-management-only")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(r, json!({"status": "ok", "cancelled": true}));
    assert_eq!(final_status(&base, &state, 15).await, json!({"status": "ok"}));
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    let names: Vec<String> =
        f.rt.store()
            .credential_backend()
            .documents()
            .unwrap()
            .into_iter()
            .map(|(path, _)| path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
    assert_eq!(
        names
            .iter()
            .filter(|n| n.starts_with("kimi-") && !n.starts_with("kimi-ai"))
            .count(),
        1,
        "{names:?}"
    );
    assert!(!names.iter().any(|n| n.starts_with("kimi-ai")), "{names:?}");
    server.abort();
    fake_server.abort();
}

/// `provider=kimi` honours Go's `domain`/`channel` selectors, and a failed Codex
/// exchange reports Go's "token exchange failed" text in the session.
#[tokio::test]
async fn kimi_channel_selects_kimi_ai_and_codex_exchange_errors_read_like_go() {
    let (fake, _seen, fake_server) = fake_logins().await;
    let f = Fixture::new("loginselect");
    let (base, _state, server) = login_server(&f, &fake).await;
    let started = oauth_get(&base, "/oauth/auth-url?provider=kimi&channel=ai").await;
    let state = started["state"].as_str().unwrap().to_owned();
    assert!(state.starts_with("kmi-ai-"), "{state}");
    let _ = wreq::Client::new()
        .delete(format!("{base}/v8/management/oauth/session?state={state}"))
        .bearer_auth("fake-management-only")
        .send()
        .await
        .unwrap();
    server.abort();

    // A token endpoint that rejects the code.
    let rejecting = axum::Router::new()
        .fallback(|| async { (axum::http::StatusCode::BAD_REQUEST, r#"{"error":"invalid_grant"}"#) });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let bad = format!("http://{}", listener.local_addr().unwrap());
    let bad_server = tokio::spawn(async move { axum::serve(listener, rejecting).await.unwrap() });
    let (base, _state, server) = login_server(&f, &bad).await;
    let started = oauth_get(&base, "/oauth/auth-url?provider=codex").await;
    let state = started["state"].as_str().unwrap().to_owned();
    assert_eq!(
        f.rt.deliver_oauth_callback(&ck_server::runtime::OAuthCallback {
            provider: "codex",
            state: state.clone(),
            code: "fake-code".into(),
            error: String::new(),
        }),
        ck_server::runtime::OAuthDelivery::Delivered
    );
    // Go appends the upstream body; session errors are readable by anyone holding
    // the state, so cooker stops at the status (deliberate hardening).
    assert_eq!(
        final_status(&base, &state, 10).await,
        json!({"status": "error", "error":
            "Failed to exchange authorization code for tokens: token exchange failed with status 400"})
    );
    server.abort();
    bad_server.abort();
    fake_server.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_inflight_siwc_binding_is_preserved_while_new_bindings_are_paused() {
    let arrived = Arc::new(tokio::sync::Notify::new());
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let grants = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let fake = format!("http://{}", listener.local_addr().unwrap());
    let app=axum::Router::new().route("/api/accounts/oauth/token",axum::routing::post({
        let(arrived,gate,grants)=(arrived.clone(),gate.clone(),grants.clone());move||{
            let(arrived,gate,grants)=(arrived.clone(),gate.clone(),grants.clone());async move{
                grants.fetch_add(1,std::sync::atomic::Ordering::SeqCst);arrived.notify_one();gate.acquire().await.unwrap().forget();
                axum::Json(json!({"access_token":"bound-access","refresh_token":"bound-refresh","id_token":"bound-id","scope":"openid chatgpt.tokens.use.direct","expires_in":3600}))
            }
        }
    }));
    let upstream = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let f = Fixture::from_yaml("siwc-pending", |auth, hash| {
        std::fs::write(auth.join("codex.json"),r#"{"type":"codex","email":"private@example.invalid","account_id":"account","access_token":"outer-access","refresh_token":"outer-refresh","opaque":{"keep":true}}"#).unwrap();
        format!("management: {{secret-key: '{hash}'}}\n",)
    });
    let (settled_tx, mut settled_rx) = tokio::sync::mpsc::unbounded_channel();
    let (base, state, server) = serve_with(
        &f,
        management::Options {
            login_base: Some(fake),
            login_settled: Some(settled_tx),
            ..Default::default()
        },
    )
    .await;
    struct Jobs {
        handles: Vec<tokio::task::JoinHandle<()>>,
        gate: Arc<tokio::sync::Semaphore>,
    }
    impl Drop for Jobs {
        fn drop(&mut self) {
            self.gate.add_permits(2);
            for handle in &self.handles {
                handle.abort();
            }
        }
    }
    let mut jobs = Jobs {
        handles: vec![server, upstream],
        gate: gate.clone(),
    };
    let client = wreq::Client::new();
    let start: Value = client
        .post(format!("{base}/v8/management/oauth/siwc/bind"))
        .bearer_auth("fake-management-only")
        .json(&json!({"name":"codex.json"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let sid = start["state"].as_str().unwrap().to_owned();
    assert_eq!(
        client
            .post(format!("{base}/v8/management/oauth/callback"))
            .json(&json!({"state":sid,"code":"private-code","client_id":"oaiapp_issued"}))
            .send()
            .await
            .unwrap()
            .status()
            .as_u16(),
        200
    );
    tokio::time::timeout(std::time::Duration::from_secs(10), arrived.notified())
        .await
        .unwrap();
    struct Blocked(PathBuf, std::fs::Permissions);
    impl Drop for Blocked {
        fn drop(&mut self) {
            std::fs::set_permissions(&self.0, self.1.clone()).unwrap();
        }
    }
    let publication = f.state.config_store().path().unwrap();
    #[cfg(unix)]
    let publication = publication.parent().unwrap();
    let permissions = std::fs::metadata(publication).unwrap().permissions();
    let mut blocked_permissions = permissions.clone();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        blocked_permissions.set_mode(0o500);
    }
    #[cfg(not(unix))]
    blocked_permissions.set_readonly(true);
    std::fs::set_permissions(publication, blocked_permissions).unwrap();
    let blocked = Blocked(publication.to_owned(), permissions);
    let mut config = f.state.config_store().load().unwrap().config.document;
    config["server"]["port"] = 8318.into();
    assert!(
        f.state
            .config_store()
            .import_yaml(&serde_yaml_ng::to_string(&config).unwrap(), "test", "pending-binding")
            .is_err()
    );
    gate.add_permits(1);
    assert_eq!(
        tokio::time::timeout(std::time::Duration::from_secs(10), settled_rx.recv())
            .await
            .unwrap()
            .unwrap(),
        sid
    );
    assert_eq!(
        oauth_get(&base, &format!("/oauth/status?state={sid}")).await["status"],
        "error"
    );
    let file = f.auth().join("codex.json");
    assert!(
        serde_json::from_slice::<Value>(&f.writer().read(&file).unwrap().unwrap())
            .unwrap()
            .get("siwc")
            .is_none()
    );
    let paused = client
        .post(format!("{base}/v8/management/oauth/siwc/bind"))
        .bearer_auth("fake-management-only")
        .json(&json!({"name":"codex.json"}))
        .send()
        .await
        .unwrap();
    assert_eq!(paused.status().as_u16(), 503);
    drop(blocked);
    f.writer().restore(&file).unwrap();
    let bound: Value = serde_json::from_slice(&f.writer().read(&file).unwrap().unwrap()).unwrap();
    assert_eq!(bound["siwc"]["refresh_token"], "bound-refresh");
    assert_eq!(bound["refresh_token"], "outer-refresh");
    assert_eq!(bound["opaque"], json!({"keep":true}));
    assert_eq!(
        grants.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "recovery/new-start refusal must not spend another grant"
    );
    for handle in jobs.handles.drain(..) {
        handle.abort();
        assert!(handle.await.unwrap_err().is_cancelled());
    }
    drop(state);
}

/// Go v8.0.35 Sign in with ChatGPT binding (`d50a1995`, `ae3ee3be`) against a local
/// token endpoint: start validation, the legacy-callback refusal, callback forms and
/// conflicts, the bound file, the v8 summary, failures, cancellation, and the v8-only
/// invalidation by a credential upload.
#[tokio::test]
async fn siwc_binding_flows_follow_go() {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    use std::time::Duration;
    let forms: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
    let (exchanging, resume) = (
        Arc::new(tokio::sync::Notify::new()),
        Arc::new(tokio::sync::Semaphore::new(0)),
    );
    let app = axum::Router::new().route(
        "/api/accounts/oauth/token",
        axum::routing::post({
            let (forms, exchanging, resume) = (forms.clone(), exchanging.clone(), resume.clone());
            move |body: String| async move {
                forms.lock().unwrap().push(body.clone());
                let code = url::form_urlencoded::parse(body.as_bytes())
                    .find(|(k, _)| k == "code")
                    .map(|(_, v)| v.into_owned())
                    .unwrap_or_default();
                if code == "fail" {
                    return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "secret-sentinel".to_owned());
                }
                // `hang` never answers (its exchange is expected to be dropped);
                // `hold` waits for a permit.
                if code == "hang" {
                    exchanging.notify_one();
                    std::future::pending::<()>().await;
                }
                if code == "hold" {
                    exchanging.notify_one();
                    // Consumed: a dropped permit would release the next hold too.
                    resume.acquire().await.unwrap().forget();
                }
                (
                    axum::http::StatusCode::OK,
                    r#"{"access_token":"siwc-at","refresh_token":"siwc-rt","id_token":"siwc-id","scope":"openid chatgpt.tokens.use.direct","expires_in":3600}"#.to_owned(),
                )
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let fake = format!("http://{}", listener.local_addr().unwrap());
    let upstream = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let original = r#"{"type":"codex","email":"a@example.invalid","account_id":"acct","access_token":"outer","refresh_token":"outer-rt","note":"keep","big":123456789012345678901234567890,"siwc":{"device_id":"E61BBE28-07EF-466D-8E5D-A344F94AB305"}}"#;
    let f = Fixture::from_yaml("siwc", |auth, hash| {
        std::fs::write(auth.join("codex.json"), original).unwrap();
        std::fs::write(
            auth.join("claude.json"),
            r#"{"type":"claude","access_token":"a","refresh_token":"b"}"#,
        )
        .unwrap();
        std::fs::write(auth.join("no-refresh.json"), r#"{"type":"codex","access_token":"a"}"#).unwrap();
        format!(
            "config-version: 8\nmanagement:\n  secret-key: '{hash}'\noauth:\n  providers:\n    codex:\n      signin-with-chatgpt-identifier: '  Custom Agent  '\n",
        )
    });
    let file = f.auth().join("codex.json");
    let (settled_tx, mut settled) = tokio::sync::mpsc::unbounded_channel();
    let options = management::Options {
        login_base: Some(fake.clone()),
        login_settled: Some(settled_tx),
        ..Default::default()
    };
    let (base, _management, server) = serve_with(&f, options).await;
    let client = wreq::Client::new();
    let send = |method: wreq::Method, path: String, body: String| {
        let request = client
            .request(method, format!("{base}{path}"))
            .bearer_auth("fake-management-only")
            .header("content-type", "application/json")
            .body(body);
        async move {
            let response = request.send().await.unwrap();
            let status = response.status().as_u16();
            let text = response.text().await.unwrap();
            (status, text)
        }
    };
    let bind = |body: &str| send(wreq::Method::POST, "/v8/management/oauth/siwc/bind".into(), body.into());
    let callback = |body: Value| {
        send(
            wreq::Method::POST,
            "/v8/management/oauth/callback".into(),
            body.to_string(),
        )
    };
    let redirect = |state: &str, code: &str| {
        format!("http://127.0.0.1:1455/auth/callback?state={state}&code={code}&client_id=oaiapp_issued")
    };
    let parsed = |text: &str| serde_json::from_str::<Value>(text).unwrap();
    async fn wait_settled(settled: &mut tokio::sync::mpsc::UnboundedReceiver<String>) -> String {
        tokio::time::timeout(std::time::Duration::from_secs(5), settled.recv())
            .await
            .unwrap()
            .unwrap()
    }
    let bound_file = || String::from_utf8(f.rt.store().credential_backend().read(&file).unwrap().unwrap()).unwrap();

    // Start validation (gin `ShouldBindJSON`, then the target).
    for (body, status, want) in [
        ("", 400, json!({"error": "invalid request body"})),
        ("[1]", 400, json!({"error": "invalid request body"})),
        (r#"{"name":1}"#, 400, json!({"error": "invalid request body"})),
        ("{}", 400, json!({"error": "name is required"})),
        (
            r#"{"name":"missing.json"}"#,
            404,
            json!({"error": "auth file not found"}),
        ),
        (
            r#"{"name":"claude.json"}"#,
            400,
            json!({"error": "SIWC binding requires a file-backed Codex OAuth credential"}),
        ),
        (
            r#"{"name":"no-refresh.json"}"#,
            400,
            json!({"error": "SIWC binding requires a file-backed Codex OAuth credential"}),
        ),
    ] {
        let (got, text) = bind(body).await;
        assert_eq!((got, parsed(&text)), (status, want), "{body}");
    }
    let (status, _) = send(
        wreq::Method::POST,
        "/v0/management/oauth/siwc/bind".into(),
        r#"{"name":"codex.json"}"#.into(),
    )
    .await;
    assert_eq!(status, 404, "v8 only");
    let keyless = client
        .post(format!("{base}/v8/management/oauth/siwc/bind"))
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(keyless.status().as_u16(), 401);

    // A binding starts with server-held PKCE, device ID and redirect.
    let (status, text) = bind(r#"{"NAME":" codex.json "}"#).await;
    assert_eq!(status, 200, "{text}");
    let started = parsed(&text);
    let sid = started["state"].as_str().unwrap().to_owned();
    assert_eq!(
        started,
        json!({"status": "ok", "url": started["url"], "state": sid, "flow": "siwc_bind", "expires_in": 300})
    );
    let url = url::Url::parse(started["url"].as_str().unwrap()).unwrap();
    assert_eq!(
        url.as_str().split('?').next(),
        Some("https://auth.openai.com/api/accounts/authorize")
    );
    let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(query["client_id"], "dynamic_agent_client");
    assert_eq!(query["redirect_uri"], "http://127.0.0.1:1455/auth/callback");
    assert_eq!(query["agent_name_hint"], "Custom Agent");
    assert_eq!(
        query["ext_agent_host_id"],
        "urn:uuid:e61bbe28-07ef-466d-8e5d-a344f94ab305"
    );
    assert_eq!(query["state"], sid);
    assert_eq!(query["code_challenge_method"], "S256");
    assert!(!query["nonce"].is_empty() && query["nonce"] != sid);
    let (status, text) = bind(r#"{"name":"codex.json"}"#).await;
    assert_eq!(
        (status, parsed(&text)),
        (
            409,
            json!({"error": "a SIWC binding is already pending for this credential"})
        )
    );

    // Legacy sinks refuse the state and leave the binding pending.
    let (status, text) = send(
        wreq::Method::POST,
        "/v0/management/oauth-callback".into(),
        json!({"provider": "codex", "state": sid, "code": "issued-code"}).to_string(),
    )
    .await;
    assert_eq!(
        (status, parsed(&text)),
        (409, json!({"status": "error", "error": "oauth flow is not pending"}))
    );
    assert_eq!(
        f.rt.deliver_oauth_callback(&ck_server::runtime::OAuthCallback {
            provider: "codex",
            state: sid.clone(),
            code: "issued-code".into(),
            error: String::new(),
        }),
        ck_server::runtime::OAuthDelivery::RequiresV8
    );

    // Incomplete or conflicting callbacks are refused before any exchange.
    let evil = redirect(&sid, "issued-code").replace("127.0.0.1", "evil.example");
    let userinfo = redirect(&sid, "issued-code").replace("http://", "http://u@");
    for body in [
        json!({"state": sid, "code": "c"}),
        json!({"state": sid, "client_id": "client"}),
        json!({"state": sid, "code": "c", "client_id": "client", "provider": "claude"}),
        json!({"state": sid, "redirect_url": redirect("other-state", "c")}),
        json!({"state": sid, "redirect_url": evil}),
        json!({"redirect_url": userinfo}),
        json!({"redirect_url": format!("{}#frag", redirect(&sid, "c"))}),
        json!({"redirect_url": format!("{}&client_id=other", redirect(&sid, "c"))}),
        json!({"state": sid, "client_id": "other", "redirect_url": redirect(&sid, "c")}),
    ] {
        let (status, text) = callback(body.clone()).await;
        assert_eq!(status, 400, "{body}: {text}");
    }
    // Go compares the decoded `URL.Path`: `&`, `;` and `+` are literal path bytes.
    for path in [
        "/auth/callback&junk",
        "/auth/callback;junk",
        "/auth/call+back",
        "/auth/callback/",
    ] {
        let url = redirect(&sid, "c").replace("/auth/callback", path);
        let (status, text) = callback(json!({"redirect_url": url})).await;
        assert_eq!(
            (status, parsed(&text)),
            (400, json!({"status": "error", "error": "unexpected SIWC callback URL"})),
            "{path}"
        );
    }
    let (status, _) = send(
        wreq::Method::GET,
        format!("/v8/management/oauth/callback?state={sid}&code=c&client_id=a&client_id=b"),
        String::new(),
    )
    .await;
    assert_eq!(status, 400);
    assert!(forms.lock().unwrap().is_empty());

    // The pasted loopback URL completes it with the issued client ID.
    // An escaped path is the same path to Go.
    let encoded = redirect(&sid, "issued-code").replace("/auth/callback", "/auth/%63allback");
    let (status, text) = callback(json!({"provider": "openai", "redirect_url": encoded})).await;
    assert_eq!((status, parsed(&text)), (200, json!({"status": "ok"})));
    assert_eq!(wait_settled(&mut settled).await, sid);
    assert_eq!(final_status(&base, &sid, 5).await, json!({"status": "ok"}));
    let form = forms.lock().unwrap().pop().unwrap();
    let form: std::collections::HashMap<String, String> =
        url::form_urlencoded::parse(form.as_bytes()).into_owned().collect();
    assert_eq!(form["client_id"], "oaiapp_issued");
    assert_eq!(form["code"], "issued-code");
    assert_eq!(form["grant_type"], "authorization_code");
    assert_eq!(form["redirect_uri"], "http://127.0.0.1:1455/auth/callback");
    assert_eq!(form["resource"], "https://api.openai.com/v1");
    let verifier = &form["code_verifier"];
    assert_eq!(
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())),
        query["code_challenge"],
        "the verifier the session kept"
    );
    assert!(!text.contains(verifier.as_str()));
    // Go `json.Marshal` of the merged file: sorted, compact, other members verbatim.
    let bound = bound_file();
    assert!(
        bound.starts_with(r#"{"access_token":"outer","account_id":"acct","big":123456789012345678901234567890,"email":"a@example.invalid","note":"keep","refresh_token":"outer-rt","siwc":{"access_token":"siwc-at","client_id":"oaiapp_issued","device_id":"e61bbe28-07ef-466d-8e5d-a344f94ab305","expired":""#),
        "{bound}"
    );
    assert!(
        bound.ends_with(r#""refresh_token":"siwc-rt","scope":"openid chatgpt.tokens.use.direct","scopes":["openid","chatgpt.tokens.use.direct"]},"type":"codex","use_siwc":true}"#),
        "{bound}"
    );
    let published =
        f.rt.store()
            .snapshot()
            .into_iter()
            .find(|c| c.id == "codex.json")
            .unwrap();
    assert_eq!(published.metadata["use_siwc"], true);
    assert_eq!(published.metadata["siwc"]["client_id"], "oaiapp_issued");
    // The v8 list summarizes it without a token; v0 is unchanged.
    let (_, listed) = send(wreq::Method::GET, "/v8/management/credentials".into(), String::new()).await;
    for secret in ["siwc-at", "siwc-rt", "siwc-id", "oaiapp_issued"] {
        assert!(!listed.contains(secret), "{secret}");
    }
    let listed = parsed(&listed);
    let entry = |listed: &Value, name: &str| {
        listed["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["name"] == name)
            .unwrap()
            .clone()
    };
    let codex = entry(&listed, "codex.json");
    assert_eq!(
        (&codex["siwc_bind_supported"], &codex["use_siwc"], &codex["siwc_bound"]),
        (&json!(true), &json!(true), &json!(true))
    );
    let expires = chrono::DateTime::parse_from_rfc3339(codex["siwc_expires_at"].as_str().unwrap()).unwrap();
    assert!(codex["siwc_expires_at"].as_str().unwrap().ends_with('Z'));
    let left = (expires.to_utc() - chrono::Utc::now()).num_seconds();
    assert!((3300..=3420).contains(&left), "{left}");
    assert_eq!(entry(&listed, "no-refresh.json")["siwc_bind_supported"], false);
    assert!(entry(&listed, "claude.json").get("siwc_bound").is_none());
    let (_, legacy) = send(wreq::Method::GET, "/v0/management/auth-files".into(), String::new()).await;
    assert!(entry(&parsed(&legacy), "codex.json").get("siwc_bound").is_none());
    // A second callback and a late cancel change nothing.
    let (status, text) = callback(json!({"redirect_url": redirect(&sid, "issued-code")})).await;
    assert_eq!(
        (status, parsed(&text)),
        (
            409,
            json!({"status": "error", "error": "SIWC session is no longer accepting callbacks"})
        )
    );
    let (_, text) = send(
        wreq::Method::DELETE,
        format!("/v8/management/oauth/session?state={sid}"),
        String::new(),
    )
    .await;
    assert_eq!(parsed(&text), json!({"status": "ok", "cancelled": false}));

    let start = || async {
        let (status, text) = bind(r#"{"name":"codex.json"}"#).await;
        assert_eq!(status, 200, "{text}");
        parsed(&text)["state"].as_str().unwrap().to_owned()
    };
    // A denied authorization and a failed exchange report fixed messages and save nothing.
    let sid = start().await;
    let (status, _) = send(
        wreq::Method::GET,
        format!("/v8/management/oauth/callback?state={sid}&error=access_denied%3A+secret-data"),
        String::new(),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(wait_settled(&mut settled).await, sid);
    assert_eq!(
        final_status(&base, &sid, 5).await,
        json!({"status": "error", "error": "SIWC authorization was denied or failed"})
    );
    let sid = start().await;
    let (status, _) = callback(json!({"redirect_url": redirect(&sid, "fail")})).await;
    assert_eq!(status, 200);
    assert_eq!(wait_settled(&mut settled).await, sid);
    assert_eq!(
        final_status(&base, &sid, 5).await,
        json!({"status": "error", "error": "Failed to exchange SIWC authorization code; start a new binding"})
    );
    assert_eq!(bound_file(), bound);

    // Cancelling during the exchange drops it; the state is then unknown.
    let sid = start().await;
    assert_eq!(callback(json!({"redirect_url": redirect(&sid, "hang")})).await.0, 200);
    tokio::time::timeout(Duration::from_secs(5), exchanging.notified())
        .await
        .unwrap();
    let (_, text) = send(
        wreq::Method::DELETE,
        format!("/v8/management/oauth/session?state={sid}"),
        String::new(),
    )
    .await;
    assert_eq!(parsed(&text), json!({"status": "ok", "cancelled": true}));
    let (status, text) = callback(json!({"redirect_url": redirect(&sid, "hang")})).await;
    assert_eq!(
        (status, parsed(&text)),
        (404, json!({"status": "error", "error": "unknown or expired state"}))
    );

    // A v8 upload of the file, even unchanged, fails a pending binding; a v0 one does not.
    let upload = |version: &str| {
        let path = match version {
            "v8" => "/v8/management/credentials?name=codex.json",
            _ => "/v0/management/auth-files?name=codex.json",
        };
        send(wreq::Method::POST, path.into(), bound_file())
    };
    let sid = start().await;
    assert_eq!(callback(json!({"redirect_url": redirect(&sid, "hang")})).await.0, 200);
    tokio::time::timeout(Duration::from_secs(5), exchanging.notified())
        .await
        .unwrap();
    assert_eq!(upload("v8").await.0, 200);
    assert_eq!(
        final_status(&base, &sid, 5).await,
        json!({"status": "error", "error": "SIWC binding target changed; start a new binding"})
    );
    let sid = start().await;
    assert_eq!(callback(json!({"redirect_url": redirect(&sid, "hold")})).await.0, 200);
    tokio::time::timeout(Duration::from_secs(5), exchanging.notified())
        .await
        .unwrap();
    assert_eq!(upload("v0").await.0, 200);
    resume.add_permits(1);
    assert_eq!(wait_settled(&mut settled).await, sid);
    assert_eq!(final_status(&base, &sid, 5).await, json!({"status": "ok"}));

    // A v0 upload that swaps in another account does not fail the binding, but the
    // tokens never land on that account.
    let sid = start().await;
    assert_eq!(callback(json!({"redirect_url": redirect(&sid, "hold")})).await.0, 200);
    tokio::time::timeout(Duration::from_secs(5), exchanging.notified())
        .await
        .unwrap();
    let other = original.replace(r#""account_id":"acct""#, r#""account_id":"other""#);
    let (status, _) = send(
        wreq::Method::POST,
        "/v0/management/auth-files?name=codex.json".into(),
        other.clone(),
    )
    .await;
    assert_eq!(status, 200);
    let swapped = bound_file();
    assert!(swapped.contains(r#""account_id":"other""#));
    resume.add_permits(1);
    assert_eq!(wait_settled(&mut settled).await, sid);
    assert_eq!(
        final_status(&base, &sid, 5).await,
        json!({"status": "error", "error": "Failed to save SIWC binding; the target may have changed"})
    );
    assert_eq!(bound_file(), swapped);
    assert!(!swapped.contains("siwc-at"));

    // A successful binding clears the target's unauthorized cooldowns and keeps its
    // quota blocks (Go `BindCodexSIWC`), and leaves other credentials alone. Recording
    // a result rewrites the file the way Go's `MarkResult` persist does.
    let fail = |id: &str, model: &str, status: u16, scope| {
        use ck_core::exec::ExecError;
        let mut selection = ck_server::runtime::Selection::new("codex", model);
        selection.exclude = ["codex.json", "no-refresh.json"]
            .into_iter()
            .filter(|other| *other != id)
            .map(str::to_owned)
            .collect();
        let lease = f.rt.store().select(selection).unwrap();
        assert_eq!(lease.credential.id, id);
        let mut error = ExecError::local(status, scope, "upstream said no");
        error.retry_after = Some(Duration::from_secs(600));
        lease.complete(ck_server::runtime::Outcome::Failure(error));
    };
    use ck_core::exec::FailureScope;
    fail("codex.json", "m-unauthorized", 401, FailureScope::Credential);
    fail("codex.json", "m-quota", 429, FailureScope::Model);
    fail("codex.json", "m-forbidden", 403, FailureScope::Credential);
    fail("no-refresh.json", "m-unauthorized", 401, FailureScope::Credential);
    let cooling = |id: &str| {
        f.rt.store()
            .cooldowns(id)
            .into_iter()
            .map(|c| (c.model, c.status))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        cooling("codex.json"),
        [
            ("m-forbidden".into(), 403),
            ("m-quota".into(), 429),
            ("m-unauthorized".into(), 401)
        ]
    );

    // A binding never lands under an outer token refresh: one that read the
    // credential first commits its rotated tokens, then the binding follows on top.
    let sid = start().await;
    let refreshing = f.rt.store().prepare_lock("codex.json");
    let paused = refreshing.lock().await;
    let read = f.rt.store().get("codex.json").unwrap();
    assert_eq!(
        callback(json!({"redirect_url": redirect(&sid, "issued-code")})).await.0,
        200
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        oauth_get(&base, &format!("/oauth/status?state={sid}")).await,
        json!({"status": "wait"})
    );
    let rotated = ck_core::credential::MetadataPatch {
        set: serde_json::Map::from_iter([
            ("access_token".into(), "rotated-outer".into()),
            ("refresh_token".into(), "rotated-outer-rt".into()),
        ]),
        remove: vec![],
    };
    f.rt.store().apply_patch("codex.json", read.revision, &rotated).unwrap();
    drop(paused);
    assert_eq!(wait_settled(&mut settled).await, sid);
    assert_eq!(final_status(&base, &sid, 5).await, json!({"status": "ok"}));
    assert_eq!(
        cooling("codex.json"),
        [("m-forbidden".into(), 403), ("m-quota".into(), 429)]
    );
    assert_eq!(cooling("no-refresh.json"), [("m-unauthorized".into(), 401)]);
    let disk: Value = serde_json::from_str(&bound_file()).unwrap();
    let memory = f.rt.store().get("codex.json").unwrap().metadata.clone();
    for meta in [&disk, &Value::Object(memory)] {
        assert_eq!(
            (
                &meta["access_token"],
                &meta["refresh_token"],
                &meta["use_siwc"],
                &meta["siwc"]["access_token"]
            ),
            (
                &json!("rotated-outer"),
                &json!("rotated-outer-rt"),
                &json!(true),
                &json!("siwc-at")
            ),
            "{meta}"
        );
    }

    // So does a v8 delete; the file is then gone.
    let sid = start().await;
    assert_eq!(callback(json!({"redirect_url": redirect(&sid, "hang")})).await.0, 200);
    tokio::time::timeout(Duration::from_secs(5), exchanging.notified())
        .await
        .unwrap();
    let (status, _) = send(
        wreq::Method::DELETE,
        "/v8/management/credentials?name=codex.json".into(),
        String::new(),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        final_status(&base, &sid, 5).await,
        json!({"status": "error", "error": "SIWC binding target changed; start a new binding"})
    );
    assert!(!file.exists());
    let (status, _) = send(
        wreq::Method::POST,
        "/v8/management/credentials?name=codex.json".into(),
        original.into(),
    )
    .await;
    assert_eq!(status, 200);

    // A binding whose exchange is in flight, by its state.
    let pending = || async {
        let sid = start().await;
        assert_eq!(callback(json!({"redirect_url": redirect(&sid, "hang")})).await.0, 200);
        tokio::time::timeout(Duration::from_secs(5), exchanging.notified())
            .await
            .unwrap();
        sid
    };
    let changed = json!({"status": "error", "error": "SIWC binding target changed; start a new binding"});
    let other = f.auth().join("other.json");

    // Go `TestSIWCFileMutationScopeAndValidation`: a refused v8 upload, a v8 upload of
    // another file and a v0 upload keep the binding pending; a v8 reupload fails it.
    let sid = pending().await;
    let before = bound_file();
    for (path, body, want) in [
        (
            "/v8/management/credentials?name=codex.json",
            r#"{"type":"codex","excluded_models":123}"#.to_owned(),
            400,
        ),
        ("/v8/management/credentials?name=other.json", before.clone(), 200),
        ("/v0/management/auth-files?name=codex.json", before.clone(), 200),
    ] {
        let (status, text) = send(wreq::Method::POST, path.into(), body).await;
        assert_eq!(status, want, "{path}: {text}");
        assert_eq!(
            oauth_get(&base, &format!("/oauth/status?state={sid}")).await,
            json!({"status": "wait"}),
            "{path}"
        );
    }
    assert_eq!(upload("v8").await.0, 200);
    assert_eq!(final_status(&base, &sid, 5).await, changed);

    // Go `TestSIWCFileMutationRejectsLateExchange`, by route: each v8 mutation of the
    // file fails a binding whose exchange is in flight, and stops that exchange. A
    // result that returns while the mutation runs is
    // `management::siwc::tests::a_late_exchange_lands_nothing_after_a_v8_mutation`.
    for operation in ["upload", "delete", "delete-all", "delete-batch"] {
        let sid = pending().await;
        let before = bound_file();
        if operation.starts_with("delete-") {
            f.writer().save(&other, before.as_bytes()).unwrap();
        }
        let (method, path, body) = match operation {
            "upload" => (
                wreq::Method::POST,
                "/v8/management/credentials?name=codex.json",
                before.clone(),
            ),
            "delete" => (
                wreq::Method::DELETE,
                "/v8/management/credentials?name=codex.json",
                String::new(),
            ),
            "delete-all" => (
                wreq::Method::DELETE,
                "/v8/management/credentials?all=true",
                String::new(),
            ),
            _ => (
                wreq::Method::DELETE,
                "/v8/management/credentials",
                r#"["codex.json","other.json"]"#.to_owned(),
            ),
        };
        let (status, text) = send(method, path.into(), body).await;
        assert_eq!(status, 200, "{operation}: {text}");
        assert_eq!(final_status(&base, &sid, 5).await, changed, "{operation}");
        tokio::time::sleep(Duration::from_millis(300)).await;
        if operation == "upload" {
            assert_eq!(bound_file(), before, "{operation}");
            continue;
        }
        assert!(!file.exists(), "{operation}: file resurrected");
        assert!(
            f.rt.store().get("codex.json").is_none(),
            "{operation}: registration resurrected"
        );
        let (status, _) = send(
            wreq::Method::POST,
            "/v8/management/credentials?name=codex.json".into(),
            original.into(),
        )
        .await;
        assert_eq!(status, 200);
    }

    // A document revoked in SQLite cannot start a binding from its old registration.
    f.writer().delete(&file).unwrap();
    let (status, text) = bind(r#"{"name":"codex.json"}"#).await;
    assert_eq!(
        (status, parsed(&text)),
        (400, json!({"error": "SIWC binding target is unavailable or invalid"}))
    );
    server.abort();
    upstream.abort();
}

/// Go `TestAuthFilesListV8_QuotaPluginIDAndNoQuotaProbe` (0c708401, 3d61c954), without
/// its plugin half: v8 lists hide the declarative `quota_probe`, which only the v0 quota
/// route runs, and name no quota plugin; v0 lists keep the probe.
#[tokio::test]
async fn auth_files_list_v8_hides_the_quota_probe() {
    let auth = std::env::temp_dir().join(format!("manage-quota-auth-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&auth).unwrap();
    std::fs::write(
        auth.join("probe.json"),
        r#"{"type":"custom","quota_probe":{"url":"https://api.example.invalid/quota"}}"#,
    )
    .unwrap();
    let hash = bcrypt::hash("fake-management-only", 4).unwrap();
    let store = Arc::new(ck_server::testing::config_store(&auth.join("config.db")).unwrap());
    store
        .import_yaml(
            &format!("config-version: 8\nmanagement:\n  secret-key: '{hash}'\n",),
            "test",
            "",
        )
        .unwrap();
    let mut cfg = store.load().unwrap().config;
    let db = CredentialDb::initialize(store.clone()).unwrap();
    ck_server::testing::seed_credentials(&db, &auth);
    cfg.auth_dir = db.auth_dir();
    let credentials = db.scan(&cfg).unwrap().credentials;
    let rt = Arc::new(ck_server::testing::runtime_with_db(
        cfg.clone(),
        credentials,
        Executors {
            claude: ClaudeExecutor::new("http://127.0.0.1:1").unwrap(),
            codex: Default::default(),
            devices: Default::default(),
            openai: Default::default(),
            google: Default::default(),
        },
        db,
    ));
    let state = Management::new(rt, store);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            management::router(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let list = |path: &'static str| {
        let base = base.clone();
        async move {
            let listed: Value = wreq::Client::new()
                .get(format!("{base}{path}"))
                .bearer_auth("fake-management-only")
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            let files = listed["files"].as_array().unwrap().clone();
            move |name: &str| files.iter().find(|f| f["name"] == name).unwrap().clone()
        }
    };
    let v8 = list("/v8/management/credentials").await;
    let probe = v8("probe.json");
    assert!(probe.get("supports_quota").is_none(), "{probe}");
    assert!(probe.get("quota_probe").is_none(), "{probe}");
    assert!(probe.get("quota_plugin_id").is_none(), "{probe}");

    let v0 = list("/v0/management/auth-files").await;
    let probe = v0("probe.json");
    assert_eq!(probe["supports_quota"], true);
    assert_eq!(probe["quota_probe"]["url"], "https://api.example.invalid/quota");
    server.abort();
    let _ = std::fs::remove_dir_all(&auth);
}

/// Go `ForceRefreshAuth` and `ForceRefreshAll` (`authHasRefreshCredential`): a Codex
/// credential whose only refresh credential is its Sign in with ChatGPT partition
/// refreshes by name and in bulk.
#[tokio::test]
async fn siwc_only_codex_credentials_refresh_by_name_and_in_bulk() {
    let forms = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let app = axum::Router::new().route(
        "/api/accounts/oauth/token",
        axum::routing::post({
            let forms = forms.clone();
            move |body: String| async move {
                forms.lock().unwrap().push(body);
                r#"{"access_token":"siwc-new","refresh_token":"siwc-rt-new","scope":"openid chatgpt.tokens.use.direct","expires_in":3600}"#
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let token_url = format!("http://{}/api/accounts/oauth/token", listener.local_addr().unwrap());
    let upstream = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let oauth = ck_exec::codex_oauth::CodexOAuth::with_endpoints(wreq::Client::new(), "http://127.0.0.1:1", "", "")
        .with_siwc_token_url(&token_url)
        .with_retry_delay(std::time::Duration::from_millis(1));
    let codex = ck_exec::codex::CodexExecutor::with_client(wreq::Client::new(), oauth);
    let f = Fixture::from_yaml_with(
        "siwc-refresh",
        |auth, hash| {
            let siwc = |rt: &str, active: bool| {
                // A loopback base URL lets the test runtime's guard reach the token mock.
                json!({"type": "codex", "use_siwc": active, "access_token": "outer-at", "base_url": "http://127.0.0.1:1",
                       "siwc": {"access_token": "siwc-old", "refresh_token": rt, "client_id": "client-1"}})
                .to_string()
            };
            std::fs::write(auth.join("active.json"), siwc("siwc-rt-1", true)).unwrap();
            std::fs::write(auth.join("bound.json"), siwc("siwc-rt-2", false)).unwrap();
            std::fs::write(auth.join("plain.json"), r#"{"type":"codex","access_token":"a"}"#).unwrap();
            format!("config-version: 8\nmanagement:\n  secret-key: '{hash}'\n",)
        },
        codex,
    );
    let (base, server) = f.server().await;
    let refresh = |body: &'static str| {
        let request = wreq::Client::new()
            .post(format!("{base}/v8/management/credentials/refresh"))
            .bearer_auth("fake-management-only")
            .header("content-type", "application/json")
            .body(body);
        async move {
            let response = request.send().await.unwrap();
            (response.status().as_u16(), response.json::<Value>().await.unwrap())
        }
    };
    let token = |name: &str| {
        let c =
            f.rt.store()
                .snapshot()
                .into_iter()
                .find(|c| c.id.ends_with(name))
                .unwrap();
        let bytes =
            f.rt.store()
                .credential_backend()
                .read(&f.auth().join(name))
                .unwrap()
                .unwrap();
        let saved: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(saved["siwc"]["access_token"], c.metadata["siwc"]["access_token"]);
        saved["siwc"]["access_token"].as_str().unwrap().to_owned()
    };
    let refreshed_with = |forms: &[String]| {
        let mut tokens: Vec<String> = forms
            .iter()
            .map(|f| {
                url::form_urlencoded::parse(f.as_bytes())
                    .find(|(k, _)| k == "refresh_token")
                    .unwrap()
                    .1
                    .into_owned()
            })
            .collect();
        tokens.sort();
        tokens
    };

    let (status, body) = refresh(r#"{"name":"active.json"}"#).await;
    assert_eq!((status, body["ok"].clone()), (200, json!(true)), "{body}");
    assert_eq!(token("active.json"), "siwc-new");
    assert_eq!(
        refreshed_with(&forms.lock().unwrap().drain(..).collect::<Vec<_>>()),
        ["siwc-rt-1"]
    );

    let (status, body) = refresh(r#"{"all":true}"#).await;
    assert_eq!(status, 200, "{body}");
    let mut results: Vec<(String, bool)> = body["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["id"].as_str().unwrap().rsplit('/').next().unwrap().to_owned(),
                r["success"] == true,
            )
        })
        .collect();
    results.sort();
    assert_eq!(
        results,
        [("active.json".to_owned(), true), ("bound.json".to_owned(), true)],
        "plain.json has nothing to refresh"
    );
    assert_eq!(token("bound.json"), "siwc-new");
    assert_eq!(
        refreshed_with(&forms.lock().unwrap().drain(..).collect::<Vec<_>>()),
        ["siwc-rt-2", "siwc-rt-new"]
    );
    server.abort();
    upstream.abort();
}

#[test]
fn integration_fixtures_never_sweep_the_production_temporary_namespace() {
    let dir = std::env::temp_dir().join(format!("management-sweep-isolation-{}", uuid::Uuid::new_v4()));
    let sentinel = dir.join("cooker").join("a".repeat(64));
    std::fs::create_dir_all(sentinel.join("refs")).unwrap();
    std::fs::write(sentinel.join("refs/0"), b"").unwrap();
    std::fs::write(sentinel.join("live.db"), b"unrelated simulated production database").unwrap();
    // Only the child gets this private simulated OS tmp; do not mutate the
    // parallel test process's environment or create files in a real runtime root.
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "sqlite_http_deletes_are_durable_and_sql_failure_keeps_documents",
        ])
        .env("TMPDIR", &dir)
        .env("TMP", &dir)
        .env("TEMP", &dir)
        .output()
        .unwrap();
    assert!(child.status.success(), "{}", String::from_utf8_lossy(&child.stderr));
    assert_eq!(
        std::fs::read(sentinel.join("live.db")).unwrap(),
        b"unrelated simulated production database"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn sqlite_http_deletes_are_durable_and_sql_failure_keeps_documents() {
    for all in [false, true] {
        let dir = std::env::temp_dir().join(format!("management-sqlite-delete-{}", uuid::Uuid::new_v4()));
        let legacy = dir.join("legacy");
        std::fs::create_dir_all(&legacy).unwrap();
        let original = br#"{"type":"claude","access_token":"test-delete","private_extra":{"keep":true}}"#;
        for name in ["a.json", "b.json"] {
            std::fs::write(legacy.join(name), original).unwrap();
        }
        let store = Arc::new(ck_server::testing::config_store(&dir.join("config.db")).unwrap());
        let hash = bcrypt::hash("fake-management-only", 4).unwrap();
        store
            .import_yaml(&format!("management: {{secret-key: '{hash}'}}\n"), "test", "")
            .unwrap();
        let db = CredentialDb::initialize(store.clone()).unwrap();
        ck_server::testing::seed_credentials(&db, &legacy);
        let mut cfg = store.load().unwrap().config;
        cfg.auth_dir = db.auth_dir();
        let scan = db.scan(&cfg).unwrap();
        let rt = Arc::new(ck_server::testing::runtime_with_db(
            cfg,
            scan.credentials,
            Executors {
                claude: ClaudeExecutor::new("http://127.0.0.1:1").unwrap(),
                codex: Default::default(),
                devices: Default::default(),
                openai: Default::default(),
                google: Default::default(),
            },
            db.clone(),
        ));
        rt.store().note_loaded(&scan.read);
        let f = Fixture {
            dir: dir.clone(),
            state: Management::new(rt.clone(), store.clone()),
            rt,
        };
        let (base, server) = f.server().await;
        let query = if all { "all=true" } else { "name=a.json" };
        let url = format!("{base}/v8/management/credentials?{query}");
        let client = wreq::Client::new();
        let blocked = f.reject_saves();
        let response = client
            .delete(&url)
            .bearer_auth("fake-management-only")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 500, "{}", response.text().await.unwrap());
        for name in ["a.json", "b.json"] {
            let path = db.auth_dir().join(name);
            assert_eq!(db.read(&path).unwrap().unwrap(), original);
            assert_eq!(std::fs::read(path).unwrap(), original);
            assert!(f.rt.store().get(name).is_some());
        }
        drop(blocked);
        let failed_copy = dir.join("failed-delete-copy.db");
        std::fs::copy(store.path().unwrap(), &failed_copy).unwrap();
        let reopened =
            CredentialDb::initialize(Arc::new(ck_server::testing::config_store(&failed_copy).unwrap())).unwrap();
        assert_eq!(reopened.documents().unwrap().len(), 2);
        drop(reopened);
        let response = client
            .delete(&url)
            .bearer_auth("fake-management-only")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200, "{}", response.text().await.unwrap());
        assert!(f.rt.store().get("a.json").is_none());
        assert_eq!(f.rt.store().get("b.json").is_none(), all);
        server.abort();
        let _ = server.await;
        // Restore only the published file with a new cache; the live owner stays exclusive.
        let deleted_copy = dir.join("deleted-copy.db");
        std::fs::copy(store.path().unwrap(), &deleted_copy).unwrap();
        let reopened =
            CredentialDb::initialize(Arc::new(ck_server::testing::config_store(&deleted_copy).unwrap())).unwrap();
        let cache = reopened.auth_dir();
        assert!(reopened.read(&cache.join("a.json")).unwrap().is_none());
        assert!(!cache.join("a.json").exists());
        assert_eq!(reopened.read(&cache.join("b.json")).unwrap().is_none(), all);
        drop((reopened, f, db, store));
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// The value of `Set-Cookie` and the session id it sets.
fn session_cookie(response: &wreq::Response) -> (String, String) {
    let cookie = response.headers()["set-cookie"].to_str().unwrap().to_owned();
    let id = cookie
        .strip_prefix("cooker_session=")
        .and_then(|rest| rest.split(';').next())
        .unwrap()
        .to_owned();
    (cookie, id)
}

async fn sign_in(base: &str, body: Value) -> wreq::Response {
    wreq::Client::new()
        .post(format!("{base}/v8/management/session"))
        .bearer_auth("fake-management-only")
        .json(&body)
        .send()
        .await
        .unwrap()
}

/// A request as the dashboard sends it: the session cookie and the dashboard's header.
async fn with_cookie(method: wreq::Method, url: String, id: &str, extra: &[(&str, &str)]) -> wreq::Response {
    let mut request = wreq::Client::new()
        .request(method, url)
        .header("cookie", format!("cooker_session={id}"))
        .header("x-ck-dashboard", "1");
    for (name, value) in extra {
        request = request.header(*name, *value);
    }
    request.send().await.unwrap()
}

#[tokio::test]
async fn dashboard_session_cookie_signs_in_reads_and_signs_out() {
    let f = Fixture::new("session");
    let (base, server) = f.server().await;
    let config = format!("{base}/admin/v1/effective/config");
    let session = format!("{base}/v8/management/session");

    let response = sign_in(&base, json!({"path": "/router/"})).await;
    assert_eq!(response.status(), 204);
    let (cookie, id) = session_cookie(&response);
    assert_eq!(
        cookie.strip_prefix(&format!("cooker_session={id}")).unwrap(),
        "; Path=/router/; Max-Age=604800; HttpOnly; SameSite=Strict",
        "no Secure over plain HTTP"
    );
    assert_eq!(id.len(), 43, "256 random bits, base64url");
    let (remembered, _) = session_cookie(&sign_in(&base, json!({"remember": true})).await);
    assert!(remembered.contains("; Path=/; Max-Age=2592000;"), "{remembered}");
    assert_eq!(
        sign_in(&base, json!({"path": "/a; Domain=evil.example"}))
            .await
            .status(),
        400
    );

    assert_eq!(
        with_cookie(wreq::Method::GET, config.clone(), &id, &[]).await.status(),
        200
    );
    assert_eq!(
        with_cookie(wreq::Method::GET, session.clone(), &id, &[]).await.status(),
        204
    );

    let out = with_cookie(wreq::Method::DELETE, session.clone(), &id, &[]).await;
    assert_eq!(out.status(), 204);
    let (cleared, _) = session_cookie(&out);
    assert_eq!(
        cleared,
        "cooker_session=; Path=/router/; Max-Age=0; HttpOnly; SameSite=Strict"
    );
    let refused = with_cookie(wreq::Method::GET, config, &id, &[]).await;
    assert_eq!(refused.status(), 401);
    assert_eq!(
        refused.json::<Value>().await.unwrap()["message"],
        "invalid or expired session"
    );
    assert_eq!(with_cookie(wreq::Method::GET, session, &id, &[]).await.status(), 401);
    server.abort();
}

#[tokio::test]
async fn authenticated_management_answers_are_never_stored() {
    let f = Fixture::new("session-no-store");
    let (base, server) = f.server().await;
    let (_, id) = session_cookie(&sign_in(&base, json!({})).await);
    let credentials = format!("{base}/v8/management/credentials");
    let client = wreq::Client::new();
    let upload = client
        .post(format!("{credentials}?name=a.json"))
        .bearer_auth("fake-management-only")
        .json(&json!({"type": "claude", "access_token": "fake-a"}))
        .send()
        .await
        .unwrap();
    assert_eq!(upload.status(), 200);
    assert_eq!(upload.headers()["cache-control"], "no-store");
    eventually(|| f.rt.store().get("a.json").is_some()).await;
    let download = format!("{credentials}/download?name=a.json");
    let by_key = client
        .get(download.clone())
        .bearer_auth("fake-management-only")
        .send()
        .await
        .unwrap();
    assert_eq!(by_key.status(), 200);
    assert_eq!(
        by_key.headers()["cache-control"],
        "no-store",
        "key-authenticated download"
    );
    let by_cookie = with_cookie(wreq::Method::GET, download, &id, &[]).await;
    assert_eq!(by_cookie.status(), 200);
    assert_eq!(
        by_cookie.headers()["cache-control"],
        "no-store",
        "cookie-authenticated download"
    );
    // A handler's own error answer is authenticated as well.
    let missing = with_cookie(
        wreq::Method::GET,
        format!("{credentials}/download?name=b.json"),
        &id,
        &[],
    )
    .await;
    assert_eq!(missing.status(), 404);
    assert_eq!(missing.headers()["cache-control"], "no-store");
    server.abort();
}

#[tokio::test]
async fn changing_the_management_secret_ends_every_session() {
    let f = Fixture::new("session-rotate");
    let (base, server) = f.server().await;
    let original = f.rt.config().management.secret_key.clone();
    let (_, id) = session_cookie(&sign_in(&base, json!({})).await);
    let (_, other) = session_cookie(&sign_in(&base, json!({"remember": true})).await);
    let setting = format!("{base}/admin/v1/r/setting/management");
    let response = wreq::Client::new()
        .patch(&setting)
        .header("cookie", format!("cooker_session={id}"))
        .header("x-ck-dashboard", "1")
        .json(&json!({"secret-key": "fake-rotated"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    // Restore the original hash before either session is used again: neither comes back.
    let response = wreq::Client::new()
        .patch(&setting)
        .bearer_auth("fake-rotated")
        .json(&json!({"secret-key": original}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(f.rt.config().management.secret_key, original);
    assert_eq!(
        sign_in(&base, json!({})).await.status(),
        204,
        "the original key works again"
    );
    for id in [id, other] {
        assert_eq!(
            with_cookie(wreq::Method::GET, format!("{base}/admin/v1/effective/config"), &id, &[])
                .await
                .status(),
            401
        );
    }
    server.abort();
}

#[tokio::test]
async fn cookie_requests_must_come_from_the_same_origin() {
    let f = Fixture::new("session-csrf");
    let (base, server) = f.server().await;
    let (_, id) = session_cookie(&sign_in(&base, json!({})).await);
    let api_call = format!("{base}/v8/management/requests/api-call");
    let host = base.strip_prefix("http://").unwrap().to_owned();
    for extra in [
        [("sec-fetch-site", "cross-site"), ("origin", "http://evil.example")],
        [("sec-fetch-site", "same-site"), ("origin", "http://127.0.0.1:1")],
        [("x-unrelated", "1"), ("origin", "http://evil.example")],
    ] {
        let response = with_cookie(wreq::Method::POST, api_call.clone(), &id, &extra).await;
        assert_eq!(response.status(), 403, "{extra:?}");
        assert_eq!(
            response.json::<Value>().await.unwrap(),
            json!({"error": "cross-site request refused"})
        );
    }
    // Admin routes keep their own error shape.
    let response = with_cookie(
        wreq::Method::POST,
        format!("{base}/admin/v1/apply"),
        &id,
        &[("sec-fetch-site", "cross-site")],
    )
    .await;
    assert_eq!(response.status(), 403);
    assert_eq!(response.json::<Value>().await.unwrap()["error"], "forbidden");
    // The sign-in endpoint itself refuses another origin before the key.
    let response = wreq::Client::new()
        .post(format!("{base}/v8/management/session"))
        .bearer_auth("fake-management-only")
        .header("sec-fetch-site", "cross-site")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    assert!(response.headers().get("set-cookie").is_none());
    // Reads too: a sibling origin on the same site must not start a sign-in with a GET.
    let sibling = [("sec-fetch-site", "same-site"), ("origin", "http://127.0.0.1:1")];
    for url in [
        "v8/management/oauth/auth-url",
        "admin/v1/effective/config",
        "v8/management/session",
    ] {
        let response = with_cookie(wreq::Method::GET, format!("{base}/{url}"), &id, &sibling).await;
        assert_eq!(response.status(), 403, "{url}");
    }
    // Without the dashboard's header, a cookie request is refused whatever its method, as an
    // image's GET to a plain-HTTP origin arrives: no fetch metadata and no Origin.
    let bare = wreq::Client::new();
    for (method, url) in [
        (wreq::Method::GET, "v8/management/oauth/auth-url"),
        (wreq::Method::GET, "v8/management/observability/usage/queue?count=1"),
        (wreq::Method::GET, "v8/management/session"),
        (wreq::Method::DELETE, "v8/management/session"),
        (wreq::Method::POST, "admin/v1/apply"),
    ] {
        let response = bare
            .request(method, format!("{base}/{url}"))
            .header("cookie", format!("cooker_session={id}"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 403, "{url}");
        assert!(response.headers().get("set-cookie").is_none(), "{url}");
    }
    let session = format!("{base}/v8/management/session");
    assert_eq!(
        with_cookie(wreq::Method::GET, session, &id, &[]).await.status(),
        204,
        "the refused DELETE left the session live"
    );
    // A same-origin request, or one without fetch metadata, passes to the handler.
    let origin = format!("http://{host}");
    let same = [("sec-fetch-site", "same-origin"), ("origin", origin.as_str())];
    let response = with_cookie(wreq::Method::POST, api_call, &id, &same).await;
    assert_eq!(response.status(), 400, "past authentication to input validation");
    let auth_url = format!("{base}/v8/management/oauth/auth-url");
    let response = with_cookie(wreq::Method::GET, auth_url.clone(), &id, &same).await;
    assert_eq!(response.status(), 400, "past authentication to the missing provider");
    let response = with_cookie(wreq::Method::GET, auth_url, &id, &[]).await;
    assert_eq!(response.status(), 400, "past authentication to the missing provider");
    server.abort();
}

#[tokio::test]
async fn bearer_requests_ignore_cookies_and_fetch_metadata() {
    let f = Fixture::new("session-bearer");
    let (base, server) = f.server().await;
    let (_, id) = session_cookie(&sign_in(&base, json!({})).await);
    let client = wreq::Client::new();
    let response = client
        .post(format!("{base}/v8/management/requests/api-call"))
        .bearer_auth("fake-management-only")
        .header("sec-fetch-site", "cross-site")
        .header("origin", "http://evil.example")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 400, "a key is checked as before sessions existed");
    let response = client
        .get(format!("{base}/admin/v1/effective/config"))
        .bearer_auth("wrong")
        .header("cookie", format!("cooker_session={id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401, "a wrong key is not rescued by a live cookie");
    assert_eq!(
        response.json::<Value>().await.unwrap()["message"],
        "invalid management key"
    );
    server.abort();
}

#[tokio::test]
async fn session_sign_in_counts_failures_and_stale_cookies_do_not() {
    let f = Fixture::new("session-ban");
    let (base, server) = f.server().await;
    let client = wreq::Client::new();
    for _ in 0..6 {
        for url in ["admin/v1/effective/config", "v8/management/session"] {
            let stale = with_cookie(wreq::Method::GET, format!("{base}/{url}"), "stale", &[]).await;
            assert_eq!(stale.status(), 401, "{url}");
            let bare = client
                .get(format!("{base}/{url}"))
                .header("cookie", "cooker_session=stale")
                .send()
                .await
                .unwrap();
            assert_eq!(bare.status(), 403, "{url}");
        }
    }
    let (_, id) = session_cookie(&sign_in(&base, json!({})).await);
    for _ in 0..5 {
        let wrong = client
            .post(format!("{base}/v8/management/session"))
            .bearer_auth("wrong")
            .send()
            .await
            .unwrap();
        assert_eq!(wrong.status(), 401);
        assert!(wrong.headers().get("set-cookie").is_none());
    }
    let banned = sign_in(&base, json!({})).await;
    assert_eq!(banned.status(), 403);
    let message = banned.json::<Value>().await.unwrap()["error"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(message.starts_with("IP banned"), "{message}");
    // The ban covers the cookie too.
    let response = with_cookie(wreq::Method::GET, format!("{base}/admin/v1/effective/config"), &id, &[]).await;
    assert_eq!(response.status(), 403);
    server.abort();
}

#[tokio::test]
async fn cookie_answers_stay_unreadable_to_other_origins() {
    let f = Fixture::new("session-cors");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app = management::router(f.state.clone()).layer(axum::middleware::from_fn(management::cors));
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let (_, id) = session_cookie(&sign_in(&base, json!({})).await);
    let response = with_cookie(wreq::Method::GET, format!("{base}/admin/v1/effective/config"), &id, &[]).await;
    assert_eq!(response.status(), 200);
    // `*` without Allow-Credentials: browsers withhold a credentialed answer from every
    // other origin.
    assert_eq!(response.headers()["access-control-allow-origin"], "*");
    assert!(response.headers().get("access-control-allow-credentials").is_none());
    // The preflight another origin needs before adding the dashboard's header: `*` covers
    // only requests without credentials, so a credentialed one carrying the cookie fails.
    let preflight = wreq::Client::new()
        .request(wreq::Method::OPTIONS, format!("{base}/admin/v1/effective/config"))
        .header("origin", "http://127.0.0.1:1")
        .header("access-control-request-method", "GET")
        .header("access-control-request-headers", "x-ck-dashboard")
        .send()
        .await
        .unwrap();
    assert_eq!(preflight.status(), 204);
    assert_eq!(preflight.headers()["access-control-allow-origin"], "*");
    assert_eq!(preflight.headers()["access-control-allow-headers"], "*");
    assert!(preflight.headers().get("access-control-allow-credentials").is_none());
    server.abort();
}

#[tokio::test]
async fn management_accepts_only_a_bearer_key_or_the_session_cookie() {
    let f = Fixture::new("bearer-only");
    let (base, server) = f.server().await;
    let config = format!("{base}/admin/v1/effective/config");
    let key = "fake-management-only";
    let client = wreq::Client::new();
    let get = |name: &'static str, value: String| client.get(&config).header(name, value).send();
    assert_eq!(
        get("Authorization", format!("Bearer {key}")).await.unwrap().status(),
        200
    );
    assert_eq!(
        get("Authorization", format!("bearer {key}")).await.unwrap().status(),
        200
    );
    let (_, id) = session_cookie(&sign_in(&base, json!({})).await);
    assert_eq!(
        with_cookie(wreq::Method::GET, config.clone(), &id, &[]).await.status(),
        200
    );
    // A correct key in any other form is no key. Each refusal counts as a failed
    // attempt, so these stay below the loopback ban.
    for (name, value) in [
        ("X-Management-Key", key.to_owned()),
        ("Authorization", key.to_owned()),
        ("Authorization", format!("Basic {key}")),
    ] {
        assert_eq!(get(name, value.clone()).await.unwrap().status(), 401, "{name}: {value}");
    }
    let both = client
        .get(&config)
        .header("Authorization", "Bearer ")
        .header("X-Management-Key", key)
        .send()
        .await
        .unwrap();
    assert_eq!(
        both.status(),
        401,
        "an empty Bearer value does not fall back to X-Management-Key"
    );
    // The session exchange reads the same header.
    let refused = client
        .post(format!("{base}/v8/management/session"))
        .header("X-Management-Key", key)
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), 401);
    server.abort();
}
