//! The plugin host's auth manager (Go `pluginHost.SetAuthManager(authManager)` in
//! internal/api/server.go): `host.auth.*` read the credential store, saves go through
//! the auth-file pipeline uploads use, and `host.affinity.lookup` answers
//! `unsupported` (Go `Manager.LookupSessionAffinity`).
//!
//! ponytail: Go's raw `Auth.Status` is approximated from the store as the auth-files
//! view does: `disabled`, `error` while a credential-wide cooldown runs, else
//! `active`; created and updated times are the file's modification time.
//! ponytail: an overwrite that changes a credential's type gets that type's auth
//! index at once; Go's `Update` keeps the old index until the next restart.

use std::collections::BTreeMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, PoisonError, Weak};
use std::time::SystemTime;

use cpa_core::config::credentials;
use cpa_core::credential::Credential;
use cpa_plugin::gojson::GoTime;
use cpa_plugin::hostauth::{AuthManager, HostAuth, SavedAuths, SavedRefresh};
use serde_json::Value;

use super::Management;
use super::auth_files::{file_name, parse_time, path_of, recent_requests, status_message};

/// Gives the runtime's plugin host this management state as its auth manager.
pub(crate) fn attach(state: &Arc<Management>) {
    state
        .rt
        .plugins()
        .set_auth_manager(Some(Arc::new(PluginAuthManager(Arc::downgrade(state)))));
}

/// Held weakly: the runtime owns the plugin host, and management owns the runtime.
struct PluginAuthManager(Weak<Management>);

impl AuthManager for PluginAuthManager {
    fn list(&self) -> Vec<HostAuth> {
        let Some(state) = self.0.upgrade() else {
            return Vec::new();
        };
        state
            .rt
            .store()
            .snapshot()
            .iter()
            .map(|c| host_auth(&state, c))
            .collect()
    }

    fn get_by_id(&self, id: &str) -> Option<HostAuth> {
        let state = self.0.upgrade()?;
        state.rt.store().get(id).map(|c| host_auth(&state, &c))
    }
    fn read_file(&self, path: &Path) -> std::io::Result<Vec<u8>> {
        let state = self
            .0
            .upgrade()
            .ok_or_else(|| std::io::Error::other("auth manager unavailable"))?;
        if state.rt.store().is_home() {
            return Err(std::io::Error::other("credential reads unavailable in Home mode"));
        }
        super::auth_files::read_file(&state, path)
    }

    /// Under the disk lock (the auth-file writes and reloads lock): the host writes the
    /// file, the file store rewrites it in its canonical form, and the file's
    /// credentials are registered or replaced alone, keeping their runtime state by ID;
    /// the file's other credentials go. Nothing else is reloaded and the config is not
    /// republished.
    fn save(&self, auths: SavedAuths, write: &mut dyn FnMut() -> Result<(), String>) -> Result<(), String> {
        let state = self.0.upgrade().ok_or("auth manager unavailable")?;
        if state.rt.store().is_home() {
            return Err("credential saves unavailable in Home mode".into());
        }
        let _disk = state.disk.lock().unwrap_or_else(PoisonError::into_inner);
        let path = match &auths {
            SavedAuths::BuiltIn(auth) => PathBuf::from(auth.attributes.get("path").cloned().unwrap_or_default()),
            SavedAuths::Plugin { path, .. } | SavedAuths::Written { path, .. } => path.clone(),
        };
        let backend = state.rt.store().credential_backend();
        let apply = || {
            write()?;
            match auths {
                SavedAuths::Written { data, .. } => Ok((data, None)),
                SavedAuths::BuiltIn(auth) => {
                    let bytes = persist(&path, &auth.metadata, auth.disabled)?;
                    let cfg = state.rt.config();
                    let (mut credential, fallback) = match credentials::from_file(&cfg, &cfg.auth_dir, &path, &bytes) {
                        Ok(Some(c)) => (c, false),
                        // Go registers what its synthesizer would skip; uploads keep such
                        // files the same way (see `credentials::upload_fallback`).
                        Ok(None) => match credentials::upload_fallback(&cfg.auth_dir, &path, &bytes) {
                            Some(c) => (c, true),
                            None => return Ok((bytes, None)),
                        },
                        Err(e) => return Err(format!("register auth: {e}")),
                    };
                    // Keep the existing credential's ID and refresh state.
                    if !auth.id.is_empty() {
                        credential.id = auth.id.clone();
                    }
                    let refresh = vec![SavedRefresh {
                        id: credential.id.clone(),
                        donor: Some(credential.id.clone()),
                    }];
                    Ok((bytes, Some((vec![credential], refresh, fallback))))
                }
                SavedAuths::Plugin {
                    mut credentials,
                    persist: rewrite,
                    refresh,
                    ..
                } => {
                    // A virtual/multiple-auth document retains its raw plugin bytes.
                    let bytes = match (rewrite, credentials.as_mut_slice()) {
                        (true, [one]) => {
                            one.metadata.insert("disabled".into(), one.disabled.into());
                            persist(&path, &one.metadata, one.disabled)?
                        }
                        _ => std::fs::read(&path).map_err(|e| format!("auth filestore: read existing failed: {e}"))?,
                    };
                    Ok((bytes, Some((credentials, refresh, false))))
                }
            }
        };
        let (bytes, publication) = backend
            .write_files(std::slice::from_ref(&path), || apply().map_err(anyhow::Error::msg))
            .map_err(|e| format!("persist auth: {e}"))?;
        // Nested Written saves must be durable before making their parse observable.
        credentials::note_plugin_auth_write(&path, &bytes);
        if let Some((credentials, refresh, fallback)) = publication {
            let mut fallbacks = state.fallbacks.lock().unwrap_or_else(PoisonError::into_inner);
            if fallback {
                fallbacks.insert(path.clone());
            } else {
                fallbacks.remove(&path);
            }
            drop(fallbacks);
            state.rt.store().upsert_file(Some(&path), credentials, &refresh);
        }
        state.credential_changes.notify_one();
        Ok(())
    }

    /// Go `LookupSessionAffinity`: `unsupported` whenever a plugin scheduler is
    /// attached, and Go's server always attaches the plugin host
    /// (sdk/cliproxy/builder.go:240-246, :272-273; conductor_selection.go:471-474).
    fn lookup_session_affinity(&self, _: &str, _: &str, _: &str) -> (String, Option<HostAuth>) {
        ("unsupported".into(), None)
    }
}

/// Go `FileTokenStore.Save` for a saved auth: the metadata with the auth's `disabled`
/// flag, marshalled, replacing the file unless it already holds the same JSON.
/// Returns what the file holds.
fn persist(path: &Path, metadata: &serde_json::Map<String, Value>, disabled: bool) -> Result<Vec<u8>, String> {
    let mut meta: BTreeMap<String, Value> = metadata.clone().into_iter().collect();
    meta.insert("disabled".into(), disabled.into());
    let raw = cpa_plugin::gojson::to_vec(&meta);
    let existing = std::fs::read(path).map_err(|e| format!("auth filestore: read existing failed: {e}"))?;
    if json_equal(&existing, &raw) {
        return Ok(existing);
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(path)
        .map_err(|e| format!("auth filestore: open existing failed: {e}"))?;
    file.write_all(&raw)
        .map_err(|e| format!("auth filestore: write existing failed: {e}"))?;
    Ok(raw)
}

/// Go `jsonEqual`: both decode, and the decoded values are equal (numbers as float64).
fn json_equal(a: &[u8], b: &[u8]) -> bool {
    fn same(a: &Value, b: &Value) -> bool {
        match (a, b) {
            (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
            (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(x, y)| same(x, y)),
            (Value::Object(x), Value::Object(y)) => {
                x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
            }
            _ => a == b,
        }
    }
    match (serde_json::from_slice::<Value>(a), serde_json::from_slice::<Value>(b)) {
        (Ok(a), Ok(b)) => same(&a, &b),
        _ => false,
    }
}

fn go_time(t: Option<SystemTime>) -> GoTime {
    GoTime(t.map(|t| chrono::DateTime::<chrono::Local>::from(t).fixed_offset()))
}

/// A stored credential as Go's `coreauth.Auth` presents it to the plugin host.
fn host_auth(state: &Management, c: &Credential) -> HostAuth {
    let store = state.rt.store();
    let cooldown = store
        .cooldowns(&c.id)
        .into_iter()
        .find(|cd| cd.model.is_empty() && !cd.remaining.is_zero());
    let (status, unavailable) = if c.disabled {
        ("disabled", false)
    } else if cooldown.is_some() {
        ("error", true)
    } else {
        ("active", false)
    };
    let mut attributes = c.attributes.clone();
    let path = path_of(c);
    if let Some(path) = path {
        let path = std::path::absolute(path).unwrap_or_else(|_| path.to_owned());
        let path = path.display().to_string();
        attributes.entry("path".into()).or_insert_with(|| path.clone());
        attributes.entry("source".into()).or_insert(path);
    }
    let activity = store.activity(&c.id);
    let recent = match recent_requests(&activity) {
        Value::Array(buckets) => buckets
            .iter()
            .map(|b| {
                (
                    b["time"].as_str().unwrap_or_default().to_owned(),
                    b["success"].as_i64().unwrap_or_default(),
                    b["failed"].as_i64().unwrap_or_default(),
                )
            })
            .collect(),
        _ => Vec::new(),
    };
    let modified = path
        .and_then(|p| std::fs::metadata(p).ok())
        .and_then(|m| m.modified().ok());
    let last_refresh = ["last_refresh", "lastRefresh", "last_refreshed_at", "lastRefreshedAt"]
        .iter()
        .find_map(|key| c.metadata.get(*key).and_then(parse_time));
    let (account_type, account) = cpa_core::registry::dynamic::account_info(c);
    HostAuth {
        id: c.id.clone(),
        index: credentials::auth_index(c),
        provider: c.provider.clone(),
        file_name: file_name(c).unwrap_or_default(),
        label: c.label.clone(),
        status: status.into(),
        status_message: status_message(state, c).into(),
        disabled: c.disabled,
        unavailable,
        attributes,
        metadata: c.metadata.clone(),
        success: activity.success as i64,
        failed: activity.failed as i64,
        recent_requests: recent,
        created_at: go_time(modified),
        updated_at: go_time(modified),
        last_refreshed_at: go_time(last_refresh),
        next_retry_after: go_time(cooldown.map(|cd| SystemTime::now() + cd.remaining)),
        account_type: account_type.into(),
        account,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::time::Duration;

    use super::*;

    #[test]
    fn home_mode_rejects_credential_saves_before_writing() {
        let work = cpa_plugin::testing::scratch(&std::env::temp_dir(), "plugin-home-save");
        let store = Arc::new(crate::config_store::ConfigStore::memory_with(&format!(
            "oauth: {{auth-dir: {}}}\n",
            work.display()
        )));
        let rt = Arc::new(crate::Runtime::home(
            store.load().unwrap().config,
            Vec::new(),
            cpa_exec::Executors {
                claude: cpa_exec::claude::ClaudeExecutor::new("http://127.0.0.1:9").unwrap(),
                codex: Default::default(),
                devices: Default::default(),
                openai: Default::default(),
                google: Default::default(),
            },
        ));
        rt.deny_external.store(true, std::sync::atomic::Ordering::Relaxed);
        let state = Management::new(rt, store);
        let manager = PluginAuthManager(Arc::downgrade(&state));
        let path = work.join("saved.json");
        let result = manager.save(
            SavedAuths::Written {
                path: path.clone(),
                data: b"{}".to_vec(),
            },
            &mut || panic!("Home mode must reject before invoking the credential writer"),
        );
        assert_eq!(result.unwrap_err(), "credential saves unavailable in Home mode");
        assert!(!path.exists());
        assert!(state.rt.store().snapshot().is_empty());
        drop(state);
        std::fs::remove_dir_all(work).unwrap();
    }

    #[test]
    fn written_saves_are_durable_and_sql_failures_do_not_publish() {
        let work = cpa_plugin::testing::scratch(&std::env::temp_dir(), "plugin-written-sqlite");
        let store = Arc::new(crate::config_store::ConfigStore::open(&work.join("config.db")).unwrap());
        let db = crate::credential_store::CredentialDb::initialize(store.clone(), &work.join("legacy")).unwrap();
        let mut cfg = store.load().unwrap().config;
        cfg.auth_dir = db.auth_dir();
        let rt = Arc::new(crate::testing::runtime_with_db(
            cfg,
            Vec::new(),
            cpa_exec::Executors {
                claude: cpa_exec::claude::ClaudeExecutor::new("http://127.0.0.1:1").unwrap(),
                codex: Default::default(),
                devices: Default::default(),
                openai: Default::default(),
                google: Default::default(),
            },
            db.clone(),
        ));
        let state = Management::new(rt, store);
        let manager = PluginAuthManager(Arc::downgrade(&state));
        let path = db.auth_dir().join("nested.json");
        let original = br#"{ "type":"rec", "plugin_unknown":[1,{"keep":true}] }"#;
        manager
            .save(
                SavedAuths::Written {
                    path: path.clone(),
                    data: original.to_vec(),
                },
                &mut || std::fs::write(&path, original).map_err(|e| e.to_string()),
            )
            .unwrap();
        assert_eq!(db.read(&path).unwrap().unwrap(), original);
        std::fs::remove_file(&path).unwrap();
        assert_eq!(manager.read_file(&path).unwrap(), original);
        rusqlite::Connection::open(work.join("config.db"))
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER reject_host_save BEFORE INSERT ON credential_document
                 BEGIN SELECT RAISE(ABORT, 'reject host save'); END;",
            )
            .unwrap();
        let replacement = br#"{"type":"claude","access_token":"new"}"#;
        let auth = HostAuth {
            attributes: [("path".into(), path.to_string_lossy().into_owned())].into(),
            metadata: serde_json::from_slice::<Value>(replacement)
                .unwrap()
                .as_object()
                .unwrap()
                .clone(),
            ..Default::default()
        };
        for auths in [
            SavedAuths::Written {
                path: path.clone(),
                data: replacement.to_vec(),
            },
            SavedAuths::BuiltIn(Box::new(auth)),
            SavedAuths::Plugin {
                path: path.clone(),
                credentials: Vec::new(),
                persist: false,
                refresh: Vec::new(),
            },
        ] {
            let result = manager.save(auths, &mut || {
                std::fs::write(&path, replacement).map_err(|e| e.to_string())
            });
            assert!(result.is_err());
            assert_eq!(db.read(&path).unwrap().unwrap(), original);
            assert_eq!(std::fs::read(&path).unwrap(), original);
            assert!(state.rt.store().snapshot().is_empty());
        }
        let reopened = crate::credential_store::CredentialDb::initialize(
            Arc::new(crate::config_store::ConfigStore::open(&work.join("config.db")).unwrap()),
            &work.join("legacy"),
        )
        .unwrap();
        assert_eq!(reopened.read(&path).unwrap().unwrap(), original);
        let _ = std::fs::remove_dir_all(work);
    }

    /// A plugin's `host.auth.save` writes and publishes under the disk lock, so it cannot
    /// interleave with a SIWC commit, which holds that lock from its read of the backing
    /// file to its publication: the save's write waits until the lock is released, and
    /// the file and the registered credential then agree.
    #[test]
    fn a_plugin_save_waits_for_a_commit_holding_the_disk_lock() {
        let dir = std::env::temp_dir().join(format!("cpa-plugin-save-lock-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = Arc::new(crate::config_store::ConfigStore::memory_with(&format!(
            "oauth: {{auth-dir: {}}}\n",
            dir.display()
        )));
        let cfg = store.load().unwrap().config;
        let rt = Arc::new(crate::testing::runtime(
            cfg,
            Vec::new(),
            cpa_exec::Executors {
                claude: cpa_exec::claude::ClaudeExecutor::new("http://127.0.0.1:9").unwrap(),
                codex: Default::default(),
                devices: Default::default(),
                openai: Default::default(),
                google: Default::default(),
            },
        ));
        let state = Management::new(rt, store);
        let manager = PluginAuthManager(Arc::downgrade(&state));
        let file = state.rt.config().auth_dir.join("saved.json");
        let auth = HostAuth {
            attributes: [("path".to_owned(), file.display().to_string())].into(),
            metadata: serde_json::json!({"type": "claude", "access_token": "saved"})
                .as_object()
                .cloned()
                .unwrap(),
            ..Default::default()
        };
        let commit = state.disk.lock().unwrap();
        let (wrote, written) = mpsc::channel();
        let save = std::thread::spawn({
            let file = file.clone();
            move || {
                manager.save(SavedAuths::BuiltIn(Box::new(auth)), &mut || {
                    wrote.send(()).unwrap();
                    std::fs::write(&file, r#"{"type":"claude","access_token":"saved"}"#).map_err(|e| e.to_string())
                })
            }
        });
        assert!(
            written.recv_timeout(Duration::from_millis(300)).is_err(),
            "the save wrote while a commit held the disk lock"
        );
        assert!(!file.exists());
        drop(commit);
        written.recv_timeout(Duration::from_secs(5)).unwrap();
        save.join().unwrap().unwrap();
        let on_disk: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        let stored = state.rt.store().get("saved.json").unwrap();
        assert_eq!(on_disk, Value::Object(stored.metadata.clone()));
        assert_eq!(stored.metadata["access_token"], "saved");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
