//! Management API: the `/admin/v1` config resources ([`admin`]) and the v8 routes for
//! credentials, sign-ins, logs and plugins (plus the few v0 spellings the dashboard
//! predates).
//!
//! Routing follows gin: an unknown path or an unregistered method on a known path is a
//! bare 404 that never reaches authentication. Access rules live in [`access`].
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};

use axum::body::Bytes;
use axum::extract::rejection::BytesRejection;
use axum::extract::{DefaultBodyLimit, OriginalUri, State};
use axum::handler::Handler;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{MethodRouter, any, get};
use axum::{Router, middleware};
use cpa_common::gostr::GoStr;
use cpa_core::config::{Config, ConfigDocument, credentials};
use cpa_core::credential::{Credential, Source};
use serde_json::{Value, json};

use crate::Runtime;
use crate::config_store::{CommitError, Committed, ConfigStore};
use crate::scheduler::{ErrorRule, Policy};

mod access;
mod admin;
mod api_call;
mod auth_files;
mod auth_index;
mod iso_currency;
pub(crate) mod legacy;
mod logs;
pub(crate) mod multipart;
mod oauth;
pub mod observability;
mod plugin_auth;
mod plugin_oauth;
mod plugin_store;
mod plugins;
pub(crate) mod quota;
mod quota_probe;
mod siwc;
pub use access::cors;
pub(crate) use access::{Cors, cors_headers};
pub(crate) use plugins::go_query;

pub struct Management {
    pub(crate) rt: Arc<Runtime>,
    /// Where the config lives; every write goes through [`Management::commit_with`].
    pub(crate) config: Arc<ConfigStore>,
    /// The revision and digest of the stored config the runtime last published.
    published: Mutex<(u64, String)>,
    /// Another database connection committed; the watcher must rescan canonical credentials.
    pub(crate) credential_changes: Arc<tokio::sync::Notify>,
    /// Settings actually used to construct the listener and runtime.
    startup: Arc<Config>,
    // ponytail: one lock for config and auth disk operations; split only if management
    // throughput matters. The watcher shares it, preventing stale disk publication.
    pub(crate) disk: Mutex<()>,
    /// Uploaded files no synthesizer claims, kept listed until restart like Go's
    /// fallback auths (see `credentials::upload_fallback`).
    pub(crate) fallbacks: Mutex<std::collections::BTreeSet<PathBuf>>,
    /// Credentials disabled through the status or fields endpoints: Go's in-memory
    /// auth then reports `disabled via management API` until re-enabled.
    pub(crate) disabled_via_api: Mutex<std::collections::BTreeSet<String>>,
    /// When runtime-only credentials were first seen and last changed (Go's
    /// `CreatedAt`/`UpdatedAt` for them; the store keeps no timestamps).
    pub(crate) runtime_seen: Mutex<std::collections::HashMap<String, auth_files::RuntimeSeen>>,
    /// Go net/http clients by proxy for `api-call`.
    pub(crate) clients: cpa_exec::proxy::GoClients,
    pub(crate) latest_release_url: std::borrow::Cow<'static, str>,
    pub(crate) update_check_disabled: bool,
    // No task or expiry timer: allocated only after a successful, explicit check.
    // Wall-clock time, so a cached result also expires across sleep or hibernation.
    pub(crate) latest_release: tokio::sync::Mutex<Option<(std::time::SystemTime, String)>>,
    /// Pending and recent management logins (Go `oauthSessionStore`).
    pub(crate) oauth: oauth::Sessions,
    /// Callback forwarders by port (Go `callbackForwarders`).
    pub(crate) forwarders: Mutex<std::collections::HashMap<u16, oauth::Forwarder>>,
    pub(crate) login_base: Option<String>,
    /// Told the state of every management login that has finished (tests only).
    pub(crate) login_settled: Option<tokio::sync::mpsc::UnboundedSender<String>>,
    /// Every login worker panics on its blocking save task (tests only).
    pub(crate) login_panic: bool,
    /// Go `Handler.logDir`: resolved once at startup.
    pub(crate) log_dir: PathBuf,
    /// The zone log line timestamps are parsed in (Go `time.Local` when `None`).
    pub(crate) log_zone: logs::Zone,
    /// Plugin store test seams and release cache (Go `Handler.pluginStore*`).
    pub(crate) plugin_store: plugin_store::StoreState,
    access: access::Access,
}

#[derive(Default)]
pub struct Options {
    /// `--password`: accepted from loopback clients only, like Go's local password.
    pub local_password: String,
    /// `-tui -standalone`: the local password alone keeps management on, across
    /// reloads, for loopback clients. Go refuses every request without a configured
    /// secret, so its standalone TUI cannot sign in with a keyless config.
    pub standalone: bool,
    /// Overrides the `MANAGEMENT_PASSWORD` environment variable when set.
    pub management_password: Option<String>,
    /// Overrides [`observability::LATEST_RELEASE_URL`] (tests point it at a local server).
    pub latest_release_url: Option<String>,
    /// Overrides COOK_ROUTER_NO_UPDATE_CHECK (tests only).
    pub update_check_disabled: Option<bool>,
    /// One local base URL for every provider's login endpoints (tests only).
    pub login_base: Option<String>,
    /// Receives the state of every management login once its worker has finished,
    /// saved, failed or cancelled (tests only).
    pub login_settled: Option<tokio::sync::mpsc::UnboundedSender<String>>,
    /// Every management login worker panics on its blocking save task (tests only).
    pub login_panic: bool,
    /// Overrides the log directory Go resolves at startup (tests only).
    pub log_dir: Option<PathBuf>,
    /// Parses log line timestamps in this zone instead of the local one (tests only).
    pub log_zone: Option<chrono::FixedOffset>,
    /// The only plugin store registry (Go `pluginStoreRegistryURL`; tests only).
    pub plugin_store_registry_url: Option<String>,
    /// The plugin store's HTTP client (Go `pluginStoreHTTPClient`; tests only).
    pub plugin_store_http: Option<Arc<dyn cpa_plugin::store::Doer>>,
    /// The plugin store's GitHub rate limiter (Go `pluginStoreRateLimiter`); the
    /// process-wide one when unset.
    pub plugin_store_rate_limiter: Option<Arc<cpa_plugin::store::GitHubRateLimiter>>,
}

impl Management {
    /// Go `managementRoutesEnabled`, for the RESP protocol on the main listener.
    pub(crate) fn routes_enabled(&self) -> bool {
        self.access.available()
    }

    /// Go `AuthenticateManagementKey` for callers outside HTTP (the RESP protocol).
    pub(crate) async fn authenticate_key(
        &self,
        ip: &str,
        local: bool,
        provided: &[u8],
    ) -> Result<(), (StatusCode, String)> {
        self.access.authenticate(&self.rt.config(), ip, local, provided).await
    }

    pub fn new(rt: Arc<Runtime>, config: Arc<ConfigStore>) -> Arc<Self> {
        Self::with_options(rt, config, Options::default())
    }

    /// Captures startup-only settings (trusted proxies, environment secret) and
    /// publishes the scheduler policy derived from the current config.
    pub fn with_options(rt: Arc<Runtime>, config: Arc<ConfigStore>, options: Options) -> Arc<Self> {
        let cfg = rt.config();
        rt.publish_policy(policy(&cfg));
        let latest_release_url = options
            .latest_release_url
            .clone()
            .map(std::borrow::Cow::Owned)
            .unwrap_or(std::borrow::Cow::Borrowed(observability::LATEST_RELEASE_URL));
        let update_check_disabled = options.update_check_disabled.unwrap_or_else(|| {
            // CLIPROXY_NO_UPDATE_CHECK, the name before the rename, applies while the new one is unset.
            std::env::var("COOK_ROUTER_NO_UPDATE_CHECK")
                .or_else(|_| std::env::var("CLIPROXY_NO_UPDATE_CHECK"))
                .is_ok_and(|v| v == "1")
        });
        let login_base = options.login_base.clone();
        let log_dir = options
            .log_dir
            .clone()
            .unwrap_or_else(|| crate::logging::resolve_log_dir(&cfg));
        let mut options = options;
        let login_settled = options.login_settled.take();
        let login_panic = options.login_panic;
        let log_zone = options.log_zone;
        let plugin_store = plugin_store::StoreState::new(
            options.plugin_store_registry_url.take(),
            options.plugin_store_http.take(),
            options.plugin_store_rate_limiter.take(),
        );
        let access = access::Access::new(&cfg, options);
        rt.usage_queue().configure(access.available(), &cfg);
        let published = config
            .load()
            .ok()
            .filter(|l| l.config.document == cfg.document)
            .map(|l| (l.rev, l.digest))
            .unwrap_or_default();
        let state = Arc::new(Self {
            access,
            rt,
            config,
            published: Mutex::new(published),
            credential_changes: Arc::default(),
            startup: cfg,
            disk: Mutex::new(()),
            fallbacks: Mutex::default(),
            disabled_via_api: Mutex::default(),
            runtime_seen: Mutex::default(),
            clients: cpa_exec::proxy::GoClients::new(cpa_exec::proxy::Hooks::default()),
            latest_release_url,
            update_check_disabled,
            latest_release: tokio::sync::Mutex::new(None),
            oauth: oauth::Sessions::default(),
            forwarders: Mutex::default(),
            login_base,
            login_settled,
            login_panic,
            log_dir,
            log_zone,
            plugin_store,
        });
        oauth::install_callback_sink(&state);
        access::start_purge(&state);
        plugin_auth::attach(&state);
        state
    }

    /// Credentials always load from SQLite's materialized working folder.
    pub(crate) fn lock_auth_dir(&self, cfg: &mut Config) {
        if !self.rt.store().is_home() {
            cfg.auth_dir = self.rt.store().credential_backend().auth_dir();
        }
    }

    /// Deletes a canonical document before acknowledging its removal.
    pub(crate) fn store_delete(&self, path: &std::path::Path) -> Result<(), String> {
        if self.rt.store().is_home() {
            return Err("Home owns its credentials remotely".into());
        }
        self.rt
            .store()
            .credential_backend()
            .delete(path)
            .map_err(|e| format!("{e:#}"))?;
        self.credential_changes.notify_one();
        Ok(())
    }

    /// Runs one store write under `disk`, then publishes what it committed, so a
    /// publication never goes back to an older revision. With the result, whether a
    /// setting read only at startup (listener, TLS, trusted proxies) changed.
    pub(crate) fn commit_with(
        &self,
        write: impl FnOnce(&ConfigStore) -> Result<Committed, CommitError>,
    ) -> Result<(Committed, bool), CommitError> {
        let disk = self.disk.lock().unwrap_or_else(PoisonError::into_inner);
        self.commit_locked(&disk, write)
    }

    /// [`Self::commit_with`] for a caller already holding `disk`.
    pub(crate) fn commit_locked(
        &self,
        _disk: &std::sync::MutexGuard<'_, ()>,
        write: impl FnOnce(&ConfigStore) -> Result<Committed, CommitError>,
    ) -> Result<(Committed, bool), CommitError> {
        let done = write(&self.config)?;
        let restart = startup_changed(&self.startup, &done.config);
        if done.written {
            *self.published.lock().unwrap_or_else(PoisonError::into_inner) = (done.rev, done.digest.clone());
            self.publish(done.config.clone(), None);
        }
        Ok((done, restart))
    }

    /// Edits the config as one document, the way the plugin and credential endpoints
    /// change it; the caller holds `disk`. `edit`'s own error comes back as `Err(Ok(e))`.
    pub(crate) fn edit_document<E>(
        &self,
        disk: &std::sync::MutexGuard<'_, ()>,
        actor: &str,
        message: &str,
        edit: impl FnOnce(&mut ConfigDocument) -> Result<(), E>,
    ) -> Result<Committed, Result<E, CommitError>> {
        let mut failed = None;
        let done = self.commit_locked(disk, |store| {
            store.edit(actor, message, |json| {
                let invalid = |e: &dyn std::fmt::Display| {
                    crate::config_store::CommitError::invalid(format!("config is not YAML: {e}"))
                };
                let yaml = serde_yaml_ng::to_value(&*json).map_err(|e| invalid(&e))?;
                let mut doc = ConfigDocument::unmigrated(yaml);
                if let Err(e) = edit(&mut doc) {
                    failed = Some(e);
                    return Err(crate::config_store::CommitError::invalid("edit refused"));
                }
                *json = serde_json::to_value(cpa_core::config::AsJson(doc.value())).map_err(|e| invalid(&e))?;
                Ok(())
            })
        });
        match (done, failed) {
            (_, Some(e)) => Err(Ok(e)),
            (Ok((done, _)), None) => Ok(done),
            (Err(e), None) => Err(Err(e)),
        }
    }

    /// Publishes the stored config and wakes the credential watcher when another
    /// connection committed. An invalid config keeps the running one.
    pub fn reload_config(&self) {
        let _guard = self.disk.lock().unwrap_or_else(PoisonError::into_inner);
        match self.config.changed_elsewhere() {
            Ok(true) => {}
            Ok(false) => return,
            Err(e) => {
                tracing::error!("config store: {e:#}");
                return;
            }
        }
        self.credential_changes.notify_one();
        let loaded = match self.config.load() {
            Ok(loaded) => loaded,
            Err(fault) => {
                tracing::error!("config store: the stored config does not compile, keeping the running one: {fault}");
                return;
            }
        };
        let mut published = self.published.lock().unwrap_or_else(PoisonError::into_inner);
        if loaded.rev < published.0 || (loaded.rev, &loaded.digest) == (published.0, &published.1) {
            return;
        }
        crate::config_diff::log(&self.rt.config(), &loaded.config);
        tracing::info!("config revision {} changed elsewhere, reloading", loaded.rev);
        *published = (loaded.rev, loaded.digest);
        drop(published);
        self.publish(loaded.config, None);
    }

    /// The config database this server reads and writes.
    pub fn config_store(&self) -> &Arc<ConfigStore> {
        &self.config
    }

    /// The revision the runtime runs on.
    pub(crate) fn published_rev(&self) -> u64 {
        self.published.lock().unwrap_or_else(PoisonError::into_inner).0
    }

    /// The stored config, recorded as the published revision; the caller holds `disk`
    /// and publishes it.
    pub(crate) fn stored_config(&self) -> Result<Config, crate::config_store::Fault> {
        let loaded = self.config.load()?;
        let mut published = self.published.lock().unwrap_or_else(PoisonError::into_inner);
        if loaded.rev < published.0 {
            return Err(crate::config_store::Fault::new(
                None,
                "stored revision is older than the running revision",
            ));
        }
        *published = (loaded.rev, loaded.digest);
        drop(published);
        Ok(loaded.config)
    }

    /// Publishes a config and everything Go derives from it on reload: scheduler
    /// policy, management availability, and the credential set (auth-dir files plus
    /// config API keys). `files` replaces the auth-dir scan when the caller already
    /// has one; its file hashes keep a stale scan from undoing a later write (Go
    /// c4c1d43e). Callers hold `disk`. Infallible on purpose: access settings of a
    /// valid config (a rotated or removed secret) always take effect.
    pub(crate) fn publish(&self, cfg: Config, files: Option<credentials::AuthScan>) {
        self.publish_upload(cfg, files, None);
    }

    /// Reads canonical documents; a failed scan keeps loaded file credentials while
    /// allowing the config itself to take effect.
    pub(crate) fn scan_credentials(&self, cfg: &Config) -> credentials::AuthScan {
        if self.rt.store().is_home() {
            return credentials::AuthScan::default();
        }
        self.rt.store().credential_backend().scan(cfg).unwrap_or_else(|error| {
            tracing::error!("credential database: reading credentials failed, keeping the loaded ones: {error:#}");
            let credentials = self
                .rt
                .store()
                .snapshot()
                .iter()
                .filter(|c| matches!(c.source, Source::File(_)))
                .map(|c| Credential::clone(c))
                .collect();
            credentials::AuthScan {
                credentials,
                ..Default::default()
            }
        })
    }

    /// [`Self::publish`] after an upload wrote `upload`'s file. While plugin auth
    /// providers have not parsed the new bytes, the uploaded credential is registered as
    /// built, as Go's upload registers it (`buildAuthFromFileData`, no plugin parser),
    /// replacing one with the same ID; the watcher's next reload asks the plugins.
    /// `upload` carries the SHA-256 of the bytes written: a write committed since (a
    /// token refresh) changed the file, and the current credential is kept.
    pub(crate) fn publish_upload(
        &self,
        cfg: Config,
        files: Option<credentials::AuthScan>,
        upload: Option<(Credential, [u8; 32])>,
    ) {
        // Nothing below is applied for a config the runtime would refuse to publish.
        if !Runtime::accepts_config(&cfg) {
            return;
        }
        let mut cfg = cfg;
        self.lock_auth_dir(&mut cfg);
        use sha2::{Digest, Sha256};
        let scan = files.unwrap_or_else(|| self.scan_credentials(&cfg));
        let mut all = scan.credentials;
        let mut read = scan.read;
        // Uploads record absolute paths; a relative auth-dir scans relative ones.
        let absolute = |p: &PathBuf| std::path::absolute(p).unwrap_or_else(|_| p.clone());
        // Fallbacks follow their file: gone with it, replaced once a synthesizer
        // claims it, otherwise rebuilt from its current content.
        let mut claimed = Vec::new();
        let mut fallbacks = self.fallbacks.lock().unwrap_or_else(PoisonError::into_inner);
        fallbacks.retain(|path| {
            let Ok(data) = auth_files::read_file(self, path) else {
                return false;
            };
            if all
                .iter()
                .any(|c| matches!(&c.source, Source::File(p) if absolute(p) == absolute(path)))
            {
                claimed.push(path.clone());
                return false;
            }
            match credentials::upload_fallback(&cfg.auth_dir, path, &data) {
                Some(c) => {
                    // Bound to the bytes it was built from, under its own path, so the
                    // freshness check compares this read, not the scan's.
                    if let Source::File(p) = &c.source {
                        read.insert(p.clone(), Sha256::digest(&data).into());
                    }
                    all.push(c);
                    true
                }
                None => false,
            }
        });
        drop(fallbacks);
        #[cfg(test)]
        {
            let mut hooks = BEFORE_RECONCILE.lock().unwrap();
            let hook = hooks
                .iter()
                .position(|(dir, _)| *dir == cfg.auth_dir)
                .map(|i| hooks.remove(i).1);
            drop(hooks);
            if let Some(hook) = hook {
                hook();
            }
        }
        all.extend(credentials::from_config(&cfg));
        if cfg != *self.rt.config() {
            self.access.config_published(&cfg);
            crate::logging::configure(&cfg);
            self.rt.usage_queue().configure(self.access.available(), &cfg);
            let policy = policy(&cfg);
            self.rt.publish_config_and_policy(cfg, policy);
        }
        let upload = upload.filter(|(c, _)| {
            matches!(&c.source, Source::File(path) if scan.deferred.iter().any(|p| absolute(p) == absolute(path)))
        });
        if let Some((
            Credential {
                source: Source::File(path),
                ..
            },
            written,
        )) = &upload
        {
            read.insert(path.clone(), *written);
        }
        let rejected = self.rt.store().reconcile_scanned_with(all, &read, |current, all| {
            crate::plugins::keep_deferred(current, all, &scan.deferred);
            if let Some((upload, _)) = upload {
                all.retain(|c| c.id != upload.id);
                all.push(upload);
            }
        });
        // A synthesizer claimed the file but its credential was rejected as stale, so the
        // fallback stays live: keep tracking it, or the next reload would drop it.
        let kept: Vec<PathBuf> = claimed
            .into_iter()
            .filter(|path| rejected.iter().any(|r| absolute(r) == absolute(path)))
            .collect();
        if !kept.is_empty() {
            self.fallbacks
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .extend(kept);
        }
        // Go's watcher calls redisqueue.NotifyUsageRefresh after every client reload.
        self.rt.usage_queue().notify_usage_refresh();
    }
}

/// `Policy::from(routing)` plus the provider-level rules Go reads from config:
/// `oauth.request-scoped-errors`, sanitized like `SanitizeOAuthRequestScopedErrors`, and
/// cook-router `routing.providers`.
pub fn policy(cfg: &Config) -> Policy {
    let mut policy = Policy::from(&cfg.routing);
    policy.providers = std::sync::Arc::new(crate::provider_policy::Providers::global(cfg));
    let rules = cfg
        .document
        .get("oauth")
        .and_then(|o| o.get("request-scoped-errors"))
        .and_then(serde_yaml_ng::Value::as_mapping);
    for (channel, list) in rules.into_iter().flatten() {
        let channel = channel.as_str().unwrap_or_default().trim().go_lower();
        let clean: Vec<ErrorRule> = list
            .as_sequence()
            .into_iter()
            .flatten()
            .filter_map(|r| {
                let words = |k: &str| -> Vec<String> {
                    r.get(k)
                        .and_then(serde_yaml_ng::Value::as_sequence)
                        .into_iter()
                        .flatten()
                        .filter_map(|v| v.as_str().map(|s| s.trim().to_owned()))
                        .filter(|s| !s.is_empty())
                        .collect()
                };
                let rule = ErrorRule {
                    status: r.get("status").and_then(serde_yaml_ng::Value::as_i64).unwrap_or(0),
                    r#match: words("match"),
                    match_regex: words("match-regexr"),
                    action: r
                        .get("action")
                        .and_then(serde_yaml_ng::Value::as_str)
                        .unwrap_or_default()
                        .trim()
                        .go_lower(),
                };
                (rule.status > 0
                    && !(rule.r#match.is_empty() && rule.match_regex.is_empty())
                    && !rule.action.is_empty())
                .then_some(rule)
            })
            .collect();
        if !channel.is_empty() && !clean.is_empty() {
            policy.oauth_request_scoped_errors.insert(channel, clean);
        }
    }
    policy
}

/// gin `c.JSON` of a `gin.H` map: Go's `json.Marshal` (sorted keys; `<`, `>`, `&`,
/// U+2028 and U+2029 escaped) with the charset parameter.
pub(crate) fn json(status: StatusCode, value: &Value) -> Response {
    json_body(status, crate::gojson::sorted(value))
}

/// gin `c.JSON` of a value that holds Go structs: objects keep their insertion order
/// (struct fields as Go declares them; callers insert map levels sorted, see
/// [`sorted_keys`]), strings escaped like `json.Marshal`.
pub(crate) fn json_ordered(status: StatusCode, value: &Value) -> Response {
    let mut out = Vec::new();
    write_ordered(value, &mut out);
    json_body(status, String::from_utf8(out).expect("JSON text is UTF-8"))
}

fn write_ordered(value: &Value, out: &mut Vec<u8>) {
    match value {
        Value::Null => out.extend_from_slice(b"null"),
        Value::Bool(b) => out.extend_from_slice(if *b { b"true" } else { b"false" }),
        Value::Number(n) => out.extend_from_slice(n.to_string().as_bytes()),
        Value::String(s) => out.extend(cpa_common::json::quote(s)),
        Value::Array(items) => {
            out.push(b'[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                write_ordered(item, out);
            }
            out.push(b']');
        }
        Value::Object(map) => {
            out.push(b'{');
            for (i, (key, item)) in map.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                out.extend(cpa_common::json::quote(key));
                out.push(b':');
                write_ordered(item, out);
            }
            out.push(b'}');
        }
    }
}

/// A copy whose objects all have sorted keys, as Go encodes a `map[string]any`.
pub(crate) fn sorted_keys(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let sorted: std::collections::BTreeMap<&String, Value> =
                map.iter().map(|(k, v)| (k, sorted_keys(v))).collect();
            Value::Object(sorted.into_iter().map(|(k, v)| (k.clone(), v)).collect())
        }
        Value::Array(items) => Value::Array(items.iter().map(sorted_keys).collect()),
        other => other.clone(),
    }
}

fn json_body(status: StatusCode, body: String) -> Response {
    (
        status,
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json; charset=utf-8"),
        )],
        body,
    )
        .into_response()
}

pub(crate) fn json_error(status: StatusCode, message: &str) -> Response {
    json(status, &json!({"error": message}))
}

/// Go `HTTPStatusFromErrorOr(err, 400)` for a failed body read in the handlers
/// dd7b4334 changed: 413 at `server.max-request-body-bytes` (and at a route's own
/// `DefaultBodyLimit`), else 400.
pub(crate) fn read_status(rejection: &BytesRejection) -> StatusCode {
    if crate::body_limit::is_too_large(rejection) || rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
        StatusCode::PAYLOAD_TOO_LARGE
    } else {
        StatusCode::BAD_REQUEST
    }
}

/// The text of a failed body read: Go's `err.Error()` at the limit.
pub(crate) fn read_reason(rejection: &BytesRejection) -> String {
    crate::claude::read_error(rejection).1
}

fn error(code: u16, message: &str) -> Response {
    json_error(StatusCode::from_u16(code).unwrap(), message)
}

/// Wraps one method handler in the management guard; methods without a handler fall
/// through to a bare 404 like gin's NoRoute.
macro_rules! guarded {
    ($state:expr, $handler:expr) => {
        $handler.layer(middleware::from_fn_with_state($state.clone(), access::guard))
    };
}

/// Availability only, no key: Go's OAuth callback routes.
macro_rules! open {
    ($state:expr, $handler:expr) => {
        $handler.layer(middleware::from_fn_with_state($state.clone(), access::available))
    };
}

/// gin answers HEAD and unregistered methods on a known path with NoRoute (no `Allow`
/// header; starting from `any` keeps axum from adding one). Go's NoRoute serves
/// plugin routes, so those requests go to [`plugins::no_route`].
fn methods() -> MethodRouter<Arc<Management>> {
    // An explicit HEAD keeps axum from answering HEAD with the GET handler.
    any(plugins::no_route).head(plugins::no_route)
}

/// The OAuth callback POST needs no key, so unlike Go it keeps a bound: legitimate
/// bodies are a state, a code and a redirect URL.
const CALLBACK_BODY_LIMIT: usize = 64 * 1024;

pub fn router(state: Arc<Management>) -> Router {
    let s = &state;
    let v8 = "/v8/management";
    let v0 = "/v0/management";
    let admin = "/admin/v1";
    let mut router = Router::new()
        .route(&format!("{admin}/r/{{kind}}"), methods().get(guarded!(s, admin::list)))
        .route(
            &format!("{admin}/r/{{kind}}/{{id}}"),
            methods()
                .get(guarded!(s, admin::get))
                .put(guarded!(s, admin::put))
                .patch(guarded!(s, admin::patch))
                .delete(guarded!(s, admin::delete)),
        )
        .route(&format!("{admin}/apply"), methods().post(guarded!(s, admin::apply)))
        .route(
            &format!("{admin}/effective/config"),
            methods().get(guarded!(s, admin::effective_config)),
        )
        .route(
            &format!("{admin}/revisions"),
            methods().get(guarded!(s, admin::revisions)),
        )
        .route(
            &format!("{admin}/revisions/{{rev}}"),
            methods().get(guarded!(s, admin::revision)),
        )
        .route(
            &format!("{admin}/revisions/{{rev}}/restore"),
            methods().post(guarded!(s, admin::restore)),
        )
        .route(&format!("{admin}/export"), methods().get(guarded!(s, admin::export)))
        .route(&format!("{admin}/import"), methods().post(guarded!(s, admin::import)));
    // v8 and its deprecated v0 spellings share Go's handlers.
    for (base, files, definitions) in [
        (v8, "credentials", "routing/model-definitions"),
        (v0, "auth-files", "model-definitions"),
    ] {
        router = router
            .route(
                &format!("{base}/{files}"),
                methods()
                    .get(guarded!(s, auth_files::list))
                    .post(guarded!(s, auth_files::upload))
                    .delete(guarded!(s, auth_files::delete)),
            )
            .route(
                &format!("{base}/{files}/models"),
                methods().get(guarded!(s, auth_files::models)),
            )
            .route(
                &format!("{base}/{files}/download"),
                methods().get(guarded!(s, auth_files::download)),
            )
            .route(
                &format!("{base}/{files}/status"),
                methods().patch(guarded!(s, auth_files::status)),
            )
            .route(
                &format!("{base}/{files}/fields"),
                methods().patch(guarded!(s, auth_files::fields)),
            )
            .route(
                &format!("{base}/{files}/refresh"),
                methods().post(guarded!(s, auth_files::refresh)),
            )
            .route(
                &format!("{base}/{definitions}/{{channel}}"),
                methods().get(guarded!(s, auth_files::model_definitions)),
            );
    }
    for (path, route) in [
        (
            "server/latest-version",
            methods().get(guarded!(s, observability::latest_version)),
        ),
        ("requests/api-call", methods().post(guarded!(s, api_call::api_call))),
        (
            "routing/cooldown/reset",
            methods().post(guarded!(s, auth_files::cooldown_reset)),
        ),
        (
            "observability/usage/api-keys",
            methods().get(guarded!(s, observability::api_key_usage)),
        ),
        (
            "observability/usage/queue",
            methods().get(guarded!(s, observability::usage_queue)),
        ),
        ("oauth/auth-url", methods().get(guarded!(s, oauth::auth_url))),
        ("oauth/status", methods().get(guarded!(s, oauth::status))),
        ("oauth/session", methods().delete(guarded!(s, oauth::cancel))),
        ("oauth/import", methods().post(guarded!(s, oauth::import))),
        ("oauth/siwc/bind", methods().post(guarded!(s, siwc::bind))),
        (
            "observability/logs",
            methods()
                .get(guarded!(s, logs::get_logs))
                .delete(guarded!(s, logs::delete_logs)),
        ),
        (
            "observability/logs/errors",
            methods().get(guarded!(s, logs::error_logs)),
        ),
        (
            "observability/logs/errors/{name}",
            methods().get(guarded!(s, logs::download_error_log)),
        ),
        (
            "observability/logs/requests/{id}",
            methods().get(guarded!(s, logs::request_log)),
        ),
        (
            "oauth/callback",
            methods()
                .get(open!(s, oauth::callback_get))
                .post(open!(s, oauth::callback_post).layer(DefaultBodyLimit::max(CALLBACK_BODY_LIMIT))),
        ),
    ] {
        router = router.route(&format!("{v8}/{path}"), route);
    }
    for (path, route) in [
        (
            "latest-version",
            methods().get(guarded!(s, observability::latest_version)),
        ),
        ("api-call", methods().post(guarded!(s, api_call::api_call))),
        ("reset-quota", methods().post(guarded!(s, auth_files::cooldown_reset))),
        (
            "api-key-usage",
            methods().get(guarded!(s, observability::api_key_usage)),
        ),
        ("usage-queue", methods().get(guarded!(s, observability::usage_queue))),
        ("get-auth-status", methods().get(guarded!(s, oauth::status))),
        ("oauth-session", methods().delete(guarded!(s, oauth::cancel))),
        (
            "oauth-callback",
            methods()
                .get(open!(s, oauth::callback_get))
                .post(open!(s, oauth::callback_post).layer(DefaultBodyLimit::max(CALLBACK_BODY_LIMIT))),
        ),
    ] {
        router = router.route(&format!("{v0}/{path}"), route);
    }
    // Plugin routes: v8 and the v0 spellings Go keeps (internal/api/server_management.go,
    // server_management_v8.go); the v0 config, enable and v8 store routes share them.
    for (path, route) in [
        ("plugins", methods().get(guarded!(s, plugins::list))),
        ("plugins/{id}", methods().delete(guarded!(s, plugins::delete))),
    ] {
        router = router
            .route(&format!("{v8}/{path}"), route.clone())
            .route(&format!("{v0}/{path}"), route);
    }
    // Plugin store (plugin_store.go). gin keeps one route tree per method, so a DELETE of
    // `plugins/store` is DeletePlugin with the ID `store`.
    router = router
        .route(
            &format!("{v8}/plugins/store"),
            methods()
                .get(guarded!(s, plugin_store::list))
                .delete(guarded!(s, plugins::delete_store_id)),
        )
        .route(
            &format!("{v8}/plugins/store/{{id}}/install"),
            methods().post(guarded!(s, plugin_store::install)),
        )
        .route(
            &format!("{v0}/plugin-store"),
            methods().get(guarded!(s, plugin_store::list)),
        )
        .route(
            &format!("{v0}/plugin-store/{{id}}/install"),
            methods().post(guarded!(s, plugin_store::install)),
        );
    // Plugin quota (plugin_quota.go): per-plugin under v8 and v0, the credential-level
    // routes and the reset alias only under v0.
    for base in [v8, v0] {
        router = router.route(
            &format!("{base}/plugins/{{id}}/quota"),
            methods()
                .get(guarded!(s, quota::get_plugin))
                .post(guarded!(s, quota::fetch_plugin))
                .delete(guarded!(s, quota::reset_plugin)),
        );
    }
    router = router
        .route(
            &format!("{v0}/plugins/{{id}}/quota/reset"),
            methods().post(guarded!(s, quota::reset_plugin)),
        )
        .route(
            &format!("{v0}/quota/providers"),
            methods().get(guarded!(s, quota::providers)),
        )
        .route(&format!("{v0}/quota/fetch"), methods().post(guarded!(s, quota::fetch)))
        .route(&format!("{v0}/quota/reset"), methods().post(guarded!(s, quota::reset)));
    router = router.route(
        &format!("{v0}/plugins/{{id}}/enabled"),
        methods().patch(guarded!(s, plugins::patch_enabled)),
    );
    for (path, _) in legacy::AUTH_URL_ROUTES {
        router = router.route(&format!("{v0}/{path}"), methods().get(guarded!(s, legacy::auth_url)));
    }
    router = router
        .route(
            &format!("{v0}/vertex/import"),
            methods().post(guarded!(s, legacy::vertex_import)),
        )
        .route(
            &format!("{v0}/logs"),
            methods()
                .get(guarded!(s, logs::get_logs))
                .delete(guarded!(s, logs::delete_logs)),
        )
        .route(
            &format!("{v0}/request-error-logs"),
            methods().get(guarded!(s, logs::error_logs)),
        )
        .route(
            &format!("{v0}/request-error-logs/{{name}}"),
            methods().get(guarded!(s, logs::download_error_log)),
        )
        .route(
            &format!("{v0}/request-log-by-id/{{id}}"),
            methods().get(guarded!(s, logs::request_log)),
        );
    router
        .fallback(plugins::no_route)
        .route("/management.html", get(panel))
        .route("/assets/{*path}", get(panel))
        .route("/fonts/{*path}", get(panel))
        .route("/favicon.svg", get(panel))
        // gin reads management bodies without a size limit (uploads, config writes);
        // they are only read after authentication.
        .layer(DefaultBodyLimit::disable())
        .layer(middleware::from_fn(cors))
        .with_state(state)
}

pub(crate) fn percent_decode(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes
            .get(i + 1..i + 3)
            .and_then(|h| u8::from_str_radix(std::str::from_utf8(h).ok()?, 16).ok());
        match (bytes[i], hex) {
            (b'%', Some(b)) => {
                out.push(b);
                i += 3;
            }
            (b, _) => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Test hook run once by the next [`Management::publish`] for the auth folder it names,
/// after it has built its fallback credentials and before it reconciles them.
#[cfg(test)]
pub(crate) static BEFORE_RECONCILE: Mutex<Vec<(PathBuf, LayoutHook)>> = Mutex::new(Vec::new());

#[cfg(test)]
pub(crate) type LayoutHook = Box<dyn FnOnce() + Send>;

/// Go `liveAuthIndexFromManager`: the index each config-backed credential carries.
pub(super) fn live_auth_indexes(state: &Management) -> std::collections::HashMap<String, String> {
    state
        .rt
        .store()
        .snapshot()
        .iter()
        .filter(|c| matches!(c.source, Source::Config { .. }))
        .map(|c| (c.id.clone(), credentials::auth_index(c)))
        .collect()
}

/// Whether a setting the server reads only at startup differs: the listener address,
/// TLS, trusted proxies, or the configured Tokio worker count when the environment
/// does not override it.
fn startup_changed(before: &Config, after: &Config) -> bool {
    let tls = |c: &Config| c.document.get("server").and_then(|s| s.get("tls")).cloned();
    before.host != after.host
        || before.port != after.port
        || before.trusted_proxies != after.trusted_proxies
        || tls(before) != tls(after)
        || (std::env::var_os("TOKIO_WORKER_THREADS").is_none()
            && before.document.get("worker-threads") != after.document.get("worker-threads"))
}

include!(concat!(env!("OUT_DIR"), "/dashboard.rs"));

fn accepts_gzip(headers: &HeaderMap) -> bool {
    let mut gzip = None;
    let mut wildcard = false;
    for value in headers.get_all(header::ACCEPT_ENCODING) {
        let Ok(value) = value.to_str() else { continue };
        for coding in value.split(',') {
            let mut parts = coding.split(';');
            let name = parts.next().unwrap_or_default().trim();
            if !name.eq_ignore_ascii_case("gzip") && name != "*" {
                continue;
            }
            let quality = parts
                .filter_map(|part| part.split_once('='))
                .find(|(name, _)| name.trim().eq_ignore_ascii_case("q"))
                .map_or(1.0, |(_, value)| value.trim().parse::<f32>().unwrap_or(0.0));
            let accepted = quality > 0.0 && quality <= 1.0;
            if name == "*" {
                wildcard = accepted;
            } else {
                gzip = Some(accepted);
            }
        }
    }
    gzip.unwrap_or(wildcard)
}

async fn panel(State(state): State<Arc<Management>>, OriginalUri(uri): OriginalUri, headers: HeaderMap) -> Response {
    if state.rt.config().management.disable_control_panel {
        return error(404, "not_found");
    }
    let Some((bytes, mime, gzip)) = dashboard_asset(uri.path()) else {
        return error(404, "not_found");
    };
    let encoded = gzip && accepts_gzip(&headers);
    let body = if gzip && !encoded {
        use tokio::io::AsyncReadExt;
        let mut decoded = Vec::new();
        if async_compression::tokio::bufread::GzipDecoder::new(bytes)
            .read_to_end(&mut decoded)
            .await
            .is_err()
        {
            return error(500, "dashboard_decode_failed");
        }
        Bytes::from(decoded)
    } else {
        Bytes::from_static(bytes)
    };
    let mut response = (
        [(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, "no-cache")],
        body,
    )
        .into_response();
    if gzip {
        response
            .headers_mut()
            .insert(header::VARY, HeaderValue::from_static("Accept-Encoding"));
    }
    if encoded {
        response
            .headers_mut()
            .insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
    }
    response
}
