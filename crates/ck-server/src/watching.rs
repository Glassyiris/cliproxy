//! Reconciles canonical credentials after explicit owner notifications.
//!
//! Configuration views arrive directly from accepted service commands. This task
//! has no timer, filesystem watcher or published-snapshot discovery path.
//!
//! Credential working files are caches for provider APIs that require paths. They are
//! restored and written under the database's write lock; hand edits are not supported
//! or observed. Scans read SQLite source documents; publication under
//! `Management::disk` keeps incomplete documents and rejects scans made stale by a
//! concurrent credential save.
use ck_core::credential::{Credential, Source};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, PoisonError};

use crate::management::Management;

/// Owns notification admission and its current blocking reconciliation.
pub struct Notifications {
    stop: tokio_util::sync::CancellationToken,
    task: Option<tokio::task::JoinHandle<()>>,
}
impl Notifications {
    pub fn cancellation_token(&self) -> tokio_util::sync::CancellationToken {
        self.stop.clone()
    }
    pub fn stop(&self) {
        self.stop.cancel();
    }
    pub async fn shutdown(mut self) -> Result<(), tokio::task::JoinError> {
        self.stop.cancel();
        self.task.take().expect("notification task already joined").await
    }
}
impl Drop for Notifications {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

pub fn start(state: &Arc<Management>) -> Notifications {
    let credential_changes = state.credential_changes.clone();
    let state = Arc::downgrade(state);
    let stop = tokio_util::sync::CancellationToken::new();
    let cancelled = stop.clone();
    let task = tokio::spawn(async move {
        // Load once at startup, then after every credential change notification.
        let mut first = true;
        loop {
            if !std::mem::take(&mut first) {
                tokio::select! {
                    biased;
                    () = cancelled.cancelled() => return,
                    () = credential_changes.notified() => {},
                };
            }
            if cancelled.is_cancelled() {
                return;
            }
            let Some(state) = state.upgrade() else { return };
            let reloaded = tokio::task::spawn_blocking(move || {
                if let Err(error) = reload(&state) {
                    tracing::error!("failed to reload config: {error}");
                }
            })
            .await;
            if let Err(error) = reloaded {
                tracing::error!("config watcher: reload failed unexpectedly: {error}");
            }
        }
    });
    Notifications { stop, task: Some(task) }
}

/// Why [`reload`] kept the last good config: the stored one does not compile.
#[derive(Debug)]
pub struct ReloadError(pub crate::config_store::Fault);

impl std::fmt::Display for ReloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl std::error::Error for ReloadError {}

/// Blocking reload of stored config and credential documents, shared with deterministic
/// tests. An invalid config keeps the last good config while credentials reconcile.
pub fn reload(state: &Management) -> Result<(), ReloadError> {
    let _guard = state.disk.lock().unwrap_or_else(PoisonError::into_inner);
    let (mut config, error) = match state.stored_config() {
        Ok(config) => (config, None),
        Err(fault) => ((*state.rt.config()).clone(), Some(ReloadError(fault))),
    };
    state.lock_auth_dir(&mut config);
    let mut scan = state.scan_credentials(&config);
    keep_incomplete(state, &mut scan.credentials, &scan.incomplete);
    state.publish(config, Some(scan));
    match error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

/// Keep the last good credentials for source documents this scan found incomplete.
/// Use the scan's own result: another save may have completed the document since.
fn keep_incomplete(state: &Management, files: &mut Vec<Credential>, incomplete: &HashSet<PathBuf>) {
    for existing in state.rt.store().snapshot() {
        if let Source::File(path) = &existing.source
            && incomplete.contains(path)
            && !files.iter().any(|c| c.id == existing.id)
        {
            files.push(Credential::clone(&existing));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn state() -> (Arc<Management>, Arc<crate::credential_store::CredentialDb>, PathBuf) {
        let root = std::env::temp_dir().join(format!("cpa-watch-outcome-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let store = Arc::new(crate::testing::config_store(&root.join("cook.db")).unwrap());
        store.import_yaml("oauth: {}\n", "test", "").unwrap();
        let db = crate::credential_store::CredentialDb::initialize(store.clone()).unwrap();
        let mut config = store.load().unwrap().config;
        config.auth_dir = db.auth_dir();
        let rt = Arc::new(crate::testing::runtime_with_db(
            config,
            Vec::new(),
            ck_exec::Executors {
                claude: ck_exec::claude::ClaudeExecutor::new("http://127.0.0.1:9").unwrap(),
                codex: Default::default(),
                devices: Default::default(),
                openai: Default::default(),
                google: Default::default(),
            },
            db.clone(),
        ));
        (Management::new(rt, store), db, root)
    }

    #[tokio::test]
    async fn shutdown_settles_in_flight_reload_before_workspace_cleanup() {
        use std::future::Future as _;
        use std::task::Poll;
        for _ in 0..20 {
            let (state, db, root) = state();
            let (entered, started) = tokio::sync::oneshot::channel();
            let (release, held) = std::sync::mpsc::channel();
            let (completed, finished) = tokio::sync::oneshot::channel();
            let settled = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let observed = settled.clone();
            let workspace = state.config.working_directory().unwrap().to_owned();
            assert!(workspace.is_dir());
            let marker = workspace.join("settled-reload");
            let written = marker.clone();
            crate::management::BEFORE_RECONCILE.lock().unwrap().push((
                state.rt.config().auth_dir.clone(),
                Box::new(move || {
                    entered.send(()).unwrap();
                    held.recv().unwrap();
                    std::fs::write(marker, b"completed before cleanup").unwrap();
                    observed.store(true, std::sync::atomic::Ordering::SeqCst);
                    completed.send(()).unwrap();
                }),
            ));
            let task = start(&state);
            started.await.unwrap();
            let mut shutdown = Box::pin(task.shutdown());
            let early = std::future::poll_fn(|cx| {
                Poll::Ready(match shutdown.as_mut().poll(cx) {
                    Poll::Ready(result) => {
                        result.unwrap();
                        true
                    }
                    Poll::Pending => false,
                })
            })
            .await;
            release.send(()).unwrap();
            finished.await.unwrap();
            if !early {
                shutdown.await.unwrap();
            }
            assert!(
                !early,
                "notification shutdown returned while its blocking reload still owned the workspace"
            );
            assert!(settled.load(std::sync::atomic::Ordering::SeqCst));
            assert_eq!(std::fs::read(written).unwrap(), b"completed before cleanup");
            drop(state);
            drop(db);
            assert!(
                !workspace.exists(),
                "the owner workspace is cleaned only after the reload settles"
            );
            std::fs::remove_dir_all(&root).unwrap();
            assert!(!root.exists());
        }
    }

    #[tokio::test]
    async fn worker_threads_changes_report_restart_required() {
        let (state, db, root) = state();
        let (_, restart) = state
            .commit_with(|store| {
                store.import_yaml("worker-threads: 4\noauth: {}\n", "test", "change startup worker count")
            })
            .unwrap();
        assert_eq!(restart, std::env::var_os("TOKIO_WORKER_THREADS").is_none());
        let (_, restart) = state
            .commit_with(|store| store.import_yaml("oauth: {}\n", "test", "restore startup worker count"))
            .unwrap();
        assert!(!restart, "restoring the startup worker setting needs no restart");
        drop(state);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn database_watcher_keeps_owner_state_after_external_snapshot_replacement() {
        let (state, db, root) = state();
        // Go `authIDForPath`: the credential ID uses the platform separator.
        let nested = std::path::Path::new("sub").join("nested.json");
        let nested = nested.to_string_lossy();
        let hash = bcrypt::hash("watcher-test-key", 4).unwrap();
        state
            .commit_with(|store| {
                store.import_yaml(
                    &format!("management: {{secret-key: '{hash}'}}\noauth: {{}}\n"),
                    "test",
                    "enable private management fixture",
                )
            })
            .unwrap();
        let canonical = br#"{"type":"codex","email":"canonical@example.invalid"}"#;
        db.save(&db.auth_dir().join("a.json"), canonical).unwrap();
        db.save(&db.auth_dir().join("sub/nested.json"), canonical).unwrap();
        db.save(&root.join("external.json"), canonical).unwrap();
        let watcher = start(&state);
        tokio::time::timeout(Duration::from_secs(3), async {
            while state.rt.store().get(&nested).is_none() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("nested database document was not loaded");
        let mut config_changes = state.rt.subscribe_config();
        let head = state.config_store().snapshot().unwrap().0;

        // Construct an independent artifact; replacing the published file is not
        // an online command and cannot import either changed or additional rows.
        let external = Arc::new(crate::testing::config_store(&root.join("incoming.db")).unwrap());
        let external_db = crate::credential_store::CredentialDb::initialize(external.clone()).unwrap();
        external_db
            .save(
                &external_db.auth_dir().join("sub/nested.json"),
                br#"{"type":"codex","email":"out-of-band@example.invalid"}"#,
            )
            .unwrap();
        external_db
            .save(&external_db.auth_dir().join("unadmitted.json"), canonical)
            .unwrap();
        std::fs::copy(external.path().unwrap(), root.join("replacement.db")).unwrap();
        std::fs::rename(root.join("replacement.db"), root.join("cook.db")).unwrap();
        reload(&state).unwrap();
        assert_eq!(
            state.rt.store().get(&nested).unwrap().str("email"),
            Some("canonical@example.invalid")
        );
        assert!(state.rt.store().get("unadmitted.json").is_none());
        assert_eq!(
            db.read(&db.auth_dir().join("sub/nested.json")).unwrap().as_deref(),
            Some(canonical.as_slice())
        );

        // A supported authenticated command still updates the running owner.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let app = crate::management::router(state.clone());
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
        let response = client
            .post(format!("{base}/v8/management/credentials?name=a.json"))
            .bearer_auth("watcher-test-key")
            .json(&serde_json::json!({"type": "claude", "email": "owner@example.invalid"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(
            state.rt.store().get("a.json").unwrap().str("email"),
            Some("owner@example.invalid")
        );
        assert_eq!(
            state.rt.store().get(&nested).unwrap().str("email"),
            Some("canonical@example.invalid")
        );
        assert!(state.rt.store().get("unadmitted.json").is_none());
        assert_eq!(
            state.config_store().snapshot().unwrap().0,
            head,
            "credentials do not create config revisions"
        );
        assert!(
            config_changes.try_next().is_none(),
            "credential changes must not notify config subscribers"
        );

        // The subsequent legitimate command must not smuggle bypass rows into
        // the portable artifact. Cold-load only its ordinary single-file copy.
        let copy = root.join("cold.db");
        std::fs::copy(root.join("cook.db"), &copy).unwrap();
        let recovered_store = Arc::new(crate::testing::config_store(&copy).unwrap());
        let recovered = crate::credential_store::CredentialDb::initialize(recovered_store.clone()).unwrap();
        assert_eq!(
            recovered
                .read(&recovered.auth_dir().join("sub/nested.json"))
                .unwrap()
                .as_deref(),
            Some(canonical.as_slice())
        );
        assert!(
            recovered
                .read(&recovered.auth_dir().join("unadmitted.json"))
                .unwrap()
                .is_none()
        );
        watcher.shutdown().await.unwrap();
        server.abort();
        let _ = server.await;
        drop((recovered, recovered_store, external_db, external, state, db));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn credential_notification_reloads_same_connection_saves() {
        let (state, db, root) = state();
        let config = state.rt.config();
        let mut config_changes = state.rt.subscribe_config();
        let watcher = start(&state);
        db.save(
            &db.auth_dir().join("a.json"),
            br#"{"type":"codex","email":"a@example.invalid"}"#,
        )
        .unwrap();
        state.credential_changes.notify_one();
        tokio::time::timeout(Duration::from_secs(3), async {
            while state.rt.store().get("a.json").is_none() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(
            Arc::ptr_eq(&config, &state.rt.config()),
            "a credential notification republished config"
        );
        assert!(
            config_changes.try_next().is_none(),
            "a credential notification woke config subscribers"
        );
        watcher.shutdown().await.unwrap();
        drop(state);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn database_upload_fallback_uses_committed_bytes_without_a_working_file() {
        let (state, db, root) = state();
        let path = db.auth_dir().join("fallback.json");
        let canonical = br#"{"type":"gemini","v":"committed"}"#;
        db.save(&path, canonical).unwrap();
        state.fallbacks.lock().unwrap().insert(path.clone());
        std::fs::remove_file(&path).unwrap();
        state.publish((*state.rt.config()).clone(), None);
        assert_eq!(
            state.rt.store().get("fallback.json").unwrap().metadata["v"],
            "committed"
        );
        assert!(state.fallbacks.lock().unwrap().contains(&path));
        assert_eq!(db.read(&path).unwrap().unwrap(), canonical);
        drop(state);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn a_replaced_snapshot_does_not_publish_on_reload() {
        let (state, db, root) = state();
        let hash = bcrypt::hash("reload-test-key", 4).unwrap();
        state
            .commit_with(|store| {
                store.import_yaml(
                    &format!("management: {{secret-key: '{hash}'}}\noauth: {{}}\n"),
                    "test",
                    "enable private management fixture",
                )
            })
            .unwrap();
        let original = state.rt.config().port;
        let external = crate::testing::config_store(&root.join("incoming.db")).unwrap();
        external
            .import_yaml("server: {port: 9002}\noauth: {}\n", "test", "")
            .unwrap();
        std::fs::copy(external.path().unwrap(), root.join("replacement.db")).unwrap();
        std::fs::rename(root.join("replacement.db"), root.join("cook.db")).unwrap();
        reload(&state).unwrap();
        assert_eq!(state.rt.config().port, original);
        assert_eq!(state.config_store().load().unwrap().config.port, original);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let app = crate::management::router(state.clone());
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .unwrap();
        });
        let response = wreq::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap()
            .put(format!("{base}/admin/v1/r/setting/server"))
            .bearer_auth("reload-test-key")
            .json(&serde_json::json!({"spec": {"port": 9003}}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(state.rt.config().port, 9003);
        assert_eq!(state.config_store().load().unwrap().config.port, 9003);
        server.abort();
        let _ = server.await;
        drop((external, state, db));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn incomplete_documents_keep_the_credential_until_valid_json() {
        let (state, db, root) = state();
        let file = db.auth_dir().join("a.json");
        let loaded = || state.rt.store().get("a.json").is_some();
        for (contents, kept) in [
            ("", true),
            (r#"{"type":"codex""#, true),
            (" \n", true),
            ("null", false),
            ("{}", false),
        ] {
            db.save(&file, br#"{"type":"codex","email":"a@example.com"}"#).unwrap();
            reload(&state).unwrap();
            db.save(&file, contents.as_bytes()).unwrap();
            reload(&state).unwrap();
            assert_eq!(loaded(), kept, "{contents:?}");
        }
        db.save(&file, br#"{"type":"codex"}"#).unwrap();
        reload(&state).unwrap();
        db.delete(&file).unwrap();
        reload(&state).unwrap();
        assert!(!loaded());
        drop(state);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn a_document_completed_after_the_scan_keeps_its_credential() {
        let (state, db, root) = state();
        let file = db.auth_dir().join("a.json");
        let good = br#"{"type":"codex","email":"a@example.com"}"#;
        db.save(&file, good).unwrap();
        reload(&state).unwrap();
        db.save(&file, br#"{"type":"codex""#).unwrap();
        let scan = db.scan(&state.rt.config()).unwrap();
        let mut files = scan.credentials;
        assert!(scan.incomplete.contains(&file) && files.is_empty());
        db.save(&file, good).unwrap();
        keep_incomplete(&state, &mut files, &scan.incomplete);
        assert_eq!(files.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["a.json"]);
        drop(state);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn a_reload_scan_does_not_undo_a_refresh_committed_after_it() {
        let (state, db, root) = state();
        db.save(
            &db.auth_dir().join("a.json"),
            br#"{"type":"codex","access_token":"old"}"#,
        )
        .unwrap();
        reload(&state).unwrap();
        let config = (*state.rt.config()).clone();
        let scan = db.scan(&config).unwrap();
        let store = state.rt.store();
        let revision = store.get("a.json").unwrap().revision;
        let mut patch = ck_core::credential::MetadataPatch::default();
        patch.set.insert("access_token".into(), "refreshed".into());
        store.apply_patch("a.json", revision, &patch).unwrap();
        state.publish(config, Some(scan));
        assert_eq!(store.get("a.json").unwrap().metadata["access_token"], "refreshed");
        reload(&state).unwrap();
        assert_eq!(store.get("a.json").unwrap().metadata["access_token"], "refreshed");
        drop(state);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn a_committed_token_clears_its_401_block_and_keeps_a_429() {
        use crate::runtime::{Outcome, Selection};
        use ck_core::exec::{ExecError, FailureScope};
        let (state, db, root) = state();
        let file = db.auth_dir().join("claude-a.json");
        let doc = |token: &str, email: &str| {
            serde_json::to_vec(&serde_json::json!({"type": "claude", "access_token": token,
                "refresh_token": "fake-rt", "email": email}))
            .unwrap()
        };
        db.save(&file, &doc("sk-ant-oat-old-fake", "a@example.invalid"))
            .unwrap();
        reload(&state).unwrap();
        let store = state.rt.store();
        let select = |model: &str| store.select(Selection::new("claude", model));
        let mut quota = ExecError::local(429, FailureScope::Model, "rate limited");
        quota.retry_after = Some(Duration::from_secs(3600));
        select("q").unwrap().complete(Outcome::Failure(quota));
        let unauthorized = ExecError::local(
            401,
            FailureScope::Credential,
            "authentication_error: OAuth access token",
        );
        select("m").unwrap().complete(Outcome::Failure(unauthorized));
        assert!(select("m").is_none(), "the 401 blocks the credential");
        db.save(&file, &doc("sk-ant-oat-old-fake", "b@example.invalid"))
            .unwrap();
        reload(&state).unwrap();
        assert!(select("m").is_none(), "keeping the tokens keeps the block");
        db.save(&file, &doc("sk-ant-oat-new-fake", "c@example.invalid"))
            .unwrap();
        reload(&state).unwrap();
        let lease = select("m").expect("the new token is selectable at once");
        assert_eq!(lease.credential.str("access_token"), Some("sk-ant-oat-new-fake"));
        drop(lease);
        assert!(select("q").is_none(), "the 429 cooldown survives the reload");
        let left = store.cooldowns("claude-a.json");
        assert_eq!(
            left.iter().map(|c| (c.model.as_str(), c.status)).collect::<Vec<_>>(),
            [("q", 429)]
        );
        // Settle owned outcome persistence and cooldown writes before releasing
        // the runtime/store and deleting their private fixture directory.
        state.rt.shutdown_codex_refreshes().await;
        drop(state);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
