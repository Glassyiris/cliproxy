//! Replays expectations recorded from the pinned Go reference
//! (tests/reference/manage/main.go -> tests/fixtures/manage_go.json).
use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::Path;

use cpa_core::config::{Config, TrustedProxies, credentials};
use cpa_core::credential::{Credential, Source};
use cpa_server::config_store::ConfigStore;
use serde_json::{Value, json};

fn fixture() -> &'static Value {
    static FIXTURE: std::sync::LazyLock<Value> = std::sync::LazyLock::new(|| {
        serde_json::from_str(include_str!("fixtures/manage_go.json")).expect("fixture JSON")
    });
    &FIXTURE
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| a.iter().map(|s| s.as_str().unwrap().to_owned()).collect())
        .unwrap_or_default()
}

fn first_header<'a>(headers: &'a Value, name: &str) -> Option<&'a [u8]> {
    headers
        .as_object()?
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))?
        .1
        .as_array()?
        .first()?
        .as_str()
        .map(str::as_bytes)
}

// Access policy still follows these recordings; admin failures have a typed envelope.
fn admin_auth_body(legacy: &str, status: u16) -> Value {
    let legacy: Value = serde_json::from_str(legacy).unwrap();
    json!({"error": if status == 401 { "unauthorized" } else { "forbidden" },
        "resource": null, "pointer": null, "pointers": [], "message": legacy["error"]})
}

/// Go's key order (map keys sorted, struct fields as declared) against ours, wherever
/// both objects have the same keys; values may differ (times, indexes). Both sides are
/// parsed with insertion order kept.
fn same_key_order(go: &Value, rs: &Value, at: &str) -> Result<(), String> {
    match (go, rs) {
        (Value::Object(g), Value::Object(r)) => {
            let (gk, rk): (Vec<&String>, Vec<&String>) = (g.keys().collect(), r.keys().collect());
            let mut gs = gk.clone();
            let mut rsorted = rk.clone();
            gs.sort();
            rsorted.sort();
            if gs != rsorted {
                return Ok(());
            }
            if gk != rk {
                return Err(format!("{at}: key order go {gk:?} rs {rk:?}"));
            }
            for (k, v) in g {
                same_key_order(v, &r[k.as_str()], &format!("{at}.{k}"))?;
            }
            Ok(())
        }
        (Value::Array(g), Value::Array(r)) if g.len() == r.len() => {
            for (i, (gv, rv)) in g.iter().zip(r).enumerate() {
                same_key_order(gv, rv, &format!("{at}[{i}]"))?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// The config text for one `yaml_bools` fixture case (same templates as Go's).
fn scalar_case_yaml(field: &str, spelling: &str) -> String {
    match field {
        "observability.logs.debug" => format!("config-version: 8\nobservability:\n  logs:\n    debug: {spelling}\n"),
        "plugins.configs.x.enabled" => {
            format!("config-version: 8\nplugins:\n  configs:\n    x:\n      enabled: {spelling}\n")
        }
        "server.host" => format!("config-version: 8\nserver:\n  host: {spelling}\n"),
        _ => format!("config-version: 8\ncredentials:\n  concurrency:\n    cpa-heartbeat-timeout: {spelling}\n"),
    }
}

#[test]
fn yaml_bool_spellings_and_durations_load_like_go() {
    let cases = fixture()["yaml_bools"].as_array().unwrap();
    assert!(cases.len() > 100);
    for case in cases {
        let (field, spelling) = (case["field"].as_str().unwrap(), case["spelling"].as_str().unwrap());
        let at = format!("{field}: {spelling}");
        let parsed = Config::parse(&scalar_case_yaml(field, spelling));
        assert_eq!(
            parsed.is_err(),
            case["error"] == true,
            "{at}: {:?}",
            parsed.as_ref().err()
        );
        let Ok(cfg) = parsed else { continue };
        let flag = |path: &[&str]| {
            path.iter()
                .try_fold(&cfg.document, |node, part| node.get(*part))
                .and_then(serde_yaml_ng::Value::as_bool)
                .unwrap_or(false)
        };
        let got = match field {
            "observability.logs.debug" => json!(flag(&["observability", "logs", "debug"])),
            // Plugin entries stay raw (Go `PluginInstanceConfig.Raw`); Go's typed
            // `Enabled` decodes the YAML 1.1 spellings from them.
            "plugins.configs.x.enabled" => {
                let raw = cfg.document["plugins"]["configs"]["x"]["enabled"].clone();
                json!(match &raw {
                    serde_yaml_ng::Value::Bool(b) => *b,
                    serde_yaml_ng::Value::String(s) => cpa_core::config::go_bool(s).unwrap_or(false),
                    _ => false,
                })
            }
            "server.host" => json!(cfg.host),
            // Durations: load acceptance only (nothing consumes them without Home).
            _ => continue,
        };
        assert_eq!(got, case["value"], "{at}");
    }
}

/// Go's typed decoding and raw plugin views (`typed_scalars` in the fixture): load
/// errors match; int fields truncate floats; plugin entries keep their raw scalars in
/// the live document, from which `go_bool`/`go_int` give Go's typed values.
#[test]
fn typed_scalars_and_raw_plugin_entries_load_like_go() {
    let hash = bcrypt::hash("fake-secret", 4).unwrap();
    let cases = fixture()["typed_scalars"].as_array().unwrap();
    assert_eq!(cases.len(), 12);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let parsed = Config::parse(&case["yaml"].as_str().unwrap().replace("$HASH", &hash));
        assert_eq!(
            parsed.is_err(),
            case["error"] == true,
            "{name}: {:?}",
            parsed.as_ref().err()
        );
        let Ok(cfg) = parsed else { continue };
        assert_eq!(json!(cfg.routing.retry.request_retry), case["request_retry"], "{name}");
        let Some(raw_view) = case.get("raw_view") else { continue };
        let entry = cfg.document["plugins"]["configs"].get("x").cloned().unwrap();
        // Go's raw view of a null entry is `{}`.
        let raw: Value = match &entry {
            serde_yaml_ng::Value::Null => json!({}),
            other => serde_json::to_value(other).unwrap(),
        };
        assert_eq!(raw, raw_view["body"], "{name}: raw view");
        let enabled = entry.get("enabled").and_then(|v| match v {
            serde_yaml_ng::Value::Bool(b) => Some(*b),
            serde_yaml_ng::Value::String(s) => cpa_core::config::go_bool(s),
            _ => None,
        });
        let priority = entry.get("priority").and_then(cpa_core::config::go_int);
        assert_eq!(
            json!(enabled.unwrap_or(false)),
            case["enabled"],
            "{name}: typed enabled"
        );
        assert_eq!(json!(priority.unwrap_or(0)), case["priority"], "{name}: typed priority");
    }
}

#[test]
fn yaml_merge_keys_load_like_go() {
    for case in fixture()["yaml_merges"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let parsed = Config::parse(case["yaml"].as_str().unwrap());
        assert_eq!(
            parsed.is_err(),
            case["error"] == true,
            "{name}: {:?}",
            parsed.as_ref().err()
        );
        let Ok(cfg) = parsed else { continue };
        let want = &case["values"];
        let logs = |key: &str| {
            cfg.document
                .get("observability")
                .and_then(|o| o.get("logs"))
                .and_then(|l| l.get(key))
                .and_then(serde_yaml_ng::Value::as_bool)
                .unwrap_or(false)
        };
        let claude: Vec<Value> = credentials::from_config(&cfg)
            .iter()
            .filter(|c| c.provider == "claude")
            .map(|c| {
                json!({
                    "api-key": c.attributes["api_key"],
                    "priority": c.attributes.get("priority").map_or(0, |p| p.parse::<i64>().unwrap()),
                })
            })
            .collect();
        let got = json!({
            "request-retry": cfg.routing.retry.request_retry,
            "max-retry-interval": cfg.routing.retry.max_retry_interval,
            "debug": logs("debug"),
            "request-log": logs("request-log"),
            "claude": claude,
        });
        assert_eq!(&got, want, "{name}");
    }
}

#[test]
fn client_ip_matches_gin_for_every_trusted_remote_and_header_combination() {
    let cases = fixture()["client_ip"].as_array().unwrap();
    assert!(cases.len() > 300);
    for case in cases {
        let trusted = TrustedProxies::new(&strings(&case["trusted"]));
        let remote: SocketAddr = case["remote"].as_str().unwrap().parse().unwrap();
        let got = trusted.client_ip(Some(remote), |name| first_header(&case["headers"], name));
        assert_eq!(got, case["ip"].as_str().unwrap(), "{case}");
    }
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

#[test]
fn forwarded_header_bytes_and_zoned_peers_match_gin() {
    let cases = fixture()["client_ip_bytes"].as_array().unwrap();
    assert_eq!(cases.len(), 10);
    for case in cases {
        let trusted = TrustedProxies::new(&strings(&case["trusted"]));
        let remote = case["remote"].as_str().unwrap();
        // Go's zone text has no Rust parse form; a nonzero scope is the same fact.
        let peer: SocketAddr = match remote.split_once('%') {
            Some((ip, _)) => std::net::SocketAddrV6::new(ip.trim_start_matches('[').parse().unwrap(), 1, 0, 2).into(),
            None => remote.parse().unwrap(),
        };
        let xff = unhex(case["xff_hex"].as_str().unwrap());
        let real = case["x_real_ip_hex"].as_str().map(unhex);
        let got = trusted.client_ip(Some(peer), |name| match name {
            "X-Forwarded-For" => Some(xff.as_slice()),
            "X-Real-IP" => real.as_deref(),
            _ => None,
        });
        assert_eq!(got, case["ip"].as_str().unwrap(), "{case}");
    }
}

#[test]
fn trusted_proxy_validation_errors_match_go_text() {
    for case in fixture()["load_errors"].as_array().unwrap() {
        let yaml = case["yaml"].as_str().unwrap();
        // The catalog sources were recorded on Linux, and filepath.IsAbs depends on the
        // OS; the Windows rules are validate.rs's absolute-path table.
        if cfg!(windows) && yaml.contains("models") {
            continue;
        }
        let got = Config::parse(yaml).err().map(|e| e.to_string()).unwrap_or_default();
        // Errors Go finds while decoding carry LoadConfig's wrapper; yaml.v3's own
        // decode messages (line numbers, Go type names) are not ported, only the refusal.
        let want = case["error"].as_str().unwrap();
        match want.strip_prefix("failed to parse config file: ") {
            Some(yaml_error) if yaml_error.starts_with("yaml: ") => assert!(!got.is_empty(), "{yaml}"),
            Some(decoded) => assert_eq!(got, decoded, "{yaml}"),
            None => assert_eq!(got, want, "{yaml}"),
        }
    }
}

/// Go records OAuth-only fields by legacy name; cook-router by v8 path. Go's prefix
/// table for `oauth.providers` (internal/config/config_v8.go buildV8Paths) maps them.
/// Since Go 52d5507d, the shared Codex, Claude and xAI settings live under
/// `upstream.*`, and Go records only fields whose current path stays under
/// `oauth.providers.` (config_v8.go:259-264).
#[test]
fn oauth_only_presence_matches_go() {
    const PREFIXES: &[(&str, &str)] = &[
        ("ws-auth", "oauth.providers.aistudio.ws-auth"),
        ("codex", "oauth.providers.codex"),
        ("codex-header-defaults", "oauth.providers.codex.header-defaults"),
        ("claude", "upstream.claude"),
        ("claude-code", "upstream.claude"),
        ("disable-claude-cloak-mode", "upstream.claude.disable-claude-cloak-mode"),
        ("claude-header-defaults", "upstream.claude.header-defaults"),
        ("antigravity", "oauth.providers.antigravity"),
        (
            "antigravity-signature-cache-enabled",
            "oauth.providers.antigravity.signature-cache-enabled",
        ),
        (
            "antigravity-signature-bypass-strict",
            "oauth.providers.antigravity.signature-bypass-strict",
        ),
        (
            "quota-exceeded.antigravity-credits",
            "oauth.providers.antigravity.antigravity-credits",
        ),
        ("xai", "upstream.xai"),
        ("devin", "oauth.providers.devin"),
    ];
    let to_v8 = |old: &str| {
        PREFIXES
            .iter()
            .find(|(p, _)| old == *p || old.starts_with(&format!("{p}.")))
            .map(|(p, current)| format!("{current}{}", &old[p.len()..]))
            .unwrap_or_else(|| panic!("no v8 prefix for {old}"))
    };
    let cases = fixture()["oauth_only"].as_array().unwrap().clone();
    assert_eq!(cases.len(), 6);
    for case in &cases {
        let yaml = case["yaml"].as_str().unwrap();
        let want: std::collections::BTreeSet<String> = case["fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| to_v8(f.as_str().unwrap()))
            .collect();
        assert_eq!(Config::parse(yaml).unwrap().oauth_only, want, "{yaml}");
    }
    // Go `ForAPIKey`: those fields read as zero for API-key credentials; the shared
    // `upstream.codex` value written at its historical path stays.
    let cfg = Config::parse(cases[1]["yaml"].as_str().unwrap()).unwrap();
    let view = cfg.for_api_key();
    assert_eq!(
        view.document["upstream"]["codex"]["disable-codex-cloaking"],
        serde_yaml_ng::Value::Bool(true)
    );
    let codex = &view.document["oauth"]["providers"]["codex"];
    assert_eq!(codex["header-defaults"]["user-agent"], serde_yaml_ng::Value::from(""));
    assert!(codex["live-media-relay"].get("ice-servers").is_none());
    assert_eq!(
        view.document["oauth"]["providers"]["aistudio"]["ws-auth"],
        serde_yaml_ng::Value::Bool(false)
    );
    assert!(view.oauth_only.is_empty());
    let legacy = Config::parse(cases[0]["yaml"].as_str().unwrap()).unwrap();
    assert!(matches!(legacy.for_api_key(), std::borrow::Cow::Borrowed(_)));
}

/// Go's shape: prefix/proxy_url are Auth fields, hashes are not ported, and the
/// scheduler-only metadata copies are Rust additions on config-backed credentials.
fn go_shape(c: &Credential, root: &Path) -> Value {
    let mut attrs = c.attributes.clone();
    let prefix = attrs.remove("prefix").unwrap_or_default();
    let proxy = attrs.remove("proxy_url").unwrap_or_default();
    let mut meta = c.metadata.clone();
    let mut c = c.clone();
    if let Source::File(path) = &c.source {
        let rel = path.strip_prefix(root).unwrap();
        let placeholder = Path::new("/fixture-root").join(rel);
        for key in ["path", "source"] {
            attrs.insert(key.into(), placeholder.display().to_string());
        }
        c.source = Source::File(placeholder);
    } else {
        meta.remove("excluded_models");
        meta.remove("model_aliases");
        // Go's registry reads `models` from config by index; Rust carries them along.
        meta.remove("models");
    }
    c.attributes = attrs.clone();
    json!({
        "id": c.id, "provider": c.provider, "label": c.label, "prefix": prefix, "proxy_url": proxy,
        "disabled": c.disabled, "auth_index": credentials::auth_index(&c),
        "attributes": attrs, "metadata": meta,
    })
}

fn go_expected(v: &Value) -> Value {
    let mut attrs: BTreeMap<String, Value> = serde_json::from_value(v["attributes"].clone()).unwrap();
    attrs.remove("models_hash");
    attrs.remove("excluded_models_hash");
    attrs.remove("file_name");
    json!({
        "id": v["id"], "provider": v["provider"], "label": v["label"], "prefix": v["prefix"],
        "proxy_url": v["proxy_url"], "disabled": v["disabled"], "auth_index": v["auth_index"],
        "attributes": attrs, "metadata": v["metadata"],
    })
}

#[test]
fn config_and_file_credentials_match_go_synthesizers() {
    let mut compared = 0;
    for case in fixture()["synth"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let dir = std::env::temp_dir().join(format!("cpa-synth-{name}-{}", std::process::id()));
        let root = dir.join("fixture-root");
        std::fs::create_dir_all(root.join("auth")).unwrap();
        for (file, body) in case["files"].as_object().into_iter().flatten() {
            std::fs::write(root.join("auth").join(file), body.as_str().unwrap()).unwrap();
        }
        let loaded = Config::parse(case["yaml"].as_str().unwrap());
        if case["error"].is_string() {
            assert!(loaded.is_err(), "{name}: Go rejected this config");
            continue;
        }
        let mut cfg = loaded.unwrap();
        cfg.auth_dir = root.join("auth");
        let got: Vec<Value> = credentials::from_config(&cfg)
            .iter()
            .map(|c| go_shape(c, &root))
            .collect();
        let want: Vec<Value> = case["config"].as_array().unwrap().iter().map(go_expected).collect();
        assert_eq!(got, want, "{name}: config credentials");
        compared += got.len();
        let got: Vec<Value> = credentials::from_auth_dir(&cfg)
            .iter()
            .map(|c| go_shape(c, &root))
            .collect();
        let want: Vec<Value> = case["file"].as_array().unwrap().iter().map(go_expected).collect();
        assert_eq!(got, want, "{name}: file credentials");
        compared += got.len();
        let _ = std::fs::remove_dir_all(&dir);
    }
    assert_eq!(compared, 32, "every recorded Go credential was compared");
}

mod access {
    use super::*;
    use cpa_exec::Executors;
    use cpa_exec::claude::ClaudeExecutor;
    use cpa_server::management::{self, Management, Options};
    use std::sync::Arc;

    /// Serves the real management router; `X-Test-Peer` stands in for the socket peer.
    pub(super) async fn serve(state: Arc<Management>) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let app = management::router(state).layer(axum::middleware::from_fn(
            |mut req: axum::extract::Request, next: axum::middleware::Next| async move {
                let peer: SocketAddr = req.headers()["x-test-peer"].to_str().unwrap().parse().unwrap();
                req.extensions_mut().insert(axum::extract::ConnectInfo(peer));
                next.run(req).await
            },
        ));
        (
            base,
            tokio::spawn(async move { axum::serve(listener, app).await.unwrap() }),
        )
    }

    fn state(dir: &Path, scenario: &Value) -> Arc<Management> {
        std::fs::create_dir_all(dir).unwrap();
        let mut yaml = format!(
            "config-version: 8\nmanagement:\n  allow-remote: {}\n",
            scenario["allow_remote"]
        );
        if let Some(secret) = scenario["secret"].as_str() {
            yaml += &format!("  secret-key: '{}'\n", bcrypt::hash(secret, 4).unwrap());
        }
        if let Some(t) = scenario["trusted"].as_array() {
            yaml += &format!("server:\n  trusted-proxies: {}\n", Value::Array(t.clone()));
        }
        yaml += &format!("oauth:\n  auth-dir: '{}'\n", dir.join("auth").display());
        let store = Arc::new(ConfigStore::memory_with(&yaml));
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
        let options = Options {
            local_password: scenario["local_password"].as_str().unwrap_or_default().into(),
            management_password: Some(scenario["env"].as_str().unwrap_or_default().into()),
            ..Options::default()
        };
        Management::with_options(rt, store, options)
    }

    #[tokio::test]
    async fn every_go_access_scenario_replays_through_the_router() {
        let client = wreq::Client::new();
        let mut steps = 0;
        for scenario in fixture()["access"].as_array().unwrap() {
            let name = scenario["name"].as_str().unwrap();
            let dir = std::env::temp_dir().join(format!("cpa-access-{name}-{}", std::process::id()));
            let (base, server) = serve(state(&dir, scenario)).await;
            for (i, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
                // HTTP parsers (Go's textproto and hyper) trim header whitespace, so
                // httptest-only values are covered by unit tests instead.
                let headers = step["headers"].as_object();
                if headers.into_iter().flatten().any(|(_, vs)| {
                    vs.as_array()
                        .unwrap()
                        .iter()
                        .any(|v| v.as_str().unwrap().ends_with(' '))
                }) {
                    continue;
                }
                let mut req = client
                    .get(format!("{base}/admin/v1/effective/config"))
                    .header("X-Test-Peer", step["remote"].as_str().unwrap());
                for (k, values) in step["headers"].as_object().into_iter().flatten() {
                    for v in values.as_array().unwrap() {
                        // Raw bytes, so non-ASCII values travel as obs-text like Go's.
                        let value = wreq::header::HeaderValue::from_bytes(v.as_str().unwrap().as_bytes()).unwrap();
                        req = req.header(k.as_str(), value);
                    }
                }
                let res = req.send().await.unwrap();
                let status = res.status().as_u16();
                let version = res.headers().contains_key("x-cpa-version");
                let body = res.text().await.unwrap();
                assert_eq!(status, step["status"], "{name}[{i}] {body}");
                if status != 200 {
                    if matches!(status, 401 | 403) {
                        assert_eq!(
                            serde_json::from_str::<Value>(&body).unwrap(),
                            admin_auth_body(step["body"].as_str().unwrap(), status),
                            "{name}[{i}]"
                        );
                    } else {
                        assert_eq!(body, step["body"].as_str().unwrap(), "{name}[{i}]");
                    }
                }
                assert_eq!(version, step["x_cpa_version"] != "", "{name}[{i}] version header");
                steps += 1;
            }
            server.abort();
            let _ = std::fs::remove_dir_all(&dir);
        }
        assert_eq!(steps, 70, "71 recorded steps, one not wire-representable");
    }
}

mod routes {
    use super::*;
    use cpa_exec::Executors;
    use cpa_exec::claude::ClaudeExecutor;
    use cpa_server::management::{Management, Options};
    use cpa_server::watching;
    use std::sync::Arc;

    #[tokio::test]
    async fn go_server_routing_preflight_and_availability_replay() {
        let hash = bcrypt::hash("fake-secret", 4).unwrap();
        let client = wreq::Client::builder()
            .redirect(wreq::redirect::Policy::none())
            .build()
            .unwrap();
        let mut compared = 0;
        for scenario in fixture()["routes"].as_array().unwrap() {
            let name = scenario["name"].as_str().unwrap();
            let dir = std::env::temp_dir().join(format!("cpa-routes-{name}-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let auth = dir.join("auth");
            let yaml = |text: &str| format!("{}\nauth-dir: '{}'\n", text.replace("$HASH", &hash), auth.display());
            let store = Arc::new(ConfigStore::memory_with(&yaml(scenario["yaml"].as_str().unwrap())));
            let cfg = store.load().unwrap().config;
            let rt = Arc::new(cpa_server::testing::runtime(
                cfg,
                vec![],
                Executors {
                    claude: ClaudeExecutor::new("http://127.0.0.1:1").unwrap(),
                    codex: Default::default(),
                    devices: Default::default(),
                    openai: Default::default(),
                    google: Default::default(),
                },
            ));
            let state = Management::with_options(
                rt,
                store,
                Options {
                    local_password: scenario["local_password"].as_str().unwrap_or_default().into(),
                    management_password: Some(scenario["env"].as_str().unwrap_or_default().into()),
                    ..Options::default()
                },
            );
            let (base, server) = super::access::serve(state.clone()).await;
            for (i, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
                let mut step = step.clone();
                if name == "local_password_only_until_reload" && i == 1 {
                    assert_eq!(step["update"], scenario["yaml"]);
                    assert_eq!(step["status"], 404);
                    // Reimporting identical YAML creates no SQLite revision, so it
                    // cannot trigger Go's former watched-file availability change.
                    for key in ["status", "resp_body", "resp_headers"] {
                        step[key] = scenario["steps"][0][key].clone();
                    }
                }
                if let Some(update) = step["update"].as_str() {
                    state.config_store().import_yaml(&yaml(update), "test", "").unwrap();
                    watching::reload(&state).unwrap();
                }
                let method: wreq::Method = step["method"].as_str().unwrap().parse().unwrap();
                let mut req = client
                    .request(method, format!("{base}{}", step["path"].as_str().unwrap()))
                    .header("X-Test-Peer", step["remote"].as_str().unwrap());
                for (k, values) in step["headers"].as_object().into_iter().flatten() {
                    for v in values.as_array().unwrap() {
                        req = req.header(k.as_str(), v.as_str().unwrap());
                    }
                }
                let res = req.send().await.unwrap();
                let status = res.status().as_u16();
                let mut headers = serde_json::Map::new();
                for name in [
                    "Content-Type",
                    "Cache-Control",
                    "Access-Control-Allow-Origin",
                    "Access-Control-Allow-Methods",
                    "Access-Control-Allow-Headers",
                    "Access-Control-Expose-Headers",
                    "X-CPA-SUPPORT-PLUGIN",
                    "X-CPA-COMMIT",
                    "X-CPA-BUILD-DATE",
                ] {
                    if let Some(v) = res.headers().get(name) {
                        headers.insert(name.into(), v.to_str().unwrap().into());
                    }
                }
                if res.headers().contains_key("x-cpa-version") {
                    headers.insert("X-CPA-VERSION".into(), "present".into());
                }
                assert!(!res.headers().contains_key("allow"), "{name}[{i}]: gin sends no Allow");
                let body = res.text().await.unwrap();
                assert_eq!(status, step["status"], "{name}[{i}] {body}");
                if status != 200 {
                    if step["path"].as_str().unwrap().starts_with("/admin/v1/") && matches!(status, 401 | 403) {
                        assert_eq!(
                            serde_json::from_str::<Value>(&body).unwrap(),
                            admin_auth_body(step["resp_body"].as_str().unwrap(), status),
                            "{name}[{i}]"
                        );
                    } else {
                        assert_eq!(body, step["resp_body"].as_str().unwrap(), "{name}[{i}]");
                    }
                }
                let mut want = step["resp_headers"].as_object().unwrap().clone();
                if step["path"].as_str().unwrap().starts_with("/admin/v1/") && matches!(status, 401 | 403) {
                    want.insert("Content-Type".into(), "application/json".into());
                    want.insert("Cache-Control".into(), "no-store".into());
                }
                // The goldens come from Go's cgo build, which loads native plugins; this
                // binary does too, except on Windows.
                if want.contains_key("X-CPA-SUPPORT-PLUGIN") {
                    want.insert("X-CPA-SUPPORT-PLUGIN".into(), cpa_plugin::SUPPORT_PLUGIN.into());
                }
                assert_eq!(Value::Object(headers), Value::Object(want), "{name}[{i}] headers");
                compared += 1;
            }
            server.abort();
            let _ = std::fs::remove_dir_all(&dir);
        }
        assert_eq!(compared, 19);
    }
}

mod creds {
    use super::*;
    use cpa_exec::Executors;
    use cpa_exec::claude::ClaudeExecutor;

    use cpa_server::management::{Management, Options};
    use std::collections::HashMap;
    use std::sync::Arc;

    const TIMES: &[&str] = &[
        "observed_at",
        "modtime",
        "created_at",
        "updated_at",
        "last_refresh",
        "retry_at",
    ];

    /// Per-side values that cannot match: auth indexes (path-derived), timestamps,
    /// sizes (Go rewrites files with sorted keys) and local bucket labels.
    fn normalize(v: &Value, names: &HashMap<String, String>) -> Value {
        match v {
            Value::Object(m) => Value::Object(
                m.iter()
                    .map(|(k, v)| {
                        let v = match (k.as_str(), v) {
                            (t, Value::String(_)) if TIMES.contains(&t) => json!("<time>"),
                            ("size", Value::Number(_)) => json!("<size>"),
                            ("time", Value::String(_)) => json!("<label>"),
                            ("auth_index", Value::String(s)) => {
                                json!(format!(
                                    "<index:{}>",
                                    names.get(s).cloned().unwrap_or_else(|| s.clone())
                                ))
                            }
                            _ => normalize(v, names),
                        };
                        (k.clone(), v)
                    })
                    .collect(),
            ),
            Value::Array(a) => Value::Array(a.iter().map(|v| normalize(v, names)).collect()),
            other => other.clone(),
        }
    }

    /// Go decodes JSON numbers as float64, so `1.0` and `1` are the same value.
    fn go_numbers(v: &Value) -> Value {
        match v {
            Value::Number(n) => match n.as_f64() {
                Some(f) if f.fract() == 0.0 && f.abs() < 9e15 => json!(f as i64),
                _ => v.clone(),
            },
            Value::Object(m) => Value::Object(m.iter().map(|(k, v)| (k.clone(), go_numbers(v))).collect()),
            Value::Array(a) => Value::Array(a.iter().map(go_numbers).collect()),
            other => other.clone(),
        }
    }

    fn config_credentials(config: &Value) -> Vec<Value> {
        let yaml = serde_yaml_ng::to_string(config).unwrap();
        let cfg = Config::parse(&yaml).unwrap();
        credentials::from_config(&cfg)
            .iter()
            .map(|c| json!({"id": c.id, "provider": c.provider, "attributes": c.attributes}))
            .collect()
    }

    #[tokio::test]
    async fn go_credential_management_replay() {
        let hash = bcrypt::hash("fake-secret", 4).unwrap();
        let client = wreq::Client::new();
        let mut compared = 0;
        let mut bytes_compared = 0;
        for scenario in fixture()["credentials"].as_array().unwrap() {
            let name = scenario["name"].as_str().unwrap();
            if name == "dashboard_probes" {
                continue;
            }
            let log_files = scenario["log_files"].as_array();
            let dir = std::env::temp_dir().join(format!("cpa-creds-{name}-{}", std::process::id()));
            let root = dir.join("fixture-root");
            let auth = root.join("auth");
            std::fs::create_dir_all(&auth).unwrap();
            for (file, body) in scenario["auth_files"].as_object().unwrap() {
                std::fs::write(auth.join(file), body.as_str().unwrap()).unwrap();
            }
            let log_dir = root.join("logs");
            for file in log_files.into_iter().flatten() {
                std::fs::create_dir_all(&log_dir).unwrap();
                put_log(&log_dir, file, false);
            }
            let yaml = scenario["yaml"]
                .as_str()
                .unwrap()
                .replace("$HASH", &hash)
                .replace("$AUTH", &auth.display().to_string());
            let store = Arc::new(ConfigStore::memory_with(&yaml));
            let cfg = store.load().unwrap().config;
            let scan = credentials::scan_auth_dir(&cfg);
            let mut loaded = scan.credentials;
            loaded.extend(credentials::from_config(&cfg));
            let rt = Arc::new(cpa_server::testing::runtime(
                cfg.clone(),
                loaded,
                Executors {
                    claude: ClaudeExecutor::new("http://127.0.0.1:1").unwrap(),
                    codex: Default::default(),
                    devices: Default::default(),
                    openai: Default::default(),
                    google: Default::default(),
                },
            ));
            // As the binary records what it loaded.
            rt.store()
                .note_loaded(&rt.store().credential_backend().scan(&rt.config()).unwrap().read);
            // Runtime-only credentials, registered as the `/v1/ws` relay does.
            for id in scenario["runtime_auths"].as_array().into_iter().flatten() {
                let id = id.as_str().unwrap();
                assert!(rt.store().add_runtime(Credential::relay_session(id)));
                // Go seeds a fileless auth's index from its ID.
                let added = rt.store().get(id).unwrap();
                assert_eq!(
                    json!(credentials::auth_index(&added)),
                    scenario["indexes"][id],
                    "{name}: auth_index"
                );
            }
            let options = Options {
                management_password: Some(String::new()),
                log_dir: Some(log_dir.clone()),
                // Go parsed log line timestamps in UTC: the generator runs with TZ=UTC.
                log_zone: chrono::FixedOffset::east_opt(0),
                ..Options::default()
            };
            let state = Management::with_options(rt.clone(), store.clone(), options);
            let (base, server) = super::access::serve(state).await;
            // index -> name, for each side.
            let go_names: HashMap<String, String> = scenario["indexes"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(n, i)| (i.as_str().unwrap().to_owned(), n.clone()))
                .collect();
            let rust_name = |c: &cpa_core::credential::Credential| match &c.source {
                Source::File(p) => p.file_name().unwrap().to_string_lossy().into_owned(),
                Source::Config { .. } | Source::Runtime => c.id.clone(),
            };
            let mut rust_names: HashMap<String, String> = rt
                .store()
                .snapshot()
                .iter()
                .map(|c| (credentials::auth_index(c), rust_name(c)))
                .collect();
            // Go's generator keeps the last config credential it registered.
            let cfg_id = rt
                .store()
                .snapshot()
                .iter()
                .rfind(|c| matches!(c.source, Source::Config { .. }))
                .map(|c| c.id.clone())
                .unwrap_or_default();
            let (echo_url, echo_server) = if scenario["echo"] == true {
                let (url, handle) = echo::serve().await;
                (url, Some(handle))
            } else {
                ("http://echo.invalid".to_owned(), None)
            };
            let resolve = |text: &str, names: &HashMap<String, String>| {
                let mut text = text.replace("$ECHO", &echo_url).replace("$CFGID", &cfg_id);
                for (index, name) in names {
                    text = text.replace(&format!("$INDEX({name})"), index);
                }
                text
            };
            let mut last_state = "no-state".to_owned();
            let mut last_cursor = "no-cursor".to_owned();
            for (i, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
                let at = format!("{name}[{i}] {} {}", step["method"], step["path"]);
                let step = &pin_pending_steps(step.clone(), name, i, &at);
                if let Some(ms) = step["sleep_ms"].as_u64() {
                    tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
                }
                if let Some(file) = step.get("append_log") {
                    put_log(&log_dir, file, true);
                }
                let method: wreq::Method = step["method"].as_str().unwrap().parse().unwrap();
                let req_path = resolve(step["path"].as_str().unwrap(), &rust_names)
                    .replace("$STATE", &last_state)
                    .replace("$CURSOR", &last_cursor);
                let mut req = client
                    .request(method, format!("{base}/v8/management{req_path}"))
                    .header("X-Test-Peer", "127.0.0.1:1")
                    .bearer_auth("fake-secret")
                    .body(
                        resolve(step["body"].as_str().unwrap_or_default(), &rust_names).replace("$STATE", &last_state),
                    );
                if let Some(ct) = step["content_type"].as_str() {
                    req = req.header("Content-Type", ct);
                }
                let res = req.send().await.unwrap();
                let status = res.status().as_u16();
                let headers: HashMap<String, String> = ["Content-Type", "Content-Disposition"]
                    .iter()
                    .filter_map(|h| Some((h.to_string(), res.headers().get(*h)?.to_str().ok()?.to_owned())))
                    .collect();
                let body = res
                    .text()
                    .await
                    .unwrap()
                    .replace(&rt.config().auth_dir.display().to_string(), "/fixture-root/auth")
                    .replace(&root.display().to_string(), "/fixture-root")
                    .replace(&echo_url, "$ECHO");
                assert_eq!(status, step["status"], "{at}: {body}");
                // New credentials (uploads) get indexes on both sides.
                for c in rt.store().snapshot().iter() {
                    rust_names
                        .entry(credentials::auth_index(c))
                        .or_insert_with(|| rust_name(c));
                }
                if let Some(raw) = step["raw_response"].as_str() {
                    assert_eq!(body, raw, "{at}");
                    let want = step["resp_headers"].as_object().unwrap();
                    for (h, v) in want {
                        // Go types `.log` from the host's MIME database; the fixture
                        // host (Linux) maps it to text/x-log, macOS has no entry.
                        if h == "Content-Type" && v == "text/x-log; charset=utf-8" && !cfg!(target_os = "linux") {
                            continue;
                        }
                        assert_eq!(headers.get(h).map(String::as_str), v.as_str(), "{at}: header {h}");
                    }
                } else {
                    let got: Value = serde_json::from_str(&body).unwrap();
                    // gin's exact bytes wherever the values agree exactly; key order always.
                    if let Some(raw) = step["raw_json"].as_str() {
                        // `recent_requests` labels are the last twenty 10-minute windows of
                        // the wall clock, so a response carrying them equals Go's recording
                        // only when the test runs in the window it was recorded in
                        // (api_call_and_usage[28], GET /observability/usage/api-keys, at
                        // 06:18 UTC). They are compared normalized below, never as bytes.
                        if got == step["response"] && !raw.contains(r#""recent_requests":"#) {
                            assert_eq!(body, raw, "{at}: bytes");
                            bytes_compared += 1;
                        }
                        let go_raw: Value = serde_json::from_str(raw).unwrap();
                        same_key_order(&go_raw, &got, &at).unwrap();
                    }
                    if req_path.starts_with("/oauth/auth-url")
                        && let Some(state) = got["state"].as_str()
                    {
                        last_state = state.to_owned();
                    }
                    if let Some(cursor) = got["next-cursor"].as_str().filter(|c| !c.is_empty()) {
                        last_cursor = cursor.to_owned();
                    }
                    // Log routes compare exactly: sizes, mtimes and cursors are fixed.
                    if req_path.starts_with("/observability/logs") {
                        assert_eq!(got, step["response"], "{at}");
                    }
                    let mut want = normalize(&step["response"], &go_names);
                    let mut got = normalize(&got, &rust_names);
                    // Random login state and PKCE challenge.
                    for v in [&mut want, &mut got] {
                        if let Some(url) = v.get("url").and_then(Value::as_str) {
                            let mut parsed = url::Url::parse(url).unwrap();
                            let pairs: Vec<(String, String)> = parsed
                                .query_pairs()
                                .map(|(k, val)| {
                                    let val = if k == "state" || k == "code_challenge" {
                                        format!("<{k}>")
                                    } else {
                                        val.into_owned()
                                    };
                                    (k.into_owned(), val)
                                })
                                .collect();
                            parsed.query_pairs_mut().clear().extend_pairs(pairs);
                            v["url"] = parsed.to_string().into();
                            v["state"] = "<state>".into();
                        }
                    }
                    // api-call relays the upstream's own Date header.
                    for v in [&mut want, &mut got] {
                        if let Some(h) = v.get_mut("header").and_then(Value::as_object_mut) {
                            h.remove("Date");
                        }
                    }
                    // Go's harness registers models only for runtime credentials (as its
                    // service does on connect), so the cooldown-reset fallback list of a
                    // file credential is empty there; cook-router reports the credential's
                    // registrations (none here: the credential is disabled by this step).
                    if step["path"] == "/routing/cooldown/reset" && status == 200 && scenario["runtime_auths"].is_null()
                    {
                        assert_eq!(want["models"], json!([]), "{at}: harness assumption");
                    }
                    if let Some(msg) = want["error"].as_str().filter(|m| m.starts_with("invalid auth file: ")) {
                        // JSON parser wording differs; the prefix and status are Go's.
                        assert!(
                            got["error"].as_str().unwrap().starts_with("invalid auth file: "),
                            "{at}: {msg}"
                        );
                        want["error"] = got["error"].clone();
                    }
                    if req_path == "/observability/usage/api-keys" {
                        // Translate each Go identity to the corresponding live index;
                        // comparing full maps detects swapped or missing counters.
                        let live = rt.store().snapshot();
                        for (provider, keys) in want.as_object_mut().unwrap() {
                            let mut indexed = serde_json::Map::new();
                            for (key, counters) in keys.as_object().unwrap() {
                                let credential = live
                                    .iter()
                                    .find(|c| {
                                        let attr =
                                            |name: &str| c.attributes.get(name).map(String::as_str).unwrap_or_default();
                                        let family = if attr("compat_name").is_empty() {
                                            c.provider.as_str()
                                        } else {
                                            attr("compat_name")
                                        };
                                        family.eq_ignore_ascii_case(provider)
                                            && format!("{}|{}", attr("base_url"), attr("api_key")) == *key
                                    })
                                    .unwrap_or_else(|| panic!("{at}: usage identity has no live credential"));
                                assert!(
                                    indexed
                                        .insert(credentials::auth_index(credential), counters.clone())
                                        .is_none()
                                );
                            }
                            *keys = Value::Object(indexed);
                        }
                    }
                    assert_eq!(got, want, "{at}");
                }
                // Canonical credential documents, read as Go's float64 JSON values.
                let mut files = serde_json::Map::new();
                for (path, data) in rt.store().credential_backend().documents().unwrap() {
                    let v = cpa_common::json::GoValue::parse_f64(&data)
                        .and_then(|v| serde_json::from_slice::<Value>(&v.marshal()).ok())
                        .unwrap_or_else(|| json!(format!("raw:{}", String::from_utf8_lossy(&data))));
                    files.insert(path.file_name().unwrap().to_string_lossy().into_owned(), v);
                }
                assert_eq!(
                    go_numbers(&Value::Object(files)),
                    go_numbers(&step["files"]),
                    "{at}: auth dir"
                );
                if let Some(want) = step.get("log_dir") {
                    let mut logs = serde_json::Map::new();
                    for entry in std::fs::read_dir(&log_dir).unwrap() {
                        let entry = entry.unwrap();
                        let text = std::fs::read_to_string(entry.path()).unwrap();
                        logs.insert(entry.file_name().to_string_lossy().into_owned(), text.into());
                    }
                    assert_eq!(&Value::Object(logs), want, "{at}: log dir");
                }
                for (file, raw) in step["raw_files"].as_object().into_iter().flatten() {
                    let got = String::from_utf8(
                        rt.store()
                            .credential_backend()
                            .read(&rt.config().auth_dir.join(file))
                            .unwrap()
                            .unwrap(),
                    )
                    .unwrap();
                    assert_eq!(Some(got.as_str()), raw.as_str(), "{at}: bytes of {file}");
                }
                // Config effects, compared through the credentials they synthesize.
                let rust_config = serde_json::to_value(store.load().unwrap().config.document).unwrap();
                assert_eq!(
                    config_credentials(&rust_config),
                    config_credentials(&step["config"]),
                    "{at}: config API keys"
                );
                compared += 1;
            }
            server.abort();
            if let Some(echo) = echo_server {
                echo.abort();
            }
            let _ = std::fs::remove_dir_all(&dir);
        }
        assert_eq!(compared, 222);
        eprintln!("credentials: {bytes_compared} of {compared} steps compared byte for byte");
        assert_eq!(bytes_compared, 174, "steps compared byte for byte");
    }

    /// Pending v8.0.35 drift outside the config saver. Each pin names its scenario and
    /// steps, asserts Go's recorded value there, then expects cook-router's current
    /// (6fecc6e) value in just the differing fields, so porting the change, or losing
    /// the old behaviour some other way, fails here until the pin is removed.
    fn pin_pending_steps(mut step: Value, name: &str, i: usize, at: &str) -> Value {
        let inventory = name == "credential_inventory_and_edits";
        // Each pin is keyed by step index; the request it expects keeps a re-record
        // from shifting it onto another step.
        let request = |method: &str, path: &str, body_name: Option<&str>| {
            assert_eq!(
                (step["method"].as_str(), step["path"].as_str()),
                (Some(method), Some(path)),
                "{at}"
            );
            if let Some(want) = body_name {
                let body: Value = serde_json::from_str(step["body"].as_str().unwrap()).unwrap();
                assert_eq!(body["name"], want, "{at}");
            }
        };
        match (inventory, i) {
            // The edits that first touch each codex file, and the last step.
            (true, 19) => request("PATCH", "/credentials/fields", Some("codex-b.json")),
            (true, 73) => request("PATCH", "/credentials/fields", Some("retype.json")),
            (true, 88) => request("GET", "/credentials", None),
            (true, 0) => request("GET", "/credentials", None),
            (true, 1) => request("GET", "/credentials?name=claude-a.json", None),
            _ => {}
        }
        match (name, i) {
            ("runtime_credentials", 4) => request("GET", "/credentials/models?name=aistudio-0123456789abcdef", None),
            ("runtime_credentials", 6) => request("POST", "/routing/cooldown/reset", None),
            _ => {}
        }
        // Preserve Go's recorded lock-file pins, then compare only canonical JSON
        // documents: SQLite never imports readme files or persists lock sidecars.
        if let Some(files) = step["files"].as_object_mut() {
            let mut locks: Vec<&str> = Vec::new();
            if inventory && (19..=88).contains(&i) {
                locks.push("codex-b.json.lock");
            }
            if inventory && (73..=88).contains(&i) {
                locks.push("retype.json.lock");
            }
            if name == "save_bytes" && i >= 5 {
                locks.push("raw-codex-blank.json.lock");
            }
            if name == "save_bytes" && i >= 3 {
                locks.push("raw-codex.json.lock");
            }
            // Codex uploads: saved under the lock of the file they wrote.
            for (step, lock) in [
                (22, "raw-up-codex-off.json.lock"),
                (21, "raw-up-codex-same.json.lock"),
                (20, "raw-up-codex.json.lock"),
            ] {
                if name == "save_bytes" && i >= step {
                    locks.push(lock);
                }
            }
            let mut recorded: Vec<String> = files.keys().filter(|f| f.ends_with(".lock")).cloned().collect();
            recorded.sort();
            assert_eq!(recorded, locks, "{at}: Go's lock files");
            for lock in locks {
                assert_eq!(files[lock], json!("raw:"), "{at}: {lock}");
            }
            files.retain(|name, _| name.ends_with(".json"));
        }
        step
    }

    /// Writes or appends a fixture log file and sets Go's fixed mtime
    /// (`logEpoch + mtime` seconds).
    fn put_log(dir: &std::path::Path, file: &Value, append: bool) {
        use std::io::Write;
        let path = dir.join(file["name"].as_str().unwrap());
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(append)
            .truncate(!append)
            .open(&path)
            .unwrap();
        f.write_all(file["text"].as_str().unwrap().as_bytes()).unwrap();
        let at =
            std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000 + file["mtime"].as_u64().unwrap());
        f.set_modified(at).unwrap();
    }

    /// The dashboard probes each action with input Go rejects with 400 before any
    /// I/O. Implemented routes must answer exactly like Go and leave the database and the
    /// cooldown state untouched; routes not built yet must stay an empty 404.
    #[tokio::test]
    async fn dashboard_probes_are_rejected_without_side_effects() {
        const NOT_YET: &[&str] = &[];
        let scenario = fixture()["credentials"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["name"] == "dashboard_probes")
            .unwrap()
            .clone();
        let hash = bcrypt::hash("fake-secret", 4).unwrap();
        let dir = std::env::temp_dir().join(format!("cpa-probes-{}", std::process::id()));
        let auth = dir.join("fixture-root").join("auth");
        std::fs::create_dir_all(&auth).unwrap();
        for (file, body) in scenario["auth_files"].as_object().unwrap() {
            std::fs::write(auth.join(file), body.as_str().unwrap()).unwrap();
        }
        let yaml = scenario["yaml"]
            .as_str()
            .unwrap()
            .replace("$HASH", &hash)
            .replace("$AUTH", &auth.display().to_string());
        let store = Arc::new(ConfigStore::memory_with(&yaml));
        let cfg = store.load().unwrap().config;
        let rt = Arc::new(cpa_server::testing::runtime(
            cfg.clone(),
            credentials::load(&cfg),
            Executors {
                claude: ClaudeExecutor::new("http://127.0.0.1:1").unwrap(),
                codex: Default::default(),
                devices: Default::default(),
                openai: Default::default(),
                google: Default::default(),
            },
        ));
        let options = Options {
            management_password: Some(String::new()),
            ..Options::default()
        };
        let before_config = store.load().unwrap().config.document;
        let (base, server) = super::access::serve(Management::with_options(rt.clone(), store.clone(), options)).await;
        let before = rt.store().credential_backend().documents().unwrap();
        let creds_before: Vec<(String, u64)> = rt
            .store()
            .snapshot()
            .iter()
            .map(|c| (c.id.clone(), c.revision))
            .collect();
        let client = wreq::Client::new();
        let mut implemented = 0;
        for step in scenario["steps"].as_array().unwrap() {
            let at = format!("{} {}", step["method"], step["path"]);
            let method: wreq::Method = step["method"].as_str().unwrap().parse().unwrap();
            let mut req = client
                .request(
                    method,
                    format!("{base}/v8/management{}", step["path"].as_str().unwrap()),
                )
                .header("X-Test-Peer", "127.0.0.1:1")
                .bearer_auth("fake-secret");
            if let Some(body) = step["body"].as_str() {
                req = req.header("Content-Type", "application/json").body(body.to_owned());
            }
            let res = req.send().await.unwrap();
            let status = res.status().as_u16();
            let body = res.text().await.unwrap();
            let route = step["path"].as_str().unwrap().split('?').next().unwrap();
            if status == 404 && body.is_empty() {
                assert!(
                    NOT_YET.contains(&route),
                    "{at}: implemented routes must answer the probe"
                );
            } else {
                assert!(!NOT_YET.contains(&route), "{at}: now implemented; drop it from NOT_YET");
                assert_eq!(status, step["status"], "{at}: {body}");
                assert_eq!(serde_json::from_str::<Value>(&body).unwrap(), step["response"], "{at}");
                implemented += 1;
            }
            assert_eq!(
                rt.store().credential_backend().documents().unwrap(),
                before,
                "{at}: probe changed credential documents"
            );
            assert_eq!(
                store.load().unwrap().config.document,
                before_config,
                "{at}: probe changed config"
            );
            let creds_now: Vec<(String, u64)> = rt
                .store()
                .snapshot()
                .iter()
                .map(|c| (c.id.clone(), c.revision))
                .collect();
            assert_eq!(creds_now, creds_before, "{at}: probe changed credentials");
        }
        assert_eq!(implemented, 9);
        server.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// The api-call upstream: the same reports as `echoHandler` in the Go generator, so
/// each side records what its own client sent.
mod echo {
    use axum::body::Bytes;
    use axum::http::{HeaderMap, Method, StatusCode, Uri, header};
    use axum::response::{IntoResponse, Response};
    use serde_json::{Map, Value, json};
    use std::collections::BTreeMap;

    pub(super) async fn serve() -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let own = addr.clone();
        let app = axum::Router::new().fallback(move |method: Method, uri: Uri, headers: HeaderMap, body: Bytes| {
            let own = own.clone();
            async move { handle(&own, method, uri, headers, body) }
        });
        let handle = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{addr}"), handle)
    }

    fn handle(own: &str, method: Method, uri: Uri, headers: HeaderMap, body: Bytes) -> Response {
        match uri.path() {
            "/redirect" => return (StatusCode::FOUND, [(header::LOCATION, "/echo?from=redirect")]).into_response(),
            "/redirect307" => {
                return (StatusCode::TEMPORARY_REDIRECT, [(header::LOCATION, "/echo?from=307")]).into_response();
            }
            "/chunked" => {
                let parts = futures_util::stream::iter([
                    Ok::<_, std::io::Error>(Bytes::from_static(b"part")),
                    Ok(Bytes::from_static(b"two")),
                ]);
                return (
                    [(header::CONTENT_TYPE, "text/plain"), (header::TRAILER, "X-Foo")],
                    axum::body::Body::from_stream(parts),
                )
                    .into_response();
            }
            "/status" => {
                let mut res = (StatusCode::IM_A_TEAPOT, &b"teapot\xff"[..]).into_response();
                let h = res.headers_mut();
                h.insert(header::CONTENT_TYPE, "text/plain".parse().unwrap());
                h.append("x-multi", "a".parse().unwrap());
                h.append("x-multi", "b".parse().unwrap());
                return res;
            }
            _ => {}
        }
        let mut seen = BTreeMap::new();
        for name in [
            "Authorization",
            "X-Custom",
            "Content-Type",
            "User-Agent",
            "Content-Length",
            "Accept-Encoding",
            "Referer",
        ] {
            let values: Vec<Value> = headers
                .get_all(name)
                .iter()
                .map(|v| Value::from(String::from_utf8_lossy(v.as_bytes()).into_owned()))
                .collect();
            if !values.is_empty() {
                seen.insert(name, Value::Array(values));
            }
        }
        let host = headers
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .unwrap_or_default();
        let host = if host == own { "<listener>" } else { host };
        let length: i64 = headers
            .get(header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok()?.parse().ok())
            .unwrap_or(0);
        // Go's json.Encoder: sorted keys, compact, trailing newline.
        let mut out = Map::new();
        out.insert("body".into(), String::from_utf8_lossy(&body).into_owned().into());
        out.insert("content_length".into(), length.into());
        out.insert("headers".into(), json!(seen));
        out.insert("host".into(), host.into());
        out.insert("method".into(), method.as_str().into());
        out.insert("path".into(), uri.path().into());
        out.insert("query".into(), uri.query().unwrap_or_default().into());
        let text = format!("{}\n", Value::Object(out));
        ([(header::CONTENT_TYPE, "application/json")], text).into_response()
    }
}
