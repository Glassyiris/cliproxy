//! Plugin OAuth logins (internal/api/handlers/management/auth_files_oauth_callback.go
//! `ServePluginAuthURL`, the plugin branch of `GetAuthStatus` and
//! `savePluginLoginRecords`): a plugin auth provider starts a login for
//! `/v0/management/<provider>-auth-url` (through NoRoute) or
//! `/v8/management/oauth/auth-url?provider=<provider>`, the callback is written where
//! the plugin reads it, and polling the status saves the auths it returns.

use cpa_core::gostr::GoStr;
use std::path::Path;
use std::sync::Arc;

use axum::http::StatusCode;
use axum::response::Response;
use cpa_plugin::auth::PluginAuth;
use cpa_plugin::gojson::Metadata;
use serde_json::{Value, json};

use super::Management;
use super::plugins::{go_query, map_json};

/// Go `NormalizePluginOAuthCallbackProvider`: lowercase letters, digits and `-`.
pub(super) fn normalize_provider(provider: &str) -> Option<String> {
    let p = provider.trim().go_lower();
    (!p.is_empty()
        && p.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'))
    .then_some(p)
}

fn error(status: StatusCode, message: &str) -> Response {
    map_json(status, &json!({"error": message}))
}

/// Go `managementCallbackURL`.
fn callback_url(state: &Management, path: &str) -> Option<String> {
    let cfg = state.rt.config();
    if cfg.port == 0 {
        return None;
    }
    let tls = cfg
        .document
        .get("server")
        .and_then(|s| s.get("tls"))
        .and_then(|t| t.get("enable"))
        .and_then(serde_yaml_ng::Value::as_bool)
        .unwrap_or(false);
    Some(format!(
        "{}://127.0.0.1:{}{path}",
        if tls { "https" } else { "http" },
        cfg.port
    ))
}

/// Go `queryValuesToMetadata`: one value as a string, several as a list.
fn query_metadata(pairs: Vec<(String, String)>) -> Metadata {
    let mut grouped: Vec<(String, Vec<String>)> = Vec::new();
    for (k, v) in pairs {
        match grouped.iter_mut().find(|(key, _)| *key == k) {
            Some((_, values)) => values.push(v),
            None => grouped.push((k, vec![v])),
        }
    }
    grouped
        .into_iter()
        .map(|(k, mut v)| {
            let value = if v.len() == 1 {
                Value::String(v.remove(0))
            } else {
                json!(v)
            };
            (k, value)
        })
        .collect()
}

/// Go `ServePluginAuthURL`: `None` when no plugin auth provider handles the path
/// (`path` is the decoded request path).
pub(super) async fn serve_auth_url(state: &Arc<Management>, path: &str, raw_query: &str) -> Option<Response> {
    let mut query = go_query(raw_query);
    let v8 = path.trim() == "/v8/management/oauth/auth-url";
    let provider = if v8 {
        query
            .iter()
            .find(|(k, _)| k == "provider")
            .map(|(_, v)| v.clone())
            .unwrap_or_default()
    } else {
        let rest = path.trim().strip_prefix("/v0/management/")?;
        rest.strip_suffix("-auth-url")?.to_owned()
    };
    let provider = normalize_provider(&provider)?;
    let host = state.rt.plugins();
    if !host.has_auth_provider(&provider) {
        return None;
    }
    let callback_path = if v8 {
        query.retain(|(k, _)| k != "provider");
        "/v8/management/oauth/callback"
    } else {
        "/v0/management/oauth-callback"
    };
    let Some(base_url) = callback_url(state, callback_path) else {
        tracing::error!("failed to compute plugin auth callback URL: server port is not configured");
        return Some(error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "failed to generate authorization url",
        ));
    };
    let resp = match host
        .start_login(&provider, &base_url, query_metadata(query), &Default::default())
        .await
    {
        Ok(Some(resp)) => resp,
        Ok(None) => return None,
        Err(e) => {
            tracing::error!(error = %e, "failed to start plugin auth login");
            return Some(error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed to generate authorization url",
            ));
        }
    };
    let sid = resp.state.trim();
    if sid.is_empty() || !super::oauth::valid_state(sid) {
        tracing::error!(provider = %provider, "plugin auth provider returned an empty or invalid state");
        return Some(error(StatusCode::BAD_GATEWAY, "invalid oauth state"));
    }
    if !state.oauth.register_plugin(sid, &provider, resp.metadata.clone()) {
        tracing::error!(provider = %provider, "failed to register plugin oauth session");
        return Some(error(StatusCode::BAD_GATEWAY, "failed to generate authorization url"));
    }
    Some(map_json(
        StatusCode::OK,
        &json!({"status": "ok", "url": resp.url, "state": sid}),
    ))
}

/// The plugin branch of Go `GetAuthStatus`: polls the plugin, saving the auths a
/// successful login returns. `None` when the plugin does not handle the poll.
pub(super) async fn poll(state: &Arc<Management>, sid: &str, provider: &str, metadata: Metadata) -> Option<Response> {
    let host = state.rt.plugins();
    let status = |s: &str| map_json(StatusCode::OK, &json!({"status": s}));
    let failed = |message: &str| {
        state.oauth.set_error(sid, message);
        map_json(StatusCode::OK, &json!({"status": "error", "error": message}))
    };
    let resp = match host.poll_login(provider, sid, metadata, &Default::default()).await {
        Ok(Some(resp)) => resp,
        Ok(None) => return None,
        Err(e) => {
            let message = match e.to_string().trim() {
                "" => "Authentication failed".to_owned(),
                m => m.to_owned(),
            };
            return Some(failed(&message));
        }
    };
    Some(match resp.status.as_str() {
        "error" => failed(match resp.message.trim() {
            "" => "Authentication failed",
            m => m,
        }),
        "success" => {
            // Go `pluginLoginPollAuths`: `Auths`, else the single `Auth`.
            let data = if resp.auths.is_empty() {
                vec![resp.auth]
            } else {
                resp.auths
            };
            let auth_dir = host.host_config_summary().auth_dir;
            let records: Option<Vec<PluginAuth>> = data
                .into_iter()
                .map(|d| PluginAuth::from_auth_data(d, "", "", &auth_dir))
                .collect();
            let Some(records) = records.filter(|r| !r.is_empty()) else {
                return Some(failed("Authentication failed"));
            };
            let saved = {
                let state = state.clone();
                tokio::task::spawn_blocking(move || save_records(&state, records)).await
            };
            match saved {
                Ok(Ok(external)) => {
                    crate::plugins::reload_plugin_auth_files(&state.rt).await;
                    if !external.is_empty() {
                        let state = state.clone();
                        if tokio::task::spawn_blocking(move || {
                            let _guard = state.disk.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                            for (path, credentials) in external {
                                state.rt.store().upsert_file(Some(&path), credentials, &[]);
                            }
                        })
                        .await
                        .is_err()
                        {
                            return Some(failed("Failed to publish authentication tokens"));
                        }
                    }
                    state.oauth.complete(sid);
                    status("ok")
                }
                Ok(Err(e)) => {
                    tracing::error!(error = %e, provider = %provider, "failed to save plugin auth tokens");
                    failed("Failed to save authentication tokens")
                }
                Err(_) => failed("Failed to save authentication tokens"),
            }
        }
        // "", "pending" and anything else keep the client waiting.
        _ => status("wait"),
    })
}

/// Saves the working batch under the disk lock, then commits every source document
/// in one SQLite transaction before the OAuth session can complete. A failed write
/// or commit restores the earlier documents without publishing the batch.
fn save_records(
    state: &Management,
    records: Vec<PluginAuth>,
) -> Result<Vec<(std::path::PathBuf, Vec<cpa_core::credential::Credential>)>, String> {
    if state.rt.store().is_home() {
        return Err("credential saves unavailable in Home mode".into());
    }
    let _guard = state.disk.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let cfg = state.rt.config();
    let auth_dir = &cfg.auth_dir;
    let base = auth_dir.to_string_lossy();
    let backend = state.rt.store().credential_backend();
    let root = cpa_plugin::platform::clean(auth_dir);
    let paths: Vec<_> = records
        .iter()
        .map(|record| record.file_path(&base).map(std::path::PathBuf::from))
        .collect::<Result<_, _>>()?;
    let write_batch = || {
        let mut external = Vec::new();
        for (mut record, path) in records.into_iter().zip(&paths) {
            if let Ok(raw) = std::fs::read(path)
                && let Ok(Value::Object(existing)) = serde_json::from_slice::<Value>(&raw)
            {
                record.merge_existing(&existing);
            }
            let parsed = (cpa_plugin::platform::clean(path).parent() != Some(root.as_path()))
                .then(|| record.clone().into_parsed());
            record.save_file(&base, true)?;
            // Directory reloads cannot discover an explicit path outside the root
            // (or a nested path). Return its validated credentials to the poll.
            if let Some(parsed) = parsed {
                let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
                let metadata = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                let credentials =
                    cpa_core::config::credentials::plugin_save_credentials(path, &metadata, vec![parsed])?;
                external.retain(|(existing, _)| existing != path);
                external.push((path.clone(), credentials));
            }
        }
        Ok::<_, String>(external)
    };
    let result = backend
        .write_files(&paths, || write_batch().map_err(anyhow::Error::msg))
        .map_err(|e| format!("persist plugin auth batch: {e}"));
    if result.is_ok() {
        // Credentials only: the watcher rescans SQLite, as Go's watcher registers saved
        // tokens. Republishing the config here would restart plugins.
        state.credential_changes.notify_one();
    }
    result
}

/// Go `writeOAuthCallbackFile` for a plugin session: `.oauth-<provider>-<state>.oauth`
/// in the auth directory, published atomically, where the plugin's poll reads it.
pub(super) fn write_callback_file(
    auth_dir: &Path,
    provider: &str,
    sid: &str,
    code: &str,
    error: &str,
) -> Result<(), String> {
    use std::io::Write as _;
    if auth_dir.as_os_str().is_empty() {
        return Err("auth dir is empty".into());
    }
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder
        .create(auth_dir)
        .map_err(|e| format!("create oauth callback dir: {e}"))?;
    let payload = serde_json::to_vec(&json!({"code": code.trim(), "state": sid.trim(), "error": error.trim()}))
        .map_err(|e| e.to_string())?;
    let target = auth_dir.join(format!(".oauth-{provider}-{}.oauth", sid.trim()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut attempt = 0u32;
    let (tmp_path, mut tmp) = loop {
        let candidate = auth_dir.join(format!(".oauth-callback-{}{attempt}", std::process::id()));
        match options.open(&candidate) {
            Ok(file) => break (candidate, file),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && attempt < 10_000 => attempt += 1,
            Err(e) => return Err(format!("create oauth callback file: {e}")),
        }
    };
    let result = tmp
        .write_all(&payload)
        .map_err(|e| format!("write oauth callback file: {e}"))
        .and_then(|()| {
            drop(tmp);
            std::fs::rename(&tmp_path, &target).map_err(|e| format!("publish oauth callback file: {e}"))
        });
    let _ = std::fs::remove_file(&tmp_path);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sqlite_state(work: &Path) -> (Arc<Management>, Arc<crate::credential_store::CredentialDb>) {
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
        (Management::new(rt, store), db)
    }

    fn record(base: &Path, file: &str, raw: &'static [u8]) -> PluginAuth {
        PluginAuth::from_auth_data(
            cpa_plugin::api::AuthData {
                provider: "rec".into(),
                file_name: file.into(),
                storage_json: bytes::Bytes::from_static(raw),
                ..Default::default()
            },
            "",
            "",
            &base.to_string_lossy(),
        )
        .unwrap()
    }

    #[test]
    fn sqlite_batch_restores_every_file_on_later_record_or_sql_failure() {
        for sql_failure in [false, true] {
            let work = cpa_plugin::testing::scratch(&std::env::temp_dir(), "plugin-oauth-sqlite-rollback");
            let (state, db) = sqlite_state(&work);
            let auths = db.auth_dir();
            let existing = auths.join("existing.json");
            let prior = br#"{"type":"rec","access_token":"old","plugin_extra":{"keep":true}}"#;
            db.save(&existing, prior).unwrap();
            if sql_failure {
                rusqlite::Connection::open(work.join("config.db"))
                    .unwrap()
                    .execute_batch(
                        "CREATE TRIGGER reject_plugin BEFORE INSERT ON credential_document
                         WHEN instr(CAST(NEW.bytes AS TEXT), 'reject') > 0
                         BEGIN SELECT RAISE(ABORT, 'reject plugin batch'); END;",
                    )
                    .unwrap();
            }
            let outside = work.join("explicit.json");
            let mut explicit = record(&auths, "unused.json", br#"{"type":"rec","access_token":"created"}"#);
            explicit
                .attributes
                .insert("path".into(), outside.to_string_lossy().into_owned());
            let mut bad = record(&auths, "bad.json", br#"{"type":"rec","access_token":"reject"}"#);
            if !sql_failure {
                bad.attributes.insert("weight".into(), "1.5".into());
            }
            let result = save_records(
                &state,
                vec![
                    record(&auths, "existing.json", br#"{"type":"rec","access_token":"new"}"#),
                    explicit,
                    bad,
                ],
            );
            assert!(result.is_err());
            assert_eq!(db.read(&existing).unwrap().unwrap(), prior);
            assert_eq!(std::fs::read(&existing).unwrap(), prior);
            assert_eq!(db.documents().unwrap().len(), 1);
            assert!(!outside.exists());
            assert!(db.read(&outside).unwrap().is_none());
            assert!(!auths.join("bad.json").exists());
            assert!(state.rt.store().snapshot().is_empty());
            let _ = std::fs::remove_dir_all(work);
        }
    }

    #[test]
    fn sqlite_batch_preserves_unknown_fields_at_explicit_paths() {
        let work = cpa_plugin::testing::scratch(&std::env::temp_dir(), "plugin-oauth-sqlite-explicit");
        let (state, db) = sqlite_state(&work);
        let outside = work.join("explicit.json");
        db.save(
            &outside,
            br#"{"type":"rec","access_token":"old","plugin_extra":{"keep":true}}"#,
        )
        .unwrap();
        // A stale workspace must not override the canonical plugin fields.
        std::fs::write(&outside, br#"{"type":"rec","plugin_extra":"stale"}"#).unwrap();
        let mut auth = record(&db.auth_dir(), "unused.json", br#"{"type":"rec","access_token":"new"}"#);
        auth.attributes
            .insert("path".into(), outside.to_string_lossy().into_owned());
        let external = save_records(&state, vec![auth]).unwrap();
        assert_eq!(external.len(), 1);
        assert_eq!(external[0].0, outside);
        assert_eq!(external[0].1[0].metadata["plugin_extra"], json!({"keep": true}));
        let bytes = db.read(&outside).unwrap().unwrap();
        let saved: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(saved["access_token"], "new");
        assert_eq!(saved["plugin_extra"], json!({"keep": true}));
        std::fs::remove_file(&outside).unwrap();
        db.restore(&outside).unwrap();
        assert_eq!(std::fs::read(&outside).unwrap(), bytes);
        let _ = std::fs::remove_dir_all(work);
    }

    #[test]
    fn query_metadata_groups_repeated_keys() {
        let pairs = vec![
            ("b".to_owned(), "1".to_owned()),
            ("a".to_owned(), "x".to_owned()),
            ("b".to_owned(), "2".to_owned()),
        ];
        let m = query_metadata(pairs);
        assert_eq!(m["a"], serde_json::json!("x"));
        assert_eq!(m["b"], serde_json::json!(["1", "2"]));
    }
}
