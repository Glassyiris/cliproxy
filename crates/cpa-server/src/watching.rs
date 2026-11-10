//! Reloads committed SQLite configuration and credentials, plus plugin auth changes.
//!
//! One task checks the config store's `data_version` every second. Management writes
//! publish configuration when they commit; commits from another connection wake the
//! credential reload through `Management::reload_config`. Plugin auth changes and
//! credential notifications wake the same task without polling working files.
//!
//! Credential working files are caches for provider/plugin APIs that require paths.
//! They are restored and written under the database's write lock; hand edits are not
//! supported or observed. Scans read SQLite source documents. Plugin parsing runs
//! outside management/runtime locks, then publication under `Management::disk` keeps
//! incomplete documents and rejects scans made stale by a concurrent credential save.
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, PoisonError};
use std::time::Duration;

use cpa_core::config::credentials;
use cpa_core::credential::{Credential, Source};

use crate::management::Management;

const CONFIG_POLL: Duration = Duration::from_secs(1);

pub fn start(state: &Arc<Management>) -> tokio::task::JoinHandle<()> {
    let plugin_auth = Arc::new(tokio::sync::Notify::new());
    credentials::on_plugin_auth_change(Some(Arc::new({
        let plugin_auth = plugin_auth.clone();
        move || plugin_auth.notify_one()
    })));
    let credential_changes = state.credential_changes.clone();
    let state = Arc::downgrade(state);
    // Load once at startup, including any plugin providers installed before the hook.
    plugin_auth.notify_one();
    tokio::spawn(async move {
        let mut poll = tokio::time::interval_at(tokio::time::Instant::now() + CONFIG_POLL, CONFIG_POLL);
        poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            let poll_config = tokio::select! {
                _ = poll.tick() => true,
                () = plugin_auth.notified() => false,
                () = credential_changes.notified() => false,
            };
            let Some(state) = state.upgrade() else { return };
            let plugin_auth = plugin_auth.clone();
            let reloaded = tokio::task::spawn_blocking(move || {
                if poll_config {
                    state.reload_config();
                } else if let Err(error) = reload_with_notify(&state, Some(&plugin_auth)) {
                    tracing::error!("failed to reload config: {error}");
                }
            })
            .await;
            if let Err(error) = reloaded {
                tracing::error!("config watcher: reload failed unexpectedly: {error}");
            }
        }
    })
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
    reload_with_notify(state, None)
}

fn reload_with_notify(state: &Management, plugin_auth: Option<&tokio::sync::Notify>) -> Result<(), ReloadError> {
    // Plugin callbacks may save credentials or wait on the async runtime. Never parse
    // while holding `disk` or the store's reconciliation gate.
    if !state.rt.store().is_home() && credentials::plugin_auth_parser_active() {
        let db = state.rt.store().credential_backend();
        if let Err(error) = db.preparse(&state.rt.config()) {
            tracing::error!("credential database: preparsing source documents failed: {error:#}");
        }
    }
    let _guard = state.disk.lock().unwrap_or_else(PoisonError::into_inner);
    let (mut config, error) = match state.stored_config() {
        Ok(config) => (config, None),
        Err(fault) => ((*state.rt.config()).clone(), Some(ReloadError(fault))),
    };
    state.lock_auth_dir(&mut config);
    let mut scan = state.scan_credentials(&config);
    keep_incomplete(state, &mut scan.credentials, &scan.incomplete);
    // A source can change between preparse and scan, including through a plugin's
    // own save callback. Retry via Notify even when no later database commit occurs.
    let retry = !scan.deferred.is_empty() || !scan.unapplied.is_empty();
    state.publish(config, Some(scan));
    if retry && let Some(plugin_auth) = plugin_auth {
        plugin_auth.notify_one();
    }
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

    fn state() -> (Arc<Management>, Arc<crate::credential_store::CredentialDb>, PathBuf) {
        let root = std::env::temp_dir().join(format!("cpa-watch-outcome-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let store = Arc::new(crate::config_store::ConfigStore::open(&root.join("cook.db")).unwrap());
        store.import_yaml("oauth: {}\n", "test", "").unwrap();
        let db = crate::credential_store::CredentialDb::initialize(store.clone(), &root.join("missing")).unwrap();
        let mut config = store.load().unwrap().config;
        config.auth_dir = db.auth_dir();
        let rt = Arc::new(crate::testing::runtime_with_db(
            config,
            Vec::new(),
            cpa_exec::Executors {
                claude: cpa_exec::claude::ClaudeExecutor::new("http://127.0.0.1:9").unwrap(),
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
    async fn database_watcher_parks_and_polls_credential_commits() {
        let (state, db, root) = state();
        let canonical = br#"{"type":"codex","email":"canonical@example.invalid"}"#;
        db.save(&db.auth_dir().join("a.json"), canonical).unwrap();
        db.save(&db.auth_dir().join("sub/nested.json"), canonical).unwrap();
        db.save(&root.join("external.json"), canonical).unwrap();
        let watcher = start(&state);
        tokio::time::timeout(Duration::from_secs(3), async {
            while state.rt.store().get("sub/nested.json").is_none() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("nested database document was not loaded");
        let parked = state.rt.config();
        tokio::time::sleep(CONFIG_POLL * 2).await;
        assert!(
            Arc::ptr_eq(&parked, &state.rt.config()),
            "an idle database republished config"
        );
        let external = crate::config_store::ConfigStore::open(&root.join("cook.db")).unwrap();
        let head = external.snapshot().unwrap().0;
        external
            .conn()
            .execute(
                "UPDATE credential_document SET bytes = ?1 WHERE name = 'local:sub/nested.json'",
                [br#"{"type":"codex","email":"external@example.invalid"}"#.as_slice()],
            )
            .unwrap();
        assert_eq!(
            external.snapshot().unwrap().0,
            head,
            "credentials do not create config revisions"
        );
        tokio::time::timeout(Duration::from_secs(4), async {
            while state
                .rt
                .store()
                .get("sub/nested.json")
                .is_none_or(|c| c.str("email") != Some("external@example.invalid"))
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("credential-only commit was not picked up by the database poll");
        assert_eq!(
            state.rt.store().get("a.json").unwrap().str("email"),
            Some("canonical@example.invalid")
        );
        assert!(
            Arc::ptr_eq(&parked, &state.rt.config()),
            "a credential commit republished config"
        );
        watcher.abort();
        let _ = watcher.await;
        drop(external);
        drop(state);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn credential_notification_reloads_same_connection_saves() {
        let (state, db, root) = state();
        let config = state.rt.config();
        let config_changes = state.rt.subscribe_config();
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
            !config_changes.has_changed().unwrap(),
            "a credential notification woke config subscribers"
        );
        watcher.abort();
        let _ = watcher.await;
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
    async fn a_second_store_connection_publishes_on_reload() {
        let (state, db, root) = state();
        let external = crate::config_store::ConfigStore::open(&root.join("cook.db")).unwrap();
        external
            .import_yaml("server: {port: 9002}\noauth: {}\n", "test", "")
            .unwrap();
        assert_ne!(state.rt.config().port, 9002);
        state.reload_config();
        assert_eq!(state.rt.config().port, 9002);
        drop(external);
        drop(state);
        drop(db);
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
        let mut patch = cpa_core::credential::MetadataPatch::default();
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
    async fn a_deferred_document_keeps_a_refresh_committed_before_publication() {
        use cpa_core::config::credentials::{ParseRequest, Parsed, ParsedAuth, PluginAuthParser};
        struct Acme;
        impl PluginAuthParser for Acme {
            fn parse_auths(&self, _: &ParseRequest<'_>) -> Parsed {
                Parsed::Handled(vec![ParsedAuth {
                    provider: "acme".into(),
                    id: "acme-a".into(),
                    metadata: serde_json::json!({"type": "acme", "token": "old"})
                        .as_object()
                        .cloned()
                        .unwrap(),
                    ..Default::default()
                }])
            }
        }
        credentials::with_thread_plugin_auth_parser(Arc::new(Acme), || {
            let (state, db, root) = state();
            let file = db.auth_dir().join("acme.json");
            db.save(&file, br#"{"type":"acme","v":1}"#).unwrap();
            reload(&state).unwrap();
            let store = state.rt.store().clone();
            assert_eq!(store.get("acme-a").unwrap().metadata["token"], "old");
            db.save(&file, br#"{"type":"acme","v":2}"#).unwrap();
            let config = (*state.rt.config()).clone();
            let scan = db.scan(&config).unwrap();
            assert!(scan.deferred.contains(&file));
            let refreshed = store.clone();
            crate::management::BEFORE_RECONCILE.lock().unwrap().push((
                config.auth_dir.clone(),
                Box::new(move || {
                    let current = refreshed.get("acme-a").unwrap();
                    let mut patch = cpa_core::credential::MetadataPatch::default();
                    patch.set.insert("token".into(), "refreshed".into());
                    refreshed.apply_patch("acme-a", current.revision, &patch).unwrap();
                }),
            ));
            state.publish(config, Some(scan));
            assert_eq!(store.get("acme-a").unwrap().metadata["token"], "refreshed");
            drop(state);
            drop(db);
            std::fs::remove_dir_all(root).unwrap();
        });
    }

    #[tokio::test]
    async fn a_plugin_bundle_publishes_only_once_parsed() {
        use cpa_core::config::credentials::{ParseRequest, Parsed, ParsedAuth, PluginAuthParser};
        struct Bundles;
        impl PluginAuthParser for Bundles {
            fn parse_auths(&self, req: &ParseRequest<'_>) -> Parsed {
                if req.file_name != "bundle.json" {
                    return Parsed::NotHandled;
                }
                let auth = |id: &str| ParsedAuth {
                    provider: "claude".into(),
                    id: id.into(),
                    metadata: serde_json::json!({"type": "claude", "access_token": id})
                        .as_object()
                        .cloned()
                        .unwrap(),
                    ..Default::default()
                };
                Parsed::Handled(vec![auth("claude-a"), auth("claude-b")])
            }
        }
        credentials::with_thread_plugin_auth_parser(Arc::new(Bundles), || {
            let (state, db, root) = state();
            let file = db.auth_dir().join("bundle.json");
            db.save(
                &file,
                br#"{"type":"claude","accounts":[{"access_token":"a"},{"access_token":"b"}]}"#,
            )
            .unwrap();
            let config = (*state.rt.config()).clone();
            let scan = db.scan(&config).unwrap();
            assert!(scan.deferred.contains(&file));
            state.publish(config, Some(scan));
            assert!(
                state.rt.store().snapshot().is_empty(),
                "published before plugin parsing"
            );
            reload(&state).unwrap();
            let mut ids: Vec<String> = state.rt.store().snapshot().iter().map(|c| c.id.clone()).collect();
            ids.sort();
            assert_eq!(ids, ["claude-a", "claude-b"]);
            drop(state);
            drop(db);
            std::fs::remove_dir_all(root).unwrap();
        });
    }

    #[tokio::test]
    async fn a_deferred_parse_notifies_the_reload_loop_to_retry() {
        use cpa_core::config::credentials::{ParseRequest, Parsed, ParsedAuth, PluginAuthParser};
        use std::sync::atomic::{AtomicBool, Ordering};
        struct SavingParser {
            db: Arc<crate::credential_store::CredentialDb>,
            saved: AtomicBool,
        }
        impl PluginAuthParser for SavingParser {
            fn parse_auths(&self, req: &ParseRequest<'_>) -> Parsed {
                if !self.saved.swap(true, Ordering::Relaxed) {
                    self.db.save(req.path, br#"{"type":"acme","token":"new"}"#).unwrap();
                }
                Parsed::Handled(vec![ParsedAuth {
                    provider: "acme".into(),
                    id: "acme-a".into(),
                    metadata: serde_json::from_slice::<serde_json::Map<String, serde_json::Value>>(req.raw_json)
                        .unwrap(),
                    ..Default::default()
                }])
            }
        }
        let (state, db, root) = state();
        db.save(&db.auth_dir().join("acme.json"), br#"{"type":"acme","token":"old"}"#)
            .unwrap();
        let parser = Arc::new(SavingParser {
            db: db.clone(),
            saved: AtomicBool::new(false),
        });
        credentials::with_thread_plugin_auth_parser(parser, || {
            let retry = tokio::sync::Notify::new();
            reload_with_notify(&state, Some(&retry)).unwrap();
            assert!(
                state.rt.store().snapshot().is_empty(),
                "the changed document must wait for a new parse"
            );
            let notified = retry.notified();
            tokio::pin!(notified);
            assert!(
                notified.as_mut().enable(),
                "a deferred scan did not notify the reload loop"
            );
            reload_with_notify(&state, Some(&retry)).unwrap();
            assert_eq!(state.rt.store().get("acme-a").unwrap().str("token"), Some("new"));
        });
        drop(state);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn a_committed_token_clears_its_401_block_and_keeps_a_429() {
        use crate::runtime::{Outcome, Selection};
        use cpa_core::exec::{ExecError, FailureScope};
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
        drop(state);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
