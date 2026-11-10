//! A plugin quota reset clears the credential's routing cooldowns and persists the
//! cleared state to SQLite, so a restart cannot restore the old cooldown.

#![cfg(unix)]

use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use cpa_exec::Executors;
use cpa_exec::claude::ClaudeExecutor;
use cpa_server::cooldown_store::{Backend, Quota, Record};
use cpa_server::management::{self, Management, Options};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn plugin_quota_reset_persists_cleared_cooldowns_to_the_backend() {
    let tmp = Path::new(env!("CARGO_TARGET_TMPDIR"));
    let test = "plugin_quota_cooldown::plugin_quota_reset_persists_cleared_cooldowns_to_the_backend";
    let Some(built) = cpa_plugin::testing::built_plugins(tmp, test) else {
        return;
    };
    let work = cpa_plugin::testing::scratch(tmp, "plugin-quota-cooldown");
    let (plugins, records, auths) = (work.join("plugins"), work.join("records"), work.join("auths"));
    for dir in [&plugins, &records.join("respond").join("a"), &auths] {
        std::fs::create_dir_all(dir).unwrap();
    }
    std::fs::copy(built.join("recorder.so"), plugins.join("recorder-a.so")).unwrap();
    std::fs::write(
        records.join("respond/a/quota.reset.json"),
        r#"{"ok":true,"result":{"success":true}}"#,
    )
    .unwrap();
    // A fake credential; nothing is sent anywhere.
    std::fs::write(
        auths.join("claude.json"),
        r#"{"type":"claude","email":"a@example.invalid","access_token":"fake-access"}"#,
    )
    .unwrap();
    let hash = bcrypt::hash("fake-secret", 4).unwrap();
    let store = Arc::new(cpa_server::config_store::ConfigStore::memory_with(&format!(
        "config-version: 8\noauth:\n  auth-dir: {auths}\nrouting:\n  cooldown:\n    save-cooldown-status: true\n\
         management:\n  secret-key: {hash}\nplugins:\n  enabled: true\n  dir: {plugins}\n  configs:\n    \
         recorder-a:\n      enabled: true\n      record: {records}\n      label: a\n      caps: quota_provider\n",
        auths = auths.display(),
        plugins = plugins.display(),
        records = records.display(),
    )));
    let config = store.load().unwrap().config;
    let credentials = cpa_core::config::credentials::load(&config);
    let rt = Arc::new(cpa_server::testing::runtime(
        config,
        credentials,
        Executors {
            claude: ClaudeExecutor::new("http://127.0.0.1:1").unwrap(),
            codex: Default::default(),
            devices: Default::default(),
            openai: Default::default(),
            google: Default::default(),
        },
    ));
    let credential = rt.store().get("claude.json").unwrap();
    let index = cpa_core::config::credentials::auth_index(&credential);
    rt.shutdown_codex_refreshes().await;
    let backend = rt.store().credential_backend();
    Backend::save(
        backend.as_ref(),
        vec![Record {
            provider: "claude".into(),
            auth_id: "claude.json".into(),
            status: "error".into(),
            next_retry_after: Some(SystemTime::now() + Duration::from_secs(3600)),
            reason: "quota".into(),
            quota: Quota {
                exceeded: true,
                ..Default::default()
            },
            ..Default::default()
        }],
        SystemTime::now(),
    )
    .unwrap();
    rt.set_cooldown_backend(backend.clone());
    assert!(
        !rt.store().cooldowns("claude.json").is_empty(),
        "the backend's cooldown was restored"
    );

    let state = Management::with_options(rt.clone(), store, Options::default());
    cpa_server::plugins::start(&rt).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app = management::router(state).layer(axum::middleware::from_fn(
        |mut req: axum::extract::Request, next: axum::middleware::Next| async move {
            let peer: SocketAddr = "127.0.0.1:40000".parse().unwrap();
            req.extensions_mut().insert(axum::extract::ConnectInfo(peer));
            next.run(req).await
        },
    ));
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let res = wreq::Client::new()
        .post(format!("{base}/v0/management/plugins/recorder-a/quota/reset"))
        .header("Authorization", "Bearer fake-secret")
        .body(format!(r#"{{"auth_index":"{index}"}}"#))
        .send()
        .await
        .unwrap();
    let status = res.status().as_u16();
    let body = res.text().await.unwrap();
    assert_eq!(status, 200, "{body}");
    assert!(
        rt.store().cooldowns("claude.json").is_empty(),
        "the reset cleared the cooldown"
    );
    rt.shutdown_codex_refreshes().await;
    assert!(
        Backend::load(backend.as_ref())
            .unwrap()
            .iter()
            .all(|r| r.auth_id != "claude.json"),
        "SQLite no longer holds the credential's cooldown"
    );
    rt.plugins().shutdown_all(None).await;
    let _ = std::fs::remove_dir_all(&work);
}
