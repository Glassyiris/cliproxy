use super::*;
use serde_json::json;

/// Every config the Go config-diff fixture holds, plus one with every split-out
/// list, legacy flat keys and OAuth-only provider settings.
fn corpus() -> Vec<String> {
    let fixture: Json =
        serde_json::from_str(include_str!("../../../tests/fixtures/config_diff_go.json")).expect("fixture JSON");
    let mut out: Vec<String> = fixture
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|case| [&case["old"], &case["new"]])
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect();
    out.push(
        r#"
port: 8317
api-keys: [client-a, client-b]
auth-dir: /tmp/cook-test-auth
codex:
  disable-codex-cloaking: true
oauth:
  providers:
    codex:
      response-steering: true
      header-defaults: {user-agent: "codex-cli/1"}
upstream:
  claude: {tool-search: true}
claude-api-key:
  - api-key: sk-a
    base-url: https://a.example.invalid
    models: [{name: claude-x, alias: x}]
openai-compatibility:
  - name: router
    base-url: https://r.example.invalid/v1
    api-key-entries: [{api-key: sk-r}]
model-routers:
  - {name: smart, judge: router/jev}
requests:
  payload:
    default:
      - models: [{name: "gpt-*"}]
        params: {"reasoning.effort": high, when: 2001-12-14}
plugins:
  enabled: true
  configs:
    acme: {enabled: true, ratio: 1.5}
"#
        .to_owned(),
    );
    out
}

#[test]
fn an_imported_config_compiles_to_what_the_file_loads_to() {
    for text in corpus() {
        let Ok(original) = Config::parse(&text) else { continue };
        let resources = import_yaml(&text).unwrap_or_else(|e| panic!("import failed: {e:#}\n{text}"));
        let (compiled, _) = config(&resources).unwrap_or_else(|e| panic!("compile failed: {e}\n{text}"));
        let mut want = original.clone();
        let mut got = compiled;
        // A plaintext management key is stored hashed; everything else is the same.
        if !want.management.secret_key.is_empty() && !cpa_core::config::is_bcrypt(&want.management.secret_key) {
            assert!(bcrypt::verify(&want.management.secret_key, &got.management.secret_key).unwrap());
            want.management.secret_key.clear();
            got.management.secret_key.clear();
            for c in [&mut want, &mut got] {
                if let Some(m) = c
                    .document
                    .get_mut("management")
                    .and_then(serde_yaml_ng::Value::as_mapping_mut)
                {
                    m.remove("secret-key");
                }
            }
        }
        // A file in the v8 layout keeps its scope exactly. Flat legacy settings that
        // land under `oauth.providers` apply to sign-ins only (the import warns);
        // nothing loses its scope.
        let raw: serde_yaml_ng::Value = serde_yaml_ng::from_str(&text).unwrap_or_default();
        let keys = |v: &serde_yaml_ng::Value| -> std::collections::BTreeSet<String> {
            v.as_mapping()
                .into_iter()
                .flatten()
                .filter_map(|(k, _)| k.as_str().map(str::to_owned))
                .filter(|k| k != "config-version")
                .collect()
        };
        if keys(&raw) == keys(&want.document) {
            assert_eq!(got.oauth_only, want.oauth_only, "{text}");
        } else {
            assert!(got.oauth_only.is_superset(&want.oauth_only), "{text}");
            for c in [&mut want, &mut got] {
                c.oauth_only.clear();
            }
        }
        assert_eq!(got.api_keys, want.api_keys, "{text}");
        assert_eq!(got.routing, want.routing, "{text}");
        assert_eq!((got.host.clone(), got.port), (want.host.clone(), want.port), "{text}");
        assert_eq!(got.auth_dir, want.auth_dir, "{text}");
        // The import drops what the schema does not know; the rest is the same.
        let mut known = cpa_core::config::ConfigDocument::unmigrated(want.document.clone());
        known.archive_unknown();
        let mut known = serde_json::to_value(cpa_core::config::AsJson(known.value())).unwrap();
        drop_unknown_fields(&mut known);
        assert_eq!(
            serde_json::to_value(cpa_core::config::AsJson(&got.document)).unwrap(),
            known,
            "{text}"
        );
    }
}

#[test]
fn a_document_splits_back_into_the_same_resources() {
    for text in corpus() {
        let Ok(resources) = import_yaml(&text) else { continue };
        let doc = document(&resources, true);
        let again = split(&doc, &resources).unwrap();
        assert_eq!(again, resources, "{text}");
    }
}

fn provider(id: &str, family: &str, key: &str) -> Resource {
    Resource::new(
        Kind::Provider,
        id,
        0,
        json!({"type": family, "base-url": "https://x.example.invalid", "keys": [{"api-key": key}]}),
    )
}

#[test]
fn entries_keep_their_ids_through_an_edited_document() {
    let mut a = provider("main", "claude", "sk-1");
    let mut b = provider("spare", "claude", "sk-2");
    b.ord = 1;
    a.description = "primary".into();
    let key = Resource::new(Kind::ClientKey, "laptop", 0, json!({"key": "ck-1"}));
    let old = vec![a, b, key];
    let mut doc = document(&old, true);
    // Swap the two providers and add a client key in front.
    let list = doc.pointer_mut("/api-keys/claude").unwrap().as_array_mut().unwrap();
    list.swap(0, 1);
    let keys = doc.pointer_mut("/access/api-keys").unwrap().as_array_mut().unwrap();
    keys.insert(0, json!("ck-0"));
    let split = split(&doc, &old).unwrap();
    let find = |kind, id: &str| split.iter().find(|r| r.kind == kind && r.id == id).unwrap();
    assert_eq!(find(Kind::Provider, "spare").ord, 0);
    assert_eq!(find(Kind::Provider, "main").ord, 1);
    assert_eq!(find(Kind::Provider, "main").description, "primary");
    assert_eq!(find(Kind::ClientKey, "laptop").ord, 1);
    assert_eq!(find(Kind::ClientKey, "key-1").spec, json!({"key": "ck-0"}));
}

#[test]
fn secrets_are_hidden_in_history_and_kept_on_write_back() {
    let stored = provider("main", "claude", "sk-live");
    let hidden = redacted(&stored);
    assert_eq!(hidden.spec["keys"][0]["api-key"], SECRET);
    // Reads show provider keys: the dashboard matches usage by them.
    assert_eq!(for_read(&stored).spec, stored.spec);
    let mut back = hidden.clone();
    back.spec["base-url"] = "https://y.example.invalid".into();
    resolve_secrets(&mut back, Some(&stored)).unwrap();
    assert_eq!(back.spec["keys"][0]["api-key"], "sk-live");
    // A placeholder where nothing is stored is refused, naming the place.
    let mut two = hidden;
    two.spec["keys"] = json!([{"api-key": SECRET}, {"api-key": SECRET}]);
    let err = resolve_secrets(&mut two, Some(&stored)).unwrap_err();
    assert!(err.message.starts_with("/keys/1/api-key"), "{}", err.message);
}

#[test]
fn the_management_key_is_hashed_and_hidden_on_read() {
    let mut m = Resource::new(Kind::Setting, "management", 0, json!({"secret-key": "hunter2"}));
    hash_management_key(&mut m).unwrap();
    let hash = m.spec["secret-key"].as_str().unwrap().to_owned();
    assert!(bcrypt::verify("hunter2", &hash).unwrap());
    assert_eq!(for_read(&m).spec["secret-key"], SECRET);
    // Hashing an existing hash or the placeholder changes nothing.
    hash_management_key(&mut m).unwrap();
    assert_eq!(m.spec["secret-key"], hash.as_str());
}

#[test]
fn set_path_edits_mappings_and_lists() {
    let mut doc = json!({"routing": {"strategy": "fill-first"}, "list": [1, 2]});
    set_path(&mut doc, &["routing", "retry", "request-retry"], Some(json!(2))).unwrap();
    set_path(&mut doc, &["list", "2"], Some(json!(3))).unwrap();
    set_path(&mut doc, &["list", "0"], None).unwrap();
    set_path(&mut doc, &["routing", "strategy"], None).unwrap();
    assert_eq!(doc, json!({"routing": {"retry": {"request-retry": 2}}, "list": [2, 3]}));
    assert!(set_path(&mut doc, &["list", "9"], Some(json!(0))).is_err());
}

#[test]
fn resources_that_cannot_compile_are_named() {
    let bad = Resource::new(Kind::Provider, "x", 0, json!({"type": "nope"}));
    assert_eq!(config(&[bad]).unwrap_err().resource.as_deref(), Some("provider/x"));
    let keys_in_access = Resource::new(Kind::Setting, "access", 0, json!({"api-keys": ["k"]}));
    assert!(config(&[keys_in_access]).is_err());
    let unknown = Resource::new(Kind::Setting, "routing", 0, json!({"no-such-setting": 1}));
    assert!(config(&[unknown]).is_err());
}
