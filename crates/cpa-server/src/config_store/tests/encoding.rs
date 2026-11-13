//! Portable-file acceptance tests: only public store/credential commands, fixture
//! seeding and the supported SQLite artifact are used, never the private State layout.
use super::*;
use crate::cooldown_store::{Backend, Record};
use crate::credential_store::CredentialDb;
use std::collections::BTreeMap;
use std::time::SystemTime;

fn artifact_rows(path: &Path) -> Vec<Vec<Vec<rusqlite::types::Value>>> {
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    [
        "SELECT kind,id,ord,spec,description,rev,created_rev FROM resource ORDER BY kind,id",
        "SELECT rev,at,actor,message,digest FROM revision ORDER BY rev",
        "SELECT rev,kind,id,before,after FROM change ORDER BY rev,kind,id",
        "SELECT name,bytes,rev FROM credential_document ORDER BY name",
        "SELECT name,value FROM credential_meta ORDER BY name",
        "SELECT id,record FROM credential_cooldown ORDER BY id",
    ]
    .into_iter()
    .map(|sql| {
        let mut statement = conn.prepare(sql).unwrap();
        let columns = statement.column_count();
        statement
            .query_map([], |row| (0..columns).map(|i| row.get(i)).collect())
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    })
    .collect()
}

fn assert_standalone_private(path: &Path) {
    let bytes = std::fs::read(path).unwrap();
    assert_eq!(&bytes[..16], b"SQLite format 3\0");
    assert_eq!(&bytes[18..20], &[1, 1], "the image must not depend on WAL");
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut companion = path.as_os_str().to_owned();
        companion.push(suffix);
        assert!(!Path::new(&companion).exists(), "a companion is not a portable backup");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        assert_eq!(std::fs::metadata(path).unwrap().permissions().mode() & 0o777, 0o600);
    }
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(
        conn.pragma_query_value(None, "integrity_check", |row| row.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    assert_eq!(user_version(&conn).unwrap(), SCHEMA_VERSION);
    assert!(
        conn.prepare("SELECT kind,id,rev FROM change INDEXED BY change_resource_rev")
            .is_ok()
    );
}

#[test]
fn complete_state_exports_without_any_previous_database_or_credential_cache() {
    let root = std::env::temp_dir().join(format!("cook-encode-{}", uuid::Uuid::new_v4()));
    let clean = root.join("clean");
    let legacy = root.join("legacy");
    std::fs::create_dir_all(&clean).unwrap();
    std::fs::create_dir(&legacy).unwrap();
    std::fs::write(legacy.join("revoked.json"), b"{\"type\":\"private\"}").unwrap();
    let source = root.join("source.db");
    let store = Arc::new(crate::testing::config_store(&source).unwrap());
    store.import_yaml(
        "server: {port: 8911}\nupstream:\n  codex:\n    disable-codex-cloaking: true\nplugins: {configs: {acme: {ratio: 1.50, binary: !!binary YWJj, payload: '  keep opaque  '}, zeta: {unknown: [1, two]}}}\n",
        "fixture", "first revision",
    ).unwrap();
    let first_rev = store.snapshot().unwrap().0;
    let mut resources = store.snapshot().unwrap().1;
    for (index, resource) in resources.iter_mut().filter(|r| r.kind == Kind::Plugin).enumerate() {
        resource.ord = index as i64 * 19 - 7;
        resource.description = format!("opaque plugin {index}");
    }
    store
        .replace(resources, "fixture", "ordering and descriptions", false)
        .unwrap();
    store
        .commit(
            &[put("setting", "server", json!({"port": 8912}))],
            "fixture",
            "last revision",
            false,
        )
        .unwrap();
    let db = CredentialDb::initialize(store.clone(), &legacy).unwrap();
    db.delete(&db.auth_dir().join("revoked.json")).unwrap();
    let local = db.auth_dir().join("nested/raw.json");
    let external = root.join("explicit.json");
    db.save(&local, b"{\"type\":\"private\",\"old\":true}").unwrap();
    let raw = b"{\n  \"type\": \"private\", \"opaque\": [1, 2], \"token\": \"test-only\"\n}\n";
    db.save(&local, raw).unwrap();
    db.save(&external, b"{ \"type\": \"private\", \"external\": true }\n")
        .unwrap();
    Backend::save(
        db.as_ref(),
        vec![Record {
            auth_id: "nested/raw.json".into(),
            model: "fixture-model".into(),
            reason: "quota".into(),
            ..Default::default()
        }],
        SystemTime::now(),
    )
    .unwrap();
    crate::testing::database_execute(
        &store,
        "INSERT INTO credential_meta(name,value) VALUES ('opaque-fixture-metadata','  exact metadata  ');",
    )
    .unwrap();

    // Observe the supported portable artifact, not a private Rust struct. Include
    // raw bytes/document revisions, metadata and exact historical strings here.
    let expected_rows = artifact_rows(&source);
    let checkpoint = PathBuf::from(crate::testing::database_connection(&store).path().unwrap());
    assert_standalone_private(&checkpoint);
    assert_eq!(artifact_rows(&checkpoint), expected_rows);
    let expected = store.load().unwrap();
    let revisions = serde_json::to_value(store.revisions(500, None).unwrap()).unwrap();
    let history: BTreeMap<_, _> = (first_rev..=expected.rev)
        .map(|rev| {
            (
                rev,
                (
                    serde_json::to_value(store.revision(rev).unwrap()).unwrap(),
                    store.state_at(rev).unwrap(),
                ),
            )
        })
        .collect();
    let cooldowns = Backend::load(db.as_ref()).unwrap();
    let live = PathBuf::from(crate::testing::database_connection(&store).path().unwrap());
    std::fs::remove_file(&live).unwrap();
    std::fs::remove_file(&source).unwrap();
    std::fs::remove_dir_all(db.auth_dir()).unwrap();
    std::fs::remove_file(&external).unwrap();
    assert!(!live.exists() && !source.exists());

    let output = clean.join("complete.db");
    store
        .backup(&output)
        .expect("complete accepted state must encode with no old database available");
    assert!(
        !live.exists() && !source.exists(),
        "encoding must not recreate an old source"
    );
    assert_standalone_private(&output);
    assert_eq!(
        std::fs::read_dir(&clean).unwrap().count(),
        1,
        "only one artifact is required"
    );
    assert_eq!(artifact_rows(&output), expected_rows);
    // Legacy import metadata must survive: neither a revoked old file nor a new
    // legacy file can re-enter an already initialized credential domain.
    std::fs::write(legacy.join("late.json"), b"{}").unwrap();
    let recovered_store = Arc::new(crate::testing::existing_config_store(&output).unwrap());
    let recovered = CredentialDb::initialize(recovered_store.clone(), &legacy).unwrap();
    let again = recovered_store.load().unwrap();
    assert_eq!(again.resources, expected.resources);
    assert_eq!(again.rev, expected.rev);
    assert_eq!(again.digest, expected.digest);
    assert_eq!(again.text, expected.text);
    assert_eq!(again.config.oauth_only, expected.config.oauth_only);
    assert_eq!(again.config.plugin_configs, expected.config.plugin_configs);
    assert_eq!(
        serde_json::to_value(recovered_store.revisions(500, None).unwrap()).unwrap(),
        revisions
    );
    for (rev, (revision, state)) in history {
        assert_eq!(
            serde_json::to_value(recovered_store.revision(rev).unwrap()).unwrap(),
            revision
        );
        assert_eq!(recovered_store.state_at(rev).unwrap(), state);
    }
    assert_eq!(
        recovered
            .read(&recovered.auth_dir().join("nested/raw.json"))
            .unwrap()
            .as_deref(),
        Some(raw.as_slice())
    );
    assert_eq!(recovered.read(&external).unwrap(), db.read(&external).unwrap());
    assert_eq!(recovered.documents().unwrap().len(), 2);
    assert!(
        recovered
            .read(&recovered.auth_dir().join("revoked.json"))
            .unwrap()
            .is_none()
    );
    assert!(
        recovered
            .read(&recovered.auth_dir().join("late.json"))
            .unwrap()
            .is_none()
    );
    assert_eq!(Backend::load(recovered.as_ref()).unwrap(), cooldowns);
    drop((recovered, recovered_store, db, store));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn empty_and_initialized_memory_states_encode_without_a_disk_source() {
    let root = std::env::temp_dir().join(format!("cook-encode-memory-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    for initialized in [false, true] {
        let store = ConfigStore::memory();
        if initialized {
            store.import_yaml("", "fixture", "empty but initialized").unwrap();
        }
        let output = root.join(format!("{initialized}.db"));
        store.backup(&output).unwrap();
        assert_standalone_private(&output);
        let recovered = crate::testing::existing_config_store(&output).unwrap();
        assert_eq!(recovered.is_empty().unwrap(), !initialized);
        assert_eq!(recovered.snapshot().unwrap(), store.snapshot().unwrap());
        assert_eq!(
            serde_json::to_value(recovered.revisions(500, None).unwrap()).unwrap(),
            serde_json::to_value(store.revisions(500, None).unwrap()).unwrap()
        );
        drop(recovered);
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn ordinary_publication_encodes_only_the_admitted_candidate() {
    let root = std::env::temp_dir().join(format!("cook-encode-publication-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("source.db");
    let store = crate::testing::config_store(&path).unwrap();
    store.import_yaml("server: {port: 8913}\n", "fixture", "").unwrap();
    // Bypass writes are deliberate private-fixture faults, not accepted commands.
    // They must not become the source of the next normally published image.
    let storage = crate::testing::database_connection(&store);
    storage
        .execute_batch(
            "INSERT INTO resource(kind,id,ord,spec,description,rev,created_rev)
         VALUES ('plugin','unadmitted',7,'{\"opaque\":true}','bypass',1,1);
         INSERT INTO credential_document(name,bytes,rev) VALUES ('local:unadmitted.json',X'7B7D',19);
         INSERT INTO credential_meta(name,value) VALUES ('unadmitted','bypass');
         INSERT INTO credential_cooldown(id,record) VALUES ('unadmitted','{}');",
        )
        .unwrap();
    drop(storage);
    store
        .commit(
            &[put("setting", "server", json!({"port": 8914}))],
            "owner",
            "admitted",
            false,
        )
        .unwrap();
    assert_standalone_private(&path);
    let expected = root.join("canonical.db");
    store.backup(&expected).unwrap();
    assert_eq!(artifact_rows(&path), artifact_rows(&expected));
    let checkpoint = PathBuf::from(crate::testing::database_connection(&store).path().unwrap());
    assert_standalone_private(&checkpoint);
    assert_eq!(
        artifact_rows(&checkpoint),
        artifact_rows(&expected),
        "recovery must contain the same complete canonical image, not retained bypass rows"
    );
    let copy = root.join("cold.db");
    std::fs::copy(&path, &copy).unwrap();
    let recovered = crate::testing::existing_config_store(&copy).unwrap();
    assert_eq!(recovered.load().unwrap().config.port, 8914);
    assert!(recovered.snapshot().unwrap().1.iter().all(|r| r.id != "unadmitted"));
    assert_eq!(recovered.snapshot().unwrap(), store.snapshot().unwrap());
    drop((recovered, store));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn checkpoint_failures_do_not_retain_an_uninstalled_candidate() {
    let root = std::env::temp_dir().join(format!("cook-checkpoint-fault-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("cook.db");
    let store = Arc::new(crate::testing::config_store(&path).unwrap());
    store.import_yaml("server: {port: 8921}\n", "fixture", "").unwrap();
    let db = CredentialDb::initialize(store.clone(), &root.join("absent")).unwrap();
    let credential = db.auth_dir().join("grant.json");
    db.save(&credential, b"{\"refresh_token\":\"R0\"}").unwrap();
    let checkpoint = PathBuf::from(crate::testing::database_connection(&store).path().unwrap());
    let before = artifact_rows(&path);
    for construction in [true, false] {
        let block_build = construction.then(|| crate::testing::block_publication(&checkpoint));
        let block_install = (!construction).then(|| crate::testing::block_checkpoint_install(&store));
        assert!(db.save(&credential, b"{\"refresh_token\":\"R1\"}").is_err());
        assert_eq!(db.read(&credential).unwrap().unwrap(), b"{\"refresh_token\":\"R0\"}");
        assert_eq!(artifact_rows(&path), before);
        assert_eq!(store.load().unwrap().config.port, 8921);
        drop((block_build, block_install));
        assert_eq!(artifact_rows(&checkpoint), before);
    }
    // A later ordinary command must not retry a candidate that never acquired a
    // checkpoint, otherwise the failed grant would silently replace R0 with R1.
    store
        .commit(&[put("setting", "server", json!({"port": 8922}))], "owner", "", false)
        .unwrap();
    assert_eq!(db.read(&credential).unwrap().unwrap(), b"{\"refresh_token\":\"R0\"}");
    assert_eq!(artifact_rows(&checkpoint), artifact_rows(&path));
    assert_standalone_private(&checkpoint);
    assert_standalone_private(&path);
    let clean = root.join("clean");
    std::fs::create_dir(&clean).unwrap();
    let copy = clean.join("cook.db");
    std::fs::copy(&path, &copy).unwrap();
    let recovered_store = Arc::new(crate::testing::config_store(&copy).unwrap());
    let recovered = CredentialDb::initialize(recovered_store.clone(), &clean.join("absent")).unwrap();
    assert_eq!(
        recovered
            .read(&recovered.auth_dir().join("grant.json"))
            .unwrap()
            .unwrap(),
        b"{\"refresh_token\":\"R0\"}"
    );
    assert_eq!(recovered_store.load().unwrap().config.port, 8922);
    drop((recovered, recovered_store, db, store));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn cold_copies_stay_lossless_while_publications_compete() {
    use std::io::Read as _;
    let root = std::env::temp_dir().join(format!("cook-copy-images-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("cook.db");
    let store = Arc::new(crate::testing::config_store(&path).unwrap());
    let commit = |store: &ConfigStore, port: u16| {
        store
            .commit(
                &[
                    put("setting", "server", json!({"port": port})),
                    put(
                        "plugin",
                        "opaque",
                        json!({"port": port, "padding": "x".repeat(131_072)}),
                    ),
                ],
                "owner",
                "paired image",
                false,
            )
            .unwrap();
    };
    commit(&store, 8930);
    let db = CredentialDb::initialize(store.clone(), &root.join("absent")).unwrap();
    let raw = b"{\n \"type\": \"private\", \"opaque\": [1, 2]\n}\n";
    db.save(&db.auth_dir().join("raw.json"), raw).unwrap();
    let old_rows = artifact_rows(&path);
    let mut old_input = std::fs::File::open(&path).unwrap();
    let mut old_bytes = vec![0; 4096];
    old_input.read_exact(&mut old_bytes).unwrap();
    let start = Arc::new(std::sync::Barrier::new(3));
    let writers: Vec<_> = [8940, 8960]
        .into_iter()
        .map(|first| {
            let store = store.clone();
            let start = start.clone();
            std::thread::spawn(move || {
                start.wait();
                for port in first..first + 12 {
                    commit(&store, port);
                }
            })
        })
        .collect();
    start.wait();
    let mut copies = 0;
    while copies < 12 || writers.iter().any(|writer| !writer.is_finished()) {
        let clean = root.join(format!("copy-{copies}"));
        std::fs::create_dir(&clean).unwrap();
        let copy = clean.join("only.db");
        std::fs::copy(&path, &copy).unwrap();
        assert_eq!(std::fs::read_dir(&clean).unwrap().count(), 1);
        assert_standalone_private(&copy);
        let recovered_store = Arc::new(crate::testing::config_store(&copy).unwrap());
        let config = recovered_store.load().unwrap();
        let plugin = recovered_store.get(Kind::Plugin, "opaque").unwrap().unwrap();
        assert_eq!(plugin.spec["port"], config.config.port);
        assert_eq!(plugin.spec["padding"].as_str().unwrap(), "x".repeat(131_072));
        assert_eq!(plugin.rev, config.rev);
        assert_eq!(recovered_store.revisions(100, None).unwrap().len() as u64, config.rev);
        let recovered = CredentialDb::initialize(recovered_store.clone(), &clean.join("absent")).unwrap();
        assert_eq!(
            recovered.read(&recovered.auth_dir().join("raw.json")).unwrap().unwrap(),
            raw
        );
        drop((recovered, recovered_store));
        copies += 1;
    }
    for writer in writers {
        writer.join().unwrap();
    }
    // Finish a copy whose input was opened and partially read before all writes.
    old_input.read_to_end(&mut old_bytes).unwrap();
    drop(old_input);
    let old = root.join("old.db");
    std::fs::write(&old, old_bytes).unwrap();
    assert_eq!(artifact_rows(&old), old_rows);
    let recovered = crate::testing::config_store(&old).unwrap();
    assert_eq!(recovered.load().unwrap().config.port, 8930);
    let checkpoint = PathBuf::from(crate::testing::database_connection(&store).path().unwrap());
    assert_eq!(artifact_rows(&checkpoint), artifact_rows(&path));
    drop((recovered, db, store));
    std::fs::remove_dir_all(root).unwrap();
}
