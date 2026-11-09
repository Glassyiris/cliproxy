use super::*;
use serde_json::json;

fn put(kind: &str, id: &str, spec: Json) -> Op {
    Op::Put {
        kind: kind.into(),
        id: id.into(),
        spec,
        ord: None,
        description: None,
        if_rev: None,
        if_absent: false,
    }
}

fn provider(key: &str) -> Json {
    json!({"type": "claude", "base-url": "https://a.example.invalid", "keys": [{"api-key": key}]})
}

#[test]
fn a_commit_is_one_revision_and_an_invalid_one_changes_nothing() {
    let store = ConfigStore::memory();
    let first = store
        .commit(
            &[
                put("setting", "routing", json!({"strategy": "fill-first"})),
                put("provider", "main", provider("sk-1")),
            ],
            "test",
            "",
            false,
        )
        .unwrap();
    assert_eq!((first.rev, first.written, first.changes.len()), (1, true, 2));
    assert_eq!(first.config.routing.strategy, "fill-first");
    // The second op fails validation: neither is applied.
    let err = store
        .commit(
            &[
                put("setting", "routing", json!({"strategy": "round-robin"})),
                put("setting", "routing2", json!({})),
            ],
            "test",
            "",
            false,
        )
        .unwrap_err();
    assert_eq!(err.status, 422);
    assert_eq!(store.head().unwrap(), 1);
    assert_eq!(store.load().unwrap().config.routing.strategy, "fill-first");
    // Writing the same content again makes no revision.
    let same = store
        .commit(
            &[put("setting", "routing", json!({"strategy": "fill-first"}))],
            "test",
            "",
            false,
        )
        .unwrap();
    assert_eq!((same.rev, same.written), (1, false));
}

#[test]
fn preconditions_are_per_resource() {
    let store = ConfigStore::memory();
    store
        .commit(
            &[
                put("provider", "a", provider("sk-a")),
                put("provider", "b", provider("sk-b")),
            ],
            "t",
            "",
            false,
        )
        .unwrap();
    let a = store.get(Kind::Provider, "a").unwrap().unwrap();
    // Another writer changes b; a write to a that read a before still succeeds.
    store
        .commit(&[put("provider", "b", provider("sk-b2"))], "t", "", false)
        .unwrap();
    let ok = Op::Patch {
        kind: "provider".into(),
        id: "a".into(),
        patch: json!({"prefix": "team"}),
        if_rev: Some(a.rev),
    };
    store.commit(&[ok.clone()], "t", "", false).unwrap();
    // The same precondition is now stale.
    assert_eq!(store.commit(&[ok], "t", "", false).unwrap_err().status, 412);
    let exists = Op::Put {
        kind: "provider".into(),
        id: "a".into(),
        spec: provider("sk"),
        ord: None,
        description: None,
        if_rev: None,
        if_absent: true,
    };
    assert_eq!(store.commit(&[exists], "t", "", false).unwrap_err().status, 409);
}

#[test]
fn history_hides_secrets_and_restore_keeps_the_current_ones() {
    let store = ConfigStore::memory();
    store
        .commit(&[put("provider", "main", provider("sk-old"))], "t", "", false)
        .unwrap();
    store
        .commit(
            &[Op::Patch {
                kind: "provider".into(),
                id: "main".into(),
                patch: json!({"base-url": "https://b.example.invalid"}),
                if_rev: None,
            }],
            "t",
            "",
            false,
        )
        .unwrap();
    let (_, changes) = store.revision(1).unwrap().unwrap();
    assert_eq!(
        changes[0].after.as_ref().unwrap()["spec"]["keys"][0]["api-key"],
        resources::SECRET
    );
    // Back to revision 1's base URL, with the key stored now.
    let state = store.state_at(1).unwrap();
    store.replace(state, "restore", "", false).unwrap();
    let main = store.get(Kind::Provider, "main").unwrap().unwrap();
    assert_eq!(main.spec["base-url"], "https://a.example.invalid");
    assert_eq!(main.spec["keys"][0]["api-key"], "sk-old");
    // Once the provider is gone, its history cannot bring the key back.
    store
        .commit(
            &[Op::Delete {
                kind: "provider".into(),
                id: "main".into(),
                if_rev: None,
            }],
            "t",
            "",
            false,
        )
        .unwrap();
    let err = store
        .replace(store.state_at(1).unwrap(), "restore", "", false)
        .unwrap_err();
    assert_eq!(err.status, 422);
}

#[test]
fn a_deleted_key_leaves_no_trace_in_the_files() {
    let dir = std::env::temp_dir().join(format!("cook-config-store-{}", uuid::Uuid::new_v4()));
    let path = dir.join("cook.db");
    let store = ConfigStore::open(&path).unwrap();
    let secret = "sk-forget-me-0123456789";
    store
        .commit(&[put("provider", "main", provider(secret))], "t", "", false)
        .unwrap();
    store
        .commit(
            &[Op::Delete {
                kind: "provider".into(),
                id: "main".into(),
                if_rev: None,
            }],
            "t",
            "",
            false,
        )
        .unwrap();
    drop(store);
    for file in ["cook.db", "cook.db-wal"] {
        let bytes = std::fs::read(dir.join(file)).unwrap_or_default();
        assert!(
            !bytes.windows(secret.len()).any(|w| w == secret.as_bytes()),
            "{file} keeps the key"
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_path_set_keeps_ids_and_checks_what_was_read() {
    let store = ConfigStore::memory();
    store
        .commit(
            &[
                put("provider", "main", provider("sk-1")),
                put("client-key", "laptop", json!({"key": "ck"})),
            ],
            "t",
            "",
            false,
        )
        .unwrap();
    let doc = resources::document_for_read(&store.resources().unwrap());
    let mut list = doc["api-keys"]["claude"].clone();
    list[0]["prefix"] = "team".into();
    let set = Op::Set {
        path: "api-keys/claude".into(),
        value: list,
        expect: Some(doc["api-keys"]["claude"].clone()),
    };
    store.commit(&[set.clone()], "t", "", false).unwrap();
    let main = store.get(Kind::Provider, "main").unwrap().unwrap();
    assert_eq!(main.spec["prefix"], "team");
    assert!(main.spec.get("@id").is_none());
    // The same expectation no longer holds.
    assert_eq!(store.commit(&[set], "t", "", false).unwrap_err().status, 412);
    // An absent value matches an expected empty one.
    let first = Op::Set {
        path: "routing/strategy".into(),
        value: json!("fill-first"),
        expect: Some(Json::Null),
    };
    store.commit(&[first], "t", "", false).unwrap();
    assert_eq!(store.load().unwrap().config.routing.strategy, "fill-first");
}

#[test]
fn moves_reorder_list_entries() {
    let store = ConfigStore::memory();
    let keys = ["a", "b", "c"].map(|k| put("client-key", k, json!({ "key": format!("ck-{k}") })));
    store.commit(&keys, "t", "", false).unwrap();
    let mv = Op::Move {
        kind: "client-key".into(),
        id: "c".into(),
        before: Some("a".into()),
        after: None,
        if_rev: None,
    };
    let done = store.commit(&[mv], "t", "", false).unwrap();
    assert_eq!(done.config.api_keys, ["ck-c", "ck-a", "ck-b"]);
}

#[test]
fn another_connection_s_commit_is_noticed() {
    let dir = std::env::temp_dir().join(format!("cook-config-poll-{}", uuid::Uuid::new_v4()));
    let path = dir.join("cook.db");
    let server = ConfigStore::open(&path).unwrap();
    assert!(!server.changed_elsewhere().unwrap());
    server
        .commit(&[put("setting", "routing", json!({}))], "t", "", false)
        .unwrap();
    assert!(!server.changed_elsewhere().unwrap(), "its own commit");
    let cli = ConfigStore::open(&path).unwrap();
    cli.commit(
        &[put("setting", "routing", json!({"strategy": "fill-first"}))],
        "cli",
        "",
        false,
    )
    .unwrap();
    assert!(server.changed_elsewhere().unwrap());
    assert!(!server.changed_elsewhere().unwrap());
    assert_eq!(server.load().unwrap().rev, 2);
    drop((server, cli));
    std::fs::remove_dir_all(dir).unwrap();
}
