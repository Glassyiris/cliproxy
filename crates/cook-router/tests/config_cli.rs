//! Config commands and help must not start the runtime or depend on a YAML mirror.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cook-config-{name}-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("tmp")).unwrap();
    dir
}

fn cli_command(dir: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_cook-router"));
    command
        .current_dir(dir)
        .env_clear()
        .env("TMPDIR", dir.join("tmp"))
        .env("TMP", dir.join("tmp"))
        .env("TEMP", dir.join("tmp"))
        .args(args);
    command
}

fn cli(dir: &Path, args: &[&str]) -> Output {
    cli_command(dir, args).output().unwrap()
}

async fn cli_one_worker(dir: PathBuf, args: Vec<String>) -> Output {
    tokio::task::spawn_blocking(move || {
        let args: Vec<_> = args.iter().map(String::as_str).collect();
        cli_command(&dir, &args)
            .env("TOKIO_WORKER_THREADS", "1")
            .output()
            .unwrap()
    })
    .await
    .unwrap()
}

fn success(output: Output) -> String {
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8(output.stdout).unwrap()
}

#[test]
fn help_never_creates_a_database_and_bad_databases_never_fall_back_to_yaml() {
    let dir = scratch("help");
    for args in [
        vec!["--help"],
        vec!["--db", "nested/chosen.db", "--help"],
        vec!["config", "--help"],
        vec!["config", "validate", "--help", "--db", "nested/chosen.db"],
    ] {
        success(cli(&dir, &args));
        assert!(!dir.join("cook.db").exists());
        assert!(!dir.join("nested").exists());
    }
    std::fs::write(dir.join("bad.db"), "not SQLite").unwrap();
    std::fs::write(dir.join("config.yaml"), "server:\n  host: 127.0.0.1\n  port: 0\n").unwrap();
    let output = cli(&dir, &["--db", "bad.db", "--config", "config.yaml", "--local-model"]);
    assert!(!output.status.success());
    assert_eq!(std::fs::read_to_string(dir.join("bad.db")).unwrap(), "not SQLite");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn import_validate_export_and_backup_share_the_selected_database() {
    let dir = scratch("roundtrip");
    std::fs::write(
        dir.join("source.yaml"),
        "server:\n  port: 8345\naccess:\n  api-keys: [fake-client-secret]\n",
    )
    .unwrap();
    success(cli(&dir, &["--db", "chosen.db", "config", "import", "source.yaml"]));
    assert!(!dir.join("cook.db").exists());
    std::fs::write(dir.join("source.yaml"), "server:\n  port: wrong\n").unwrap();
    success(cli(&dir, &["config", "validate", "--db", "chosen.db"]));
    let invalid = cli(&dir, &["--db", "chosen.db", "config", "import", "source.yaml"]);
    assert!(!invalid.status.success());
    let redacted = success(cli(&dir, &["config", "export", "--db", "chosen.db"]));
    assert!(!redacted.contains("fake-client-secret"));
    let full = success(cli(&dir, &["--db", "chosen.db", "config", "export", "--secrets"]));
    assert!(full.contains("8345"));
    assert!(full.contains("fake-client-secret"));
    let exported: serde_json::Value = serde_json::from_str(&full).unwrap();
    assert_eq!(exported["format"], "cook-router-config");
    std::fs::write(dir.join("export.json"), &full).unwrap();
    success(cli(&dir, &["--db", "chosen.db", "config", "validate", "export.json"]));
    success(cli(&dir, &["--db", "restored.db", "config", "import", "export.json"]));
    let restored = success(cli(&dir, &["--db", "restored.db", "config", "export", "--secrets"]));
    assert_eq!(full, restored);
    success(cli(&dir, &["--db", "chosen.db", "config", "backup", "backup.db"]));
    let backup = success(cli(&dir, &["--db", "backup.db", "config", "export", "--secrets"]));
    assert_eq!(full, backup);
    let overwrite = cli(
        &dir,
        &["--db", "chosen.db", "config", "export", "--output", "chosen.db"],
    );
    assert!(!overwrite.status.success());
    std::fs::remove_dir_all(dir).unwrap();
}

struct OnlineOwner {
    store: std::sync::Arc<cpa_server::config_store::ConfigStore>,
    runtime: std::sync::Arc<cpa_server::Runtime>,
    base: String,
    server: tokio::task::JoinHandle<()>,
    batch_requests: std::sync::Arc<tokio::sync::Notify>,
    #[cfg(unix)]
    hold_batch_ack: std::sync::Arc<std::sync::atomic::AtomicBool>,
    #[cfg(unix)]
    ack_ready: std::sync::Arc<tokio::sync::Notify>,
    #[cfg(unix)]
    ack_release: std::sync::Arc<tokio::sync::Notify>,
}

const MANAGEMENT_KEY: &str = "fake-config-cli-management-key";

impl OnlineOwner {
    async fn start(dir: &Path, database: &Path) -> Self {
        let store = std::sync::Arc::new(cpa_server::testing::config_store(database).unwrap());
        let mut cfg = store.load().unwrap().config;
        assert!(
            cfg.auth_dir.starts_with(dir),
            "the fixture must never use a real auth directory"
        );
        let db = cpa_server::credential_store::CredentialDb::initialize(store.clone(), &cfg.auth_dir).unwrap();
        cfg.auth_dir = db.auth_dir();
        let runtime = std::sync::Arc::new(cpa_server::testing::runtime_with_db(
            cfg,
            Vec::new(),
            cpa_exec::Executors {
                claude: cpa_exec::claude::ClaudeExecutor::new("http://127.0.0.1:1").unwrap(),
                codex: Default::default(),
                devices: Default::default(),
                openai: Default::default(),
                google: Default::default(),
            },
            db,
        ));
        let management = cpa_server::management::Management::with_options(
            runtime.clone(),
            store.clone(),
            cpa_server::management::Options {
                management_password: Some(MANAGEMENT_KEY.into()),
                log_dir: Some(dir.join("logs")),
                ..Default::default()
            },
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let batch_requests = std::sync::Arc::new(tokio::sync::Notify::new());
        let observed = batch_requests.clone();
        let hold_batch_ack = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let ack_ready = std::sync::Arc::new(tokio::sync::Notify::new());
        let ack_release = std::sync::Arc::new(tokio::sync::Notify::new());
        let (hold, ready, release) = (hold_batch_ack.clone(), ack_ready.clone(), ack_release.clone());
        let app = cpa_server::management::router(management).layer(axum::middleware::from_fn(
            move |request: axum::extract::Request, next: axum::middleware::Next| {
                let (observed, hold, ready, release) = (observed.clone(), hold.clone(), ready.clone(), release.clone());
                async move {
                    let batch = request.uri().path() == "/admin/v1/credentials/batch";
                    if batch {
                        observed.notify_one();
                    }
                    let response = next.run(request).await;
                    if batch && hold.swap(false, std::sync::atomic::Ordering::SeqCst) {
                        ready.notify_one();
                        release.notified().await;
                    }
                    response
                }
            },
        ));
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .unwrap();
        });
        Self {
            store,
            runtime,
            base,
            server,
            batch_requests,
            #[cfg(unix)]
            hold_batch_ack,
            #[cfg(unix)]
            ack_ready,
            #[cfg(unix)]
            ack_release,
        }
    }

    async fn stop(self) {
        self.server.abort();
        let _ = self.server.await;
    }
}

#[tokio::test]
async fn online_vertex_import_stages_privately_and_never_falls_back_on_one_worker() {
    let dir = scratch("online-vertex");
    let source = format!(
        "server:\n  port: 0\noauth: {{auth-dir: {}}}\n",
        dir.join("legacy-auth").display()
    );
    std::fs::write(dir.join("source.yaml"), source).unwrap();
    success(cli(&dir, &["--db", "service.db", "config", "import", "source.yaml"]));
    std::fs::copy(dir.join("service.db"), dir.join("local.db")).unwrap();
    let local_before = std::fs::read(dir.join("local.db")).unwrap();
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../cpa-exec/tests/fixtures/vertex_go.json")).unwrap();
    let case = fixture["import"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == "basic")
        .unwrap();
    std::fs::write(dir.join("account.json"), case["input"].as_str().unwrap()).unwrap();
    let (name, expected) = case["files"].as_object().unwrap().iter().next().unwrap();
    let expected = expected.as_str().unwrap().as_bytes();
    let owner = OnlineOwner::start(&dir, &dir.join("service.db")).await;
    let args = |url: &str, password: &str| {
        [
            "--db",
            "local.db",
            "--config",
            "source.yaml",
            "--management-base-url",
            url,
            "--password",
            password,
            "--vertex-import",
            "account.json",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>()
    };
    let output = success(cli_one_worker(dir.clone(), args(&owner.base, MANAGEMENT_KEY)).await);
    assert!(output.contains("Vertex credentials imported:"));
    assert!(!output.contains(MANAGEMENT_KEY));
    assert_eq!(
        std::fs::read(dir.join("local.db")).unwrap(),
        local_before,
        "an explicit online command must not initialize or write even a writable local database"
    );
    assert!(!dir.join("local.db.credentials").exists());
    let db = owner.runtime.store().credential_backend();
    let target = db.auth_dir().join(name);
    assert_eq!(db.read(&target).unwrap().unwrap(), expected);
    assert_eq!(std::fs::read(&target).unwrap(), expected);
    std::fs::write(dir.join("invalid.yaml"), "broken: [").unwrap();
    let mut same_owner = args(&owner.base, MANAGEMENT_KEY);
    same_owner[1] = "service.db".into();
    same_owner[3] = "invalid.yaml".into();
    success(cli_one_worker(dir.clone(), same_owner).await);
    assert_eq!(std::fs::read(dir.join("local.db")).unwrap(), local_before);
    assert_eq!(db.read(&target).unwrap().unwrap(), expected);

    let copy = dir.join("portable.db");
    std::fs::copy(owner.store.path().unwrap(), &copy).unwrap();
    let cold = std::sync::Arc::new(cpa_server::testing::config_store(&copy).unwrap());
    let restored = cpa_server::credential_store::CredentialDb::initialize(cold.clone(), &dir.join("absent")).unwrap();
    assert_eq!(
        restored.read(&restored.auth_dir().join(name)).unwrap().unwrap(),
        expected
    );
    drop((restored, cold));

    owner.batch_requests.notified().await;
    let mut changed: serde_json::Value = serde_json::from_str(case["input"].as_str().unwrap()).unwrap();
    changed["client_email"] = "changed@fixture.invalid".into();
    std::fs::write(dir.join("account.json"), serde_json::to_vec(&changed).unwrap()).unwrap();
    let before = std::fs::read(owner.store.path().unwrap()).unwrap();
    let protocol_lock = cpa_exec::codex_siwc_bind::lock_file(&target).unwrap();
    let submitting = tokio::spawn(cli_one_worker(dir.clone(), args(&owner.base, MANAGEMENT_KEY)));
    tokio::time::timeout(std::time::Duration::from_secs(15), owner.batch_requests.notified())
        .await
        .expect("the real CLI never submitted its rendered batch");
    assert_eq!(
        std::fs::read(&target).unwrap(),
        expected,
        "the client must not modify server caches before its API command is admitted"
    );
    assert_eq!(std::fs::read(owner.store.path().unwrap()).unwrap(), before);
    let response = wreq::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .get(format!("{}/admin/v1/revisions?limit=1", owner.base))
        .bearer_auth(MANAGEMENT_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        200,
        "a protocol-lock wait must leave the single async worker free"
    );
    drop(protocol_lock);
    success(submitting.await.unwrap());
    let committed = db.read(&target).unwrap().unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&committed).unwrap()["email"],
        "changed@fixture.invalid"
    );

    changed["client_email"] = "must-not-save@fixture.invalid".into();
    std::fs::write(dir.join("account.json"), serde_json::to_vec(&changed).unwrap()).unwrap();
    let before = std::fs::read(owner.store.path().unwrap()).unwrap();
    let unused = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let dead = format!("http://{}", unused.local_addr().unwrap());
    drop(unused);
    let tls = owner.base.replacen("http://", "https://", 1);
    for (url, password) in [
        (owner.base.as_str(), "wrong-key"),
        (dead.as_str(), MANAGEMENT_KEY),
        (tls.as_str(), MANAGEMENT_KEY),
    ] {
        let output = cli_one_worker(dir.clone(), args(url, password)).await;
        assert!(!output.status.success());
        assert!(!String::from_utf8_lossy(&output.stdout).contains("Vertex credentials imported:"));
        assert!(!String::from_utf8_lossy(&output.stderr).contains(MANAGEMENT_KEY));
        assert_eq!(std::fs::read(dir.join("local.db")).unwrap(), local_before);
        assert_eq!(std::fs::read(owner.store.path().unwrap()).unwrap(), before);
        assert_eq!(std::fs::read(&target).unwrap(), committed);
    }
    let blocked = cpa_server::testing::block_checkpoint_install(&owner.store);
    let output = cli_one_worker(dir.clone(), args(&owner.base, MANAGEMENT_KEY)).await;
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("HTTP 500"));
    assert!(!String::from_utf8_lossy(&output.stdout).contains("Vertex credentials imported:"));
    assert_eq!(std::fs::read(&target).unwrap(), committed);
    assert_eq!(std::fs::read(dir.join("local.db")).unwrap(), local_before);
    assert_eq!(std::fs::read(owner.store.path().unwrap()).unwrap(), before);
    drop(blocked);
    success(cli_one_worker(dir.clone(), args(&owner.base, MANAGEMENT_KEY)).await);
    assert!(!dir.join("local.db.credentials").exists());
    assert!(
        !std::fs::read_dir(dir.join("tmp")).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("cook-router-login-")
        }),
        "private client staging must be removed on success and failure"
    );
    drop(db);
    owner.stop().await;
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
async fn online_native_plugin_host_save_and_returned_auths_share_the_owner() {
    use base64::Engine as _;
    let built =
        cpa_plugin::testing::built_plugins(Path::new(env!("CARGO_TARGET_TMPDIR")), "online-native-plugin").unwrap();
    let dir = scratch("online-plugin");
    let plugins = dir.join("plugins");
    let records = dir.join("records");
    let respond = records.join("respond/a");
    std::fs::create_dir_all(&plugins).unwrap();
    std::fs::create_dir_all(&respond).unwrap();
    std::fs::copy(built.join("recorder.so"), plugins.join("rec.so")).unwrap();
    let source = format!(
        "config-version: 8\nserver:\n  port: 0\noauth: {{auth-dir: {}}}\nplugins:\n  enabled: true\n  dir: {}\n  configs:\n    rec:\n      enabled: true\n      record: {}\n      label: a\n      caps: command_line_plugin\n",
        dir.join("legacy").display(),
        plugins.display(),
        records.display()
    );
    std::fs::write(dir.join("source.yaml"), source).unwrap();
    success(cli(&dir, &["--db", "service.db", "config", "import", "source.yaml"]));
    std::fs::copy(dir.join("service.db"), dir.join("local.db")).unwrap();
    let local_before = std::fs::read(dir.join("local.db")).unwrap();
    std::fs::write(dir.join("broken.yaml"), "invalid: [").unwrap();
    std::fs::write(
        respond.join("command_line.register.json"),
        serde_json::to_vec(
            &serde_json::json!({"ok":true,"result":{"Flags":[{"Name":"online-fixture","Type":"bool"}]}}),
        )
        .unwrap(),
    )
    .unwrap();
    let host_bytes = br#" {"type":"rec","opaque":{"stage":"host","keep":[1,true]}}
"#;
    let returned = br#"{"token":"final-FAKE","opaque":{"stage":"returned","keep":[1,true]}}"#;
    std::fs::write(respond.join("command_line.execute.json"),serde_json::to_vec(&serde_json::json!({
        "ok":true,"spawn":true,"host_calls":[{"method":"host.auth.save","request":{"name":"shared-online.json","json":serde_json::from_slice::<serde_json::Value>(host_bytes).unwrap()}}],
        "result":{"ExitCode":0,"Auths":[{"FileName":"shared-online.json","Provider":"rec","Metadata":{"extension":{"owner":"fixture"}},"StorageJSON":base64::engine::general_purpose::STANDARD.encode(returned)}]}
    })).unwrap()).unwrap();
    let owner = OnlineOwner::start(&dir, &dir.join("service.db")).await;
    let db = owner.runtime.store().credential_backend();
    let target = db.auth_dir().join("shared-online.json");
    let seed = br#"{"type":"rec","opaque":"original"}"#;
    db.save(&target, seed).unwrap();
    let args = |password: &str| {
        vec![
            "--management-base-url".into(),
            owner.base.clone(),
            "--password".into(),
            password.into(),
            "--config".into(),
            "broken.yaml".into(),
            "--db".into(),
            "local.db".into(),
            "--online-fixture".into(),
        ]
    };
    let before = std::fs::read(owner.store.path().unwrap()).unwrap();
    let lock = cpa_exec::codex_siwc_bind::lock_file(&target).unwrap();
    owner.hold_batch_ack.store(true, std::sync::atomic::Ordering::SeqCst);
    let work = dir.clone();
    let request = args(MANAGEMENT_KEY);
    let mut submitting = tokio::spawn(async move { cli_one_worker(work, request).await });
    tokio::select! {
        _ = owner.batch_requests.notified() => {},
        result = &mut submitting => { let output=result.unwrap(); panic!("plugin exited before reaching owner: {}",String::from_utf8_lossy(&output.stderr)); },
    }
    assert!(
        !submitting.is_finished(),
        "native host.save must await owner acknowledgement"
    );
    assert_eq!(db.read(&target).unwrap().unwrap(), seed);
    assert_eq!(
        std::fs::read(&target).unwrap(),
        seed,
        "client cannot write the server credential cache before admission"
    );
    assert_eq!(std::fs::read(owner.store.path().unwrap()).unwrap(), before);
    assert_eq!(std::fs::read(dir.join("local.db")).unwrap(), local_before);
    let reachable = wreq::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .get(format!("{}/admin/v1/revisions?limit=1", owner.base))
        .bearer_auth(MANAGEMENT_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(
        reachable.status(),
        200,
        "native callback wait cannot block the one async worker"
    );
    drop(lock);
    owner.ack_ready.notified().await;
    let before_ack = db.read(&target).unwrap().unwrap();
    let awaiting_ack = !submitting.is_finished();
    owner.ack_release.notify_one();
    let output = submitting.await.unwrap();
    success(output);
    assert!(
        awaiting_ack,
        "native host save cannot finish before the persisted receipt is released"
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&before_ack).unwrap()["opaque"]["stage"],
        "host",
        "the first acknowledged command must be host.auth.save, before returned AuthData can replace it"
    );
    let committed = db.read(&target).unwrap().unwrap();
    let doc: serde_json::Value = serde_json::from_slice(&committed).unwrap();
    assert_eq!(doc["token"], "final-FAKE");
    assert_eq!(doc["opaque"]["stage"], "returned");
    assert_eq!(doc["extension"]["owner"], "fixture");
    let calls = cpa_server::testing::records(&records.join("a.jsonl"));
    let command = calls
        .iter()
        .find(|record| record["method"] == "command_line.execute")
        .unwrap();
    let request: serde_json::Value = serde_json::from_str(command["request"].as_str().unwrap()).unwrap();
    let private = request["Host"]["AuthDir"].as_str().unwrap();
    assert_ne!(Path::new(private), db.auth_dir());
    assert!(
        !Path::new(private).exists(),
        "joined plugin must release its scratch before returning"
    );
    let callback = calls.iter().find(|record| record["method"] == "host_callback").unwrap();
    let response: serde_json::Value = serde_json::from_str(callback["request"].as_str().unwrap()).unwrap();
    assert_eq!(response["ok"], true, "host save itself must acknowledge persistence");
    let copy = dir.join("plugin-portable.db");
    std::fs::copy(owner.store.path().unwrap(), &copy).unwrap();
    let restored = std::sync::Arc::new(cpa_server::testing::config_store(&copy).unwrap());
    let restored_db =
        cpa_server::credential_store::CredentialDb::initialize(restored.clone(), &dir.join("absent")).unwrap();
    assert_eq!(
        restored_db
            .read(&restored_db.auth_dir().join("shared-online.json"))
            .unwrap()
            .unwrap(),
        committed
    );
    drop((restored_db, restored));
    let blocked = cpa_server::testing::block_checkpoint_install(&owner.store);
    let output = cli_one_worker(dir.clone(), args(MANAGEMENT_KEY)).await;
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("HTTP 500"));
    assert!(!String::from_utf8_lossy(&output.stdout).contains("Authentication saved to"));
    assert_eq!(db.read(&target).unwrap().unwrap(), committed);
    drop(blocked);
    let output = cli_one_worker(dir.clone(), args("wrong-key")).await;
    assert!(!output.status.success());
    let before_noop = std::fs::read(owner.store.path().unwrap()).unwrap();
    std::fs::write(respond.join("command_line.execute.json"),serde_json::to_vec(&serde_json::json!({"ok":true,"result":{"ExitCode":0,
        "Auths":[{"FileName":"disabled-missing.json","Provider":"rec","Disabled":true,"StorageJSON":base64::engine::general_purpose::STANDARD.encode(returned)}]}})).unwrap()).unwrap();
    let output = cli_one_worker(dir.clone(), args(MANAGEMENT_KEY)).await;
    let stdout = success(output);
    assert!(
        !stdout.contains("Authentication saved to"),
        "a deliberate no-op is not a saved credential"
    );
    assert!(db.read(&db.auth_dir().join("disabled-missing.json")).unwrap().is_none());
    assert_eq!(std::fs::read(owner.store.path().unwrap()).unwrap(), before_noop);
    std::fs::write(respond.join("command_line.execute.json"),serde_json::to_vec(&serde_json::json!({"ok":true,"result":{"ExitCode":0,
        "Auths":[{"FileName":target.to_string_lossy(),"Provider":"rec","StorageJSON":base64::engine::general_purpose::STANDARD.encode(returned)}]}})).unwrap()).unwrap();
    let output = cli_one_worker(dir.clone(), args(MANAGEMENT_KEY)).await;
    assert!(
        !output.status.success(),
        "an explicit server-cache host path cannot become a direct client write"
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains("Authentication saved to"));
    assert_eq!(std::fs::read(&target).unwrap(), committed);
    assert_eq!(std::fs::read(owner.store.path().unwrap()).unwrap(), before_noop);
    assert_eq!(std::fs::read(dir.join("local.db")).unwrap(), local_before);
    assert!(!dir.join("local.db.credentials").exists());
    assert!(!std::fs::read_dir(dir.join("tmp")).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("cook-router-login-")
    }));
    drop(db);
    owner.stop().await;
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn online_import_uses_the_owner_without_local_fallback() {
    let dir = scratch("online-owner");
    let source = |port| {
        format!(
            "server:\n  port: {port}\noauth: {{auth-dir: {}}}\n",
            dir.join("auth").display()
        )
    };
    std::fs::write(dir.join("source.yaml"), source(8450)).unwrap();
    success(cli(&dir, &["--db", "service.db", "config", "import", "source.yaml"]));
    std::fs::copy(dir.join("service.db"), dir.join("local.db")).unwrap();
    let local_before = std::fs::read(dir.join("local.db")).unwrap();
    let owner = OnlineOwner::start(&dir, &dir.join("service.db")).await;
    let offline = cli(&dir, &["--db", "service.db", "config", "import", "source.yaml"]);
    assert!(
        !offline.status.success(),
        "offline writes cannot bypass an active owner"
    );
    assert!(String::from_utf8_lossy(&offline.stderr).contains("already owned"));
    std::fs::write(dir.join("source.yaml"), source(8451)).unwrap();
    let online = |url: &str, password: &str| {
        cli(
            &dir,
            &[
                "--db",
                "local.db",
                "--management-base-url",
                url,
                "--password",
                password,
                "config",
                "import",
                "source.yaml",
            ],
        )
    };
    let output = success(online(&owner.base, MANAGEMENT_KEY));
    assert!(!output.contains(MANAGEMENT_KEY));
    assert_eq!(owner.store.load().unwrap().config.port, 8451);
    assert_eq!(owner.runtime.config().port, 8451, "success follows runtime publication");
    assert_eq!(std::fs::read(dir.join("local.db")).unwrap(), local_before);

    // The key can come from the environment instead of the command line; without
    // either, a non-interactive command sends none and the owner refuses it.
    let keyless = |key: Option<&str>| {
        let mut command = cli_command(
            &dir,
            &[
                "--db",
                "local.db",
                "--management-base-url",
                &owner.base,
                "config",
                "import",
                "source.yaml",
            ],
        );
        match key {
            Some(key) => command.env("COOK_ROUTER_MANAGEMENT_KEY", key),
            None => command.env_remove("COOK_ROUTER_MANAGEMENT_KEY"),
        };
        command.stdin(std::process::Stdio::null()).output().unwrap()
    };
    std::fs::write(dir.join("source.yaml"), source(8453)).unwrap();
    let refused = keyless(None);
    assert!(!refused.status.success(), "no key must not authorize an online import");
    assert_eq!(owner.runtime.config().port, 8451);
    success(keyless(Some(MANAGEMENT_KEY)));
    assert_eq!(
        owner.runtime.config().port,
        8453,
        "the environment key authorizes the import"
    );
    assert_eq!(std::fs::read(dir.join("local.db")).unwrap(), local_before);
    // Ambient selectors (COOK_DB, a config.yaml and .env in the working directory)
    // do not change what an online import computes or where it commits.
    std::fs::write(dir.join("config.yaml"), source(8499)).unwrap();
    std::fs::write(dir.join(".env"), "COOK_DB=dotenv.db\n").unwrap();
    std::fs::write(dir.join("source.yaml"), source(8454)).unwrap();
    let ambient = cli_command(
        &dir,
        &["--management-base-url", &owner.base, "config", "import", "source.yaml"],
    )
    .env("COOK_DB", dir.join("ambient.db"))
    .env("COOK_ROUTER_MANAGEMENT_KEY", MANAGEMENT_KEY)
    .stdin(std::process::Stdio::null())
    .output()
    .unwrap();
    success(ambient);
    assert_eq!(owner.runtime.config().port, 8454);
    assert!(!dir.join("ambient.db").exists() && !dir.join("dotenv.db").exists());
    std::fs::remove_file(dir.join(".env")).unwrap();
    std::fs::remove_file(dir.join("config.yaml")).unwrap();
    std::fs::write(dir.join("source.yaml"), source(8451)).unwrap();
    success(online(&owner.base, MANAGEMENT_KEY));
    let remote_before = std::fs::read(dir.join("service.db")).unwrap();
    std::fs::write(dir.join("source.yaml"), source(8452)).unwrap();
    let unavailable = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let dead_url = format!("http://{}", unavailable.local_addr().unwrap());
    drop(unavailable);
    let tls_url = owner.base.replacen("http://", "https://", 1);
    for (url, password) in [
        (owner.base.as_str(), "wrong-key"),
        (dead_url.as_str(), MANAGEMENT_KEY),
        (tls_url.as_str(), MANAGEMENT_KEY),
    ] {
        let output = online(url, password);
        assert!(
            !output.status.success(),
            "authentication/transport failure must be an error"
        );
        assert!(!String::from_utf8_lossy(&output.stderr).contains(MANAGEMENT_KEY));
        assert_eq!(std::fs::read(dir.join("local.db")).unwrap(), local_before);
        assert_eq!(std::fs::read(dir.join("service.db")).unwrap(), remote_before);
        assert_eq!(owner.runtime.config().port, 8451);
    }
    let blocked = cpa_server::testing::block_checkpoint_install(&owner.store);
    let output = online(&owner.base, MANAGEMENT_KEY);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("HTTP 500"));
    assert_eq!(std::fs::read(dir.join("local.db")).unwrap(), local_before);
    assert_eq!(std::fs::read(dir.join("service.db")).unwrap(), remote_before);
    assert_eq!(owner.runtime.config().port, 8451);
    drop(blocked);
    success(online(&owner.base, MANAGEMENT_KEY));
    assert_eq!(
        owner.runtime.config().port,
        8452,
        "the owner accepts work after storage is repaired"
    );
    assert_eq!(std::fs::read(dir.join("local.db")).unwrap(), local_before);
    owner.stop().await;
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn a_live_owner_allows_snapshot_reads_and_refuses_offline_logins() {
    let dir = scratch("owned-reads");
    let source = format!(
        "server:\n  port: 8460\naccess:\n  api-keys: [fake-owned-client-secret]\noauth: {{auth-dir: {}}}\n",
        dir.join("auth").display()
    );
    std::fs::write(dir.join("source.yaml"), source).unwrap();
    success(cli(&dir, &["--db", "service.db", "config", "import", "source.yaml"]));
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../cpa-exec/tests/fixtures/vertex_go.json")).unwrap();
    let case = fixture["import"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == "basic")
        .unwrap();
    std::fs::write(dir.join("account.json"), case["input"].as_str().unwrap()).unwrap();
    let (name, expected) = case["files"].as_object().unwrap().iter().next().unwrap();

    // An owner without any reachable management API still excludes offline writers.
    let silent = cpa_server::testing::config_store(&dir.join("service.db")).unwrap();
    let unowned = std::fs::read(dir.join("service.db")).unwrap();
    for args in [
        vec!["--db", "service.db", "--vertex-import", "account.json"],
        vec!["--db", "service.db", "config", "import", "source.yaml"],
    ] {
        let offline = cli(&dir, &args);
        assert!(
            !offline.status.success(),
            "{args:?} bypassed an owner whose API is unreachable"
        );
        assert!(String::from_utf8_lossy(&offline.stderr).contains("already owned"));
    }
    success(cli(&dir, &["--db", "service.db", "config", "export"]));
    assert_eq!(std::fs::read(dir.join("service.db")).unwrap(), unowned);
    drop(silent);

    let owner = OnlineOwner::start(&dir, &dir.join("service.db")).await;
    let published = std::fs::read(dir.join("service.db")).unwrap();

    // Reading the published single-file snapshot is not a competing mutation.
    let redacted = success(cli(&dir, &["--db", "service.db", "config", "export"]));
    assert!(redacted.contains("8460"));
    assert!(!redacted.contains("fake-owned-client-secret"));
    let full = success(cli(&dir, &["--db", "service.db", "config", "export", "--secrets"]));
    assert!(full.contains("fake-owned-client-secret"));
    success(cli(&dir, &["--db", "service.db", "config", "validate"]));
    success(cli(&dir, &["--db", "service.db", "config", "validate", "source.yaml"]));
    success(cli(
        &dir,
        &["--db", "service.db", "config", "backup", "owned-backup.db"],
    ));
    assert_eq!(std::fs::read(dir.join("service.db")).unwrap(), published);

    // Offline writes, including a local login/import, still require ownership.
    let offline = cli(&dir, &["--db", "service.db", "--vertex-import", "account.json"]);
    assert!(
        !offline.status.success(),
        "an offline login cannot bypass the live owner"
    );
    assert!(String::from_utf8_lossy(&offline.stderr).contains("already owned"));
    let offline = cli(&dir, &["--db", "service.db", "config", "import", "source.yaml"]);
    assert!(!offline.status.success());
    assert_eq!(std::fs::read(dir.join("service.db")).unwrap(), published);
    let db = owner.runtime.store().credential_backend();
    assert!(db.read(&db.auth_dir().join(name)).unwrap().is_none());
    drop(db);
    owner.stop().await;

    // The backup taken under the live owner restores alone.
    assert_eq!(
        success(cli(&dir, &["--db", "owned-backup.db", "config", "export", "--secrets"])),
        full
    );
    // Once the owner has stopped, the same offline login acquires ownership.
    let output = success(cli(&dir, &["--db", "service.db", "--vertex-import", "account.json"]));
    assert!(output.contains("Vertex credentials imported:"));
    let store = std::sync::Arc::new(cpa_server::testing::config_store(&dir.join("service.db")).unwrap());
    let restored = cpa_server::credential_store::CredentialDb::initialize(store.clone(), &dir.join("absent")).unwrap();
    assert_eq!(
        restored.read(&restored.auth_dir().join(name)).unwrap().unwrap(),
        expected.as_str().unwrap().as_bytes()
    );
    drop((restored, store));
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_cli_writers_publish_one_complete_latest_snapshot() {
    let dir = scratch("process-race");
    std::fs::write(
        dir.join("initial.yaml"),
        format!(
            "server:\n  port: 8500\noauth: {{auth-dir: {}}}\n",
            dir.join("auth").display()
        ),
    )
    .unwrap();
    success(cli(&dir, &["--db", "shared.db", "config", "import", "initial.yaml"]));
    let owner = OnlineOwner::start(&dir, &dir.join("shared.db")).await;
    let children: Vec<_> = (1..=4)
        .map(|writer| {
            let source = format!("writer-{writer}.yaml");
            std::fs::write(
                dir.join(&source),
                format!(
                    "server:\n  port: {}\noauth: {{auth-dir: {}}}\n",
                    8500 + writer,
                    dir.join("auth").display()
                ),
            )
            .unwrap();
            Command::new(env!("CARGO_BIN_EXE_cook-router"))
                .current_dir(&dir)
                .env_clear()
                .env("TMPDIR", dir.join("tmp"))
                .env("TMP", dir.join("tmp"))
                .env("TEMP", dir.join("tmp"))
                .args([
                    "--db",
                    "shared.db",
                    "--management-base-url",
                    &owner.base,
                    "--password",
                    MANAGEMENT_KEY,
                    "config",
                    "import",
                    &source,
                ])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .unwrap()
        })
        .collect();
    std::fs::copy(dir.join("shared.db"), dir.join("copy.db")).unwrap();
    success(cli(&dir, &["--db", "copy.db", "config", "validate"]));
    let mut accepted = 0;
    for child in children {
        let output = child.wait_with_output().unwrap();
        if output.status.success() {
            accepted += 1;
        } else {
            assert!(
                String::from_utf8_lossy(&output.stderr).contains("HTTP 412"),
                "only an explicit stale-revision conflict may refuse an import: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }
    assert!(accepted > 0);
    assert_eq!(owner.store.snapshot().unwrap().0, 1 + accepted);
    assert!((8501..=8504).contains(&owner.runtime.config().port));
    owner.stop().await;
    let exported = success(cli(&dir, &["--db", "shared.db", "config", "export"]));
    let exported: serde_json::Value = serde_json::from_str(&exported).unwrap();
    assert_eq!(exported["revision"], 1 + accepted);
    assert_eq!(&std::fs::read(dir.join("shared.db")).unwrap()[18..20], &[1, 1]);
    let temporary = dir.join("tmp/cook-router");
    assert!(!temporary.join("coordination.db").exists());
    assert!(
        !std::fs::read_dir(&temporary)
            .unwrap()
            .any(|entry| entry.unwrap().file_type().unwrap().is_dir())
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn database_flag_overrides_environment_and_environment_overrides_default() {
    let dir = scratch("environment");
    std::fs::write(dir.join("source.yaml"), "server:\n  port: 8345\n").unwrap();
    for args in [
        vec!["config", "import", "source.yaml"],
        vec!["--db", "flag.db", "config", "import", "source.yaml"],
    ] {
        success(
            Command::new(env!("CARGO_BIN_EXE_cook-router"))
                .current_dir(&dir)
                .env_clear()
                .env("TMPDIR", dir.join("tmp"))
                .env("TMP", dir.join("tmp"))
                .env("TEMP", dir.join("tmp"))
                .env("COOK_DB", "environment.db")
                .args(args)
                .output()
                .unwrap(),
        );
    }
    assert!(dir.join("environment.db").is_file());
    assert!(dir.join("flag.db").is_file());
    assert!(!dir.join("cook.db").exists());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn listener_reports_committed_defaults_and_tls_without_secrets_or_yaml_reads() {
    let dir = scratch("listener");
    for (source, expected) in [
        ("{}\n", "\n0\nfalse\n"),
        (
            "server:\n  host: '::1'\n  port: 8443\n  tls: {enable: true, cert: fake-cert.pem, key: fake-private-key.pem}\naccess:\n  api-keys: [fake-client-secret]\n",
            "::1\n8443\ntrue\n",
        ),
    ] {
        std::fs::write(dir.join("source.yaml"), source).unwrap();
        success(cli(&dir, &["--db", "chosen.db", "config", "import", "source.yaml"]));
        std::fs::remove_file(dir.join("source.yaml")).unwrap();
        assert_eq!(
            success(cli(&dir, &["--db", "chosen.db", "config", "listener"])),
            expected
        );
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn read_commands_refuse_other_schema_versions_and_leave_them_unchanged() {
    let dir = scratch("other-schema");
    std::fs::write(dir.join("source.yaml"), "server:\n  host: 127.0.0.1\n  port: 8345\n").unwrap();
    success(cli(&dir, &["--db", "chosen.db", "config", "import", "source.yaml"]));
    let path = dir.join("chosen.db");
    let mut database = std::fs::read(&path).unwrap();
    for version in [1u32, 3, u32::MAX] {
        // SQLite's user_version is a big-endian u32 in the database header.
        database[60..64].copy_from_slice(&version.to_be_bytes());
        std::fs::write(&path, &database).unwrap();
        for args in [
            vec!["config", "listener"],
            vec!["config", "export"],
            vec!["config", "validate"],
            vec!["config", "backup", "backup.db"],
        ] {
            let mut command = vec!["--db", "chosen.db"];
            command.extend(&args);
            let output = cli(&dir, &command);
            assert!(!output.status.success(), "{version} {args:?}");
            let stderr = String::from_utf8_lossy(&output.stderr);
            assert!(stderr.contains("not supported"), "{version} {args:?}: {stderr}");
            assert_eq!(std::fs::read(&path).unwrap(), database, "{version} {args:?}");
        }
    }
    assert!(!dir.join("backup.db").exists());
    std::fs::remove_dir_all(dir).unwrap();
}
