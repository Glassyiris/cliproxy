use super::*;

fn database_path(name: &str) -> (PathBuf, PathBuf) {
    let dir = std::env::temp_dir().join(format!("cooker-config-{name}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("cooker.db");
    (dir, path)
}

fn live_path(store: &ConfigStore) -> PathBuf {
    PathBuf::from(store.conn().unwrap().path().unwrap())
}

#[test]
fn committed_queries_need_neither_working_nor_published_storage() {
    let (dir, path) = database_path("queries-without-storage");
    let store = crate::testing::config_store(&path).unwrap();
    store
        .import_yaml("server: {port: 8700}\n", "test", "memory queries")
        .unwrap();
    let committed = store.load().unwrap();
    let live = live_path(&store);
    let displaced = live.with_extension("displaced");
    std::fs::rename(&live, &displaced).unwrap();
    assert_eq!(store.snapshot().unwrap().1, committed.resources);
    assert_eq!(store.load().unwrap().rev, committed.rev);
    assert_eq!(store.load().unwrap().resources, committed.resources);
    assert!(!live.exists(), "a read must not create an empty working database");
    std::fs::rename(displaced, live).unwrap();
    let displaced = path.with_extension("displaced");
    std::fs::rename(&path, &displaced).unwrap();
    assert_eq!(store.head().unwrap(), committed.rev);
    assert_eq!(store.revisions(10, None).unwrap()[0].rev, committed.rev);
    assert_eq!(store.get(Kind::Setting, "server").unwrap().unwrap().spec["port"], 8700);
    assert_eq!(store.load().unwrap().resources, committed.resources);
    std::fs::rename(displaced, path).unwrap();
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn same_size_same_time_replacement_is_not_an_online_command() {
    let (dir, path) = database_path("replacement-identity");
    let store = crate::testing::config_store(&path).unwrap();
    store
        .commit(&[put("setting", "server", json!({"port": 8701}))], "test", "", false)
        .unwrap();
    let external = crate::testing::config_store(&dir.join("external.db")).unwrap();
    external
        .commit(&[put("setting", "server", json!({"port": 8702}))], "test", "", false)
        .unwrap();
    let before = std::fs::metadata(&path).unwrap();
    std::fs::copy(external.path().unwrap(), dir.join("incoming.db")).unwrap();
    std::fs::rename(dir.join("incoming.db"), &path).unwrap();
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(before.modified().unwrap()))
        .unwrap();
    assert_eq!(std::fs::metadata(&path).unwrap().len(), before.len());
    assert_eq!(store.load().unwrap().config.port, 8701);
    store
        .commit(
            &[put("setting", "routing", json!({"strategy": "fill-first"}))],
            "test",
            "",
            false,
        )
        .unwrap();
    let copy = dir.join("copy.db");
    std::fs::copy(&path, &copy).unwrap();
    let recovered = crate::testing::config_store(&copy).unwrap();
    assert_eq!(
        recovered.load().unwrap().config.port,
        8701,
        "a legitimate write must not import the replacement"
    );
    drop((external, recovered, store));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn identical_snapshot_bytes_do_not_reload_even_when_the_file_is_replaced() {
    let (dir, path) = database_path("identical-bytes");
    let store = crate::testing::config_store(&path).unwrap();
    let accepted = store.load().unwrap();
    let copy = dir.join("replacement.db");
    std::fs::copy(&path, &copy).unwrap();
    std::fs::rename(copy, &path).unwrap();
    let live = live_path(&store);
    let displaced = live.with_extension("displaced");
    std::fs::rename(&live, &displaced).unwrap();
    assert_eq!(store.load().unwrap().resources, accepted.resources);
    assert_eq!(store.head().unwrap(), accepted.rev);
    std::fs::rename(displaced, live).unwrap();
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn replaced_or_invalid_published_bytes_do_not_change_accepted_state() {
    let (dir, path) = database_path("ignore-replacement");
    let store = crate::testing::config_store(&path).unwrap();
    store
        .commit(&[put("setting", "server", json!({"port": 8711}))], "test", "", false)
        .unwrap();
    let live = live_path(&store);
    let replacement = crate::testing::config_store(&dir.join("replacement.db")).unwrap();
    replacement
        .commit(&[put("setting", "server", json!({"port": 8712}))], "test", "", false)
        .unwrap();
    let valid = std::fs::read(replacement.path().unwrap()).unwrap();
    let previous_live = std::fs::read(&live).unwrap();
    for bytes in [valid.as_slice(), b"not SQLite".as_slice(), b"".as_slice()] {
        std::fs::write(dir.join("incoming.db"), bytes).unwrap();
        std::fs::rename(dir.join("incoming.db"), &path).unwrap();
        assert_eq!(store.load().unwrap().config.port, 8711);
        assert_eq!(
            std::fs::read(&live).unwrap(),
            previous_live,
            "out-of-band input destroyed working state"
        );
    }
    store
        .commit(
            &[put("setting", "routing", json!({"strategy": "fill-first"}))],
            "test",
            "",
            false,
        )
        .unwrap();
    let copy = dir.join("copy.db");
    std::fs::copy(&path, &copy).unwrap();
    let recovered = crate::testing::config_store(&copy).unwrap();
    assert_eq!(recovered.load().unwrap().config.port, 8711);
    drop((replacement, recovered, store));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn opening_fresh_databases_serializes_schema_creation() {
    let (dir, path) = database_path("race");
    let start = std::sync::Arc::new(std::sync::Barrier::new(4));
    let workers: Vec<_> = (0..4)
        .map(|_| {
            let path = path.clone();
            let start = start.clone();
            std::thread::spawn(move || {
                start.wait();
                crate::testing::config_store(&path)
            })
        })
        .collect();
    let mut stores = Vec::new();
    for worker in workers {
        match worker.join().unwrap() {
            Ok(store) => stores.push(store),
            Err(error) => assert!(error.to_string().contains("already owned"), "{error}"),
        }
    }
    assert_eq!(stores.len(), 1, "only the admitted owner creates the schema");
    let conn = stores[0].conn().unwrap();
    assert_eq!(user_version(&conn).unwrap(), SCHEMA_VERSION);
    assert!(
        conn.prepare("SELECT kind, id, rev FROM change INDEXED BY change_resource_rev")
            .is_ok()
    );
    let live = PathBuf::from(conn.path().unwrap());
    assert!(live.starts_with(std::env::temp_dir()));
    assert_ne!(live, path);
    assert_eq!(live.file_name().unwrap(), "live.db");
    assert_eq!(
        conn.pragma_query_value(None, "journal_mode", |row| row.get::<_, String>(0))
            .unwrap(),
        "delete"
    );
    drop(conn);
    let working_dir = live.parent().unwrap();
    drop(stores);
    assert!(
        !working_dir.exists(),
        "the admitted owner removes its settled workspace on exit"
    );
    // Exclusive ownership replaced the shared SQL coordinator: the namespace keeps
    // no global coordination database beside the per-database workspaces.
    assert!(!working_dir.parent().unwrap().join("coordination.db").exists());
    assert!(!dir.join("cooker.db-wal").exists());
    assert!(!dir.join("cooker.db-shm").exists());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn other_schema_versions_are_refused_and_left_unchanged() {
    for version in [0, 1, 3, SCHEMA_VERSION + 1] {
        let (dir, path) = database_path("other-schema");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.pragma_update(None, "user_version", version).unwrap();
        drop(conn);
        let before = std::fs::read(&path).unwrap();
        let files = || {
            let mut names: Vec<_> = std::fs::read_dir(&dir)
                .unwrap()
                .map(|e| e.unwrap().file_name())
                .filter(|name| name.to_string_lossy().starts_with("cooker.db"))
                .collect();
            names.sort();
            names
        };
        let listed = files();
        for create in [true, false] {
            let error = if create {
                crate::testing::config_store(&path)
            } else {
                crate::testing::existing_config_store(&path)
            }
            .err()
            .expect("another schema version must be refused");
            assert!(error.to_string().contains("not supported"), "{version}: {error}");
            assert_eq!(std::fs::read(&path).unwrap(), before, "{version}");
            assert_eq!(files(), listed, "{version}: no companion file appears");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}

/// A rejected database is not touched: a WAL-mode file with an uncheckpointed write keeps its
/// bytes, mode and companion files, because the schema is checked before permissions or the
/// journal mode change.
#[cfg(unix)]
#[test]
fn a_rejected_wal_database_keeps_its_contents_mode_and_companions() {
    use std::os::unix::fs::PermissionsExt as _;
    for version in [1, SCHEMA_VERSION + 1] {
        let (origin_dir, origin) = database_path("rejected-wal-origin");
        let (dir, path) = database_path("rejected-wal");
        let conn = Connection::open(&origin).unwrap();
        let mode: String = conn
            .pragma_update_and_check(None, "journal_mode", "WAL", |r| r.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        conn.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.pragma_update(None, "user_version", version).unwrap();
        // Copy while the writer is open: the write is only in the -wal file, as after a crash.
        for suffix in ["", "-wal", "-shm"] {
            let mut from = origin.as_os_str().to_owned();
            from.push(suffix);
            let mut to = path.as_os_str().to_owned();
            to.push(suffix);
            std::fs::copy(&from, &to).unwrap();
            std::fs::set_permissions(&to, std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        drop(conn);
        std::fs::remove_dir_all(origin_dir).unwrap();
        let companion = |suffix: &str| {
            let mut name = path.as_os_str().to_owned();
            name.push(suffix);
            PathBuf::from(name)
        };
        let snapshot = || {
            ["", "-wal"].map(|suffix| {
                let file = companion(suffix);
                (
                    std::fs::read(&file).ok(),
                    std::fs::metadata(&file).ok().map(|m| m.permissions().mode() & 0o777),
                )
            })
        };
        assert!(
            snapshot()[1].0.as_ref().is_some_and(|wal| !wal.is_empty()),
            "the write is still in the -wal file"
        );
        let before = snapshot();
        for create in [true, false] {
            let error = if create {
                crate::testing::config_store(&path)
            } else {
                crate::testing::existing_config_store(&path)
            }
            .err()
            .expect("an unsupported schema must be refused");
            assert!(error.to_string().contains("not supported"), "{version}: {error}");
            assert_eq!(snapshot(), before, "{version}: contents and modes are unchanged");
            assert!(companion("-shm").exists(), "{version}: the -shm file stays");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(unix)]
#[test]
fn opening_tightens_snapshot_and_temporary_database_permissions() {
    use std::os::unix::fs::PermissionsExt as _;
    let (dir, path) = database_path("perms");
    let store = crate::testing::config_store(&path).unwrap();
    let live = live_path(&store);
    let image = std::fs::read(&live).unwrap();
    drop(store);
    // An unowned surviving image, not a second writer over an active owner's DB.
    std::fs::create_dir_all(live.parent().unwrap()).unwrap();
    std::fs::write(&live, image).unwrap();
    for file in [&path, &live] {
        std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o644)).unwrap();
    }
    std::fs::set_permissions(live.parent().unwrap(), std::fs::Permissions::from_mode(0o755)).unwrap();
    let store = Arc::new(crate::testing::existing_config_store(&path).unwrap());
    let another = store.clone();
    for file in [&path, &live] {
        assert_eq!(std::fs::metadata(file).unwrap().permissions().mode() & 0o777, 0o600);
    }
    assert_eq!(
        std::fs::metadata(live.parent().unwrap()).unwrap().permissions().mode() & 0o777,
        0o700
    );
    let mut conn = store.conn().unwrap();
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).unwrap();
    tx.execute("INSERT INTO credential_meta VALUES ('permission-test', '1')", [])
        .unwrap();
    let journal = live.with_file_name("live.db-journal");
    assert_eq!(std::fs::metadata(journal).unwrap().permissions().mode() & 0o777, 0o600);
    drop(tx);
    drop(conn);
    drop(another);
    assert!(
        live.exists(),
        "a second handle must not remove the first handle's database"
    );
    drop(store);
    assert!(!live.parent().unwrap().exists());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn published_main_file_is_a_standalone_backup_after_each_commit() {
    let (dir, path) = database_path("published");
    let store = crate::testing::config_store(&path).unwrap();
    for port in [8101, 8102] {
        store
            .commit(&[put("setting", "server", json!({"port": port}))], "t", "", false)
            .unwrap();
        let copy = dir.join(format!("copy-{port}.db"));
        std::fs::copy(&path, &copy).unwrap();
        let bytes = std::fs::read(&copy).unwrap();
        assert_eq!(&bytes[18..20], &[1, 1], "published backups must not depend on WAL");
        let copied = crate::testing::existing_config_store(&copy).unwrap();
        assert_eq!(copied.get(Kind::Setting, "server").unwrap().unwrap().spec["port"], port);
    }
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn uncheckpointed_wal_is_preserved_in_the_published_backup() {
    let (dir, path) = database_path("wal");
    let writer = Connection::open(&path).unwrap();
    writer.execute_batch(SCHEMA).unwrap();
    writer.pragma_update(None, "user_version", SCHEMA_VERSION).unwrap();
    writer.pragma_update(None, "journal_mode", "WAL").unwrap();
    writer
        .set_db_config(rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)
        .unwrap();
    writer
        .execute_batch(
            "INSERT INTO revision VALUES (1, '2026-01-01', 'test', '', '');
        INSERT INTO resource(kind, id, spec, rev, created_rev)
        VALUES ('setting', 'server', '{\"port\":8123}', 1, 1);",
        )
        .unwrap();
    drop(writer);
    assert!(dir.join("cooker.db-wal").exists());
    let store = crate::testing::config_store(&path).unwrap();
    let copy = dir.join("restored.db");
    std::fs::copy(&path, &copy).unwrap();
    assert_eq!(&std::fs::read(&copy).unwrap()[18..20], &[1, 1]);
    let restored = crate::testing::existing_config_store(&copy).unwrap();
    assert_eq!(
        restored.get(Kind::Setting, "server").unwrap().unwrap().spec["port"],
        8123
    );
    assert!(!dir.join("cooker.db-wal").exists());
    assert!(!dir.join("cooker.db-shm").exists());
    drop(restored);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn wal_conflict_preserves_sidecars_and_recovers_opaque_state_after_close() {
    let (dir, path) = database_path("active-wal");
    let expected = resources::import_yaml(
        "server: {port: 8124}\nrequests: {payload: {default: [{models: [{name: m}], params: {ratio: 1.50}}]}}\n",
    )
    .unwrap();
    let writer = Connection::open(&path).unwrap();
    writer.execute_batch(SCHEMA).unwrap();
    writer.pragma_update(None, "user_version", SCHEMA_VERSION).unwrap();
    writer.pragma_update(None, "journal_mode", "WAL").unwrap();
    writer.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
    writer
        .set_db_config(rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)
        .unwrap();
    writer
        .execute_batch("BEGIN IMMEDIATE; INSERT INTO revision VALUES (1, '2026-01-01', 'writer', 'WAL state', '');")
        .unwrap();
    for resource in &expected {
        writer
            .execute(
                "INSERT INTO resource(kind,id,ord,spec,description,rev,created_rev) VALUES (?1,?2,?3,?4,?5,1,1)",
                params![
                    resource.kind.name(),
                    resource.id,
                    resource.ord,
                    serde_json::to_string(&resource.spec).unwrap(),
                    resource.description
                ],
            )
            .unwrap();
    }
    let raw = b"{\n \"type\":\"private\", \"opaque\":{\"ratio\":1.50,\"keep\":[1,2]}\n}\n";
    writer
        .execute(
            "INSERT INTO credential_document(name,bytes,rev) VALUES ('local:private.json',?1,7)",
            [raw.as_slice()],
        )
        .unwrap();
    writer
        .execute(
            "INSERT INTO credential_meta VALUES ('opaque-writer-meta','preserve')",
            [],
        )
        .unwrap();
    writer.execute_batch("COMMIT; BEGIN;").unwrap();
    assert_eq!(head(&writer).unwrap(), 1); // Keep the real WAL reader transaction open.
    let wal = dir.join("cooker.db-wal");
    let shm = dir.join("cooker.db-shm");
    let before_wal = std::fs::read(&wal).unwrap();
    let before_main = std::fs::read(&path).unwrap();
    let error = crate::testing::config_store(&path)
        .err()
        .expect("an active WAL user must block conversion");
    assert!(error.to_string().contains("close WAL users"), "{error}");
    assert_eq!(std::fs::read(&path).unwrap(), before_main);
    assert_eq!(std::fs::read(&wal).unwrap(), before_wal);
    assert!(shm.exists(), "failed bootstrap must not delete an active sidecar");
    assert_eq!(head(&writer).unwrap(), 1);
    writer.execute_batch("ROLLBACK").unwrap();
    writer.close().unwrap();
    assert!(wal.exists(), "committed writer state still needs WAL recovery");
    let store = Arc::new(crate::testing::config_store(&path).unwrap());
    assert_eq!(store.load().unwrap().config.port, 8124);
    for resource in expected {
        let actual = store.get(resource.kind, &resource.id).unwrap().unwrap();
        assert_eq!(actual.ord, resource.ord);
        assert_eq!(actual.spec, resource.spec);
        assert_eq!((actual.rev, actual.created_rev), (1, 1));
    }
    assert!(!wal.exists() && !shm.exists());
    let copy = dir.join("only-published.db");
    std::fs::copy(&path, &copy).unwrap();
    assert_eq!(&std::fs::read(&copy).unwrap()[18..20], &[1, 1]);
    let restored = Arc::new(crate::testing::config_store(&copy).unwrap());
    let db = crate::credential_store::CredentialDb::initialize(restored.clone()).unwrap();
    assert_eq!(db.read(&db.auth_dir().join("private.json")).unwrap().unwrap(), raw);
    let conn = restored.conn().unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT value FROM credential_meta WHERE name='opaque-writer-meta'",
            [],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "preserve"
    );
    assert_eq!(
        conn.query_row(
            "SELECT rev FROM credential_document WHERE name='local:private.json'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        7
    );
    drop(conn);
    drop((db, restored, store));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn publication_does_not_change_an_already_open_raw_copy() {
    use std::io::Read as _;
    let (dir, path) = database_path("open-copy");
    let store = crate::testing::config_store(&path).unwrap();
    store
        .commit(&[put("setting", "server", json!({"port":8001}))], "t", "", false)
        .unwrap();
    let mut copying = std::fs::File::open(&path).unwrap();
    store
        .commit(&[put("setting", "server", json!({"port":8002}))], "t", "", false)
        .unwrap();
    let mut bytes = Vec::new();
    copying.read_to_end(&mut bytes).unwrap();
    let copy = dir.join("copy.db");
    std::fs::write(&copy, bytes).unwrap();
    let old = crate::testing::existing_config_store(&copy).unwrap();
    assert_eq!(old.get(Kind::Setting, "server").unwrap().unwrap().spec["port"], 8001);
    assert_eq!(store.get(Kind::Setting, "server").unwrap().unwrap().spec["port"], 8002);
    drop(old);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn raw_copies_remain_consistent_during_concurrent_commits() {
    let (dir, path) = database_path("copy-race");
    let store = std::sync::Arc::new(crate::testing::config_store(&path).unwrap());
    store
        .commit(&[put("setting", "server", json!({"port":8200}))], "t", "", false)
        .unwrap();
    let second = store.clone();
    let start = std::sync::Arc::new(std::sync::Barrier::new(2));
    let other_start = start.clone();
    let writer = std::thread::spawn(move || {
        other_start.wait();
        for port in 8201..8211 {
            second
                .commit(&[put("setting", "server", json!({"port":port}))], "t", "", false)
                .unwrap();
        }
    });
    start.wait();
    let copy = dir.join("copy.db");
    loop {
        std::fs::copy(&path, &copy).unwrap();
        let copied = Connection::open(&copy).unwrap();
        assert_eq!(
            copied
                .pragma_query_value(None, "integrity_check", |row| row.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        let spec: String = copied
            .query_row("SELECT spec FROM resource WHERE id='server'", [], |row| row.get(0))
            .unwrap();
        let port = serde_json::from_str::<Json>(&spec).unwrap()["port"].as_u64().unwrap();
        assert!((8200..8211).contains(&port));
        if writer.is_finished() {
            break;
        }
    }
    writer.join().unwrap();
    assert_eq!(head(&Connection::open(&path).unwrap()).unwrap(), store.head().unwrap());
    assert_eq!(store.get(Kind::Setting, "server").unwrap().unwrap().spec["port"], 8210);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn resume_republishes_a_live_commit_whose_publication_failed() {
    let (dir, path) = database_path("resume");
    let store = crate::testing::config_store(&path).unwrap();
    store
        .commit(&[put("setting", "server", json!({"port":8301}))], "t", "", false)
        .unwrap();
    let blocked = crate::testing::block_publication(&path);
    assert!(
        store
            .commit(&[put("setting", "server", json!({"port":8302}))], "t", "", false)
            .is_err()
    );
    drop(blocked);
    assert_eq!(head(&Connection::open(&path).unwrap()).unwrap(), 1);
    let live = live_path(&store);
    // Resume is a last-owner exit followed by a new owner, not a concurrent opener.
    // An unresolved checkpoint must survive that exit without fixture copies.
    drop(store);
    assert!(live.exists());
    let resumed = crate::testing::config_store(&path).unwrap();
    assert_eq!(
        resumed.get(Kind::Setting, "server").unwrap().unwrap().spec["port"],
        8302
    );
    assert_eq!(head(&Connection::open(&path).unwrap()).unwrap(), 2);
    assert_eq!(live_path(&resumed), live);
    drop(resumed);
    assert!(!live.parent().unwrap().exists());
    assert!(
        !std::fs::read_dir(&dir)
            .unwrap()
            .any(|entry| entry.unwrap().file_name().to_string_lossy().ends_with(".tmp"))
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn failed_publication_can_be_retried_without_a_new_revision() {
    let (dir, path) = database_path("retry-publication");
    let store = crate::testing::config_store(&path).unwrap();
    let op = put("setting", "server", json!({"port":8340}));
    let blocked = crate::testing::block_publication(&path);
    assert!(store.commit(std::slice::from_ref(&op), "t", "", false).is_err());
    drop(blocked);
    assert!(!store.commit(&[op], "t", "", false).unwrap().written);
    assert_eq!(head(&Connection::open(&path).unwrap()).unwrap(), 1);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn empty_and_corrupt_live_files_fall_back_to_the_snapshot() {
    let (dir, path) = database_path("bad-live");
    let store = crate::testing::config_store(&path).unwrap();
    store
        .commit(&[put("setting", "server", json!({"port":8350}))], "t", "", false)
        .unwrap();
    let live = live_path(&store);
    drop(store);
    for bytes in [b"".as_slice(), b"not a SQLite database".as_slice()] {
        std::fs::create_dir_all(live.parent().unwrap().join("refs")).unwrap();
        std::fs::write(&live, bytes).unwrap();
        let reopened = crate::testing::config_store(&path).unwrap();
        assert_eq!(
            reopened.get(Kind::Setting, "server").unwrap().unwrap().spec["port"],
            8350
        );
        drop(reopened);
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn schema_empty_nonzero_live_file_falls_back_to_the_snapshot() {
    let (dir, path) = database_path("schema-empty-live");
    let store = crate::testing::config_store(&path).unwrap();
    store
        .commit(&[put("setting", "server", json!({"port":8370}))], "t", "", false)
        .unwrap();
    let live = live_path(&store);
    drop(store);
    std::fs::create_dir_all(live.parent().unwrap().join("refs")).unwrap();
    let empty = Connection::open(&live).unwrap();
    empty.execute_batch("VACUUM").unwrap();
    drop(empty);
    assert!(std::fs::metadata(&live).unwrap().len() > 0);
    let resumed = crate::testing::config_store(&path).unwrap();
    assert_eq!(resumed.head().unwrap(), 1);
    assert_eq!(
        resumed.get(Kind::Setting, "server").unwrap().unwrap().spec["port"],
        8370
    );
    assert_eq!(head(&Connection::open(&path).unwrap()).unwrap(), 1);
    // An active handle must fail closed, never be unlinked and re-seeded.
    resumed.conn().unwrap().pragma_update(None, "user_version", 0).unwrap();
    assert!(crate::testing::config_store(&path).is_err());
    assert!(live.exists());
    drop(resumed);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn recovery_uses_native_ownership_not_stale_process_markers() {
    for kind in ["missing", "empty", "corrupt", "schema-empty"] {
        let (dir, path) = database_path(kind);
        let store = Arc::new(crate::testing::config_store(&path).unwrap());
        store
            .import_yaml("server: {port: 8381}\n", "test", "original state")
            .unwrap();
        let db = crate::credential_store::CredentialDb::initialize(store.clone()).unwrap();
        let raw = b"{\n \"type\":\"private\", \"opaque\":{\"keep\":[1,2]}\n}\n";
        db.save(&db.auth_dir().join("raw.json"), raw).unwrap();
        let cache = db.auth_dir();
        let live = live_path(&store);
        drop((db, store));
        std::fs::remove_dir_all(cache).unwrap();
        let refs = live.parent().unwrap().join("refs");
        std::fs::create_dir_all(&refs).unwrap();
        // A PID can still exist after its former ownership has ended or been reused.
        std::fs::write(refs.join(std::process::id().to_string()), b"").unwrap();
        match kind {
            "missing" => {}
            "empty" => std::fs::write(&live, b"").unwrap(),
            "corrupt" => std::fs::write(&live, b"not a SQLite database").unwrap(),
            _ => {
                let empty = Connection::open(&live).unwrap();
                empty.pragma_update(None, "user_version", SCHEMA_VERSION).unwrap();
                empty.close().unwrap();
            }
        }
        let recovered = Arc::new(crate::testing::config_store(&path).unwrap());
        assert_eq!(recovered.head().unwrap(), 1, "{kind}");
        assert_eq!(recovered.load().unwrap().config.port, 8381, "{kind}");
        assert_eq!(recovered.revisions(10, None).unwrap()[0].message, "original state");
        let db = crate::credential_store::CredentialDb::initialize(recovered.clone()).unwrap();
        assert_eq!(db.read(&db.auth_dir().join("raw.json")).unwrap().unwrap(), raw);
        assert_eq!(std::fs::read(db.auth_dir().join("raw.json")).unwrap(), raw);
        drop((db, recovered));
        assert!(
            !live.exists(),
            "a stale PID marker must not prevent settled cleanup: {kind}"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[test]
fn recovery_preserves_newer_schemas_even_without_known_tables() {
    for known_tables in [false, true] {
        let (dir, path) = database_path("future-schema");
        let store = crate::testing::config_store(&path).unwrap();
        store
            .import_yaml("server: {port: 8382}\n", "test", "published")
            .unwrap();
        let live = live_path(&store);
        drop(store);
        std::fs::create_dir_all(live.parent().unwrap()).unwrap();
        let future = Connection::open(&live).unwrap();
        if known_tables {
            future.execute_batch(SCHEMA).unwrap();
        }
        future
            .execute_batch(
                "CREATE TABLE future_payload(value TEXT); INSERT INTO future_payload VALUES ('keep future data');",
            )
            .unwrap();
        future.pragma_update(None, "user_version", SCHEMA_VERSION + 1).unwrap();
        future.close().unwrap();
        let before_live = std::fs::read(&live).unwrap();
        let before_published = std::fs::read(&path).unwrap();
        let error = crate::testing::config_store(&path)
            .err()
            .expect("unsupported state must not cold-fallback");
        assert!(error.to_string().contains("not supported"), "{error}");
        assert_eq!(
            std::fs::read(&live).unwrap(),
            before_live,
            "newer checkpoint must not be erased"
        );
        assert_eq!(std::fs::read(&path).unwrap(), before_published);
        std::fs::remove_file(&live).unwrap();
        let repaired = crate::testing::config_store(&path).unwrap();
        assert_eq!(
            repaired.load().unwrap().config.port,
            8382,
            "failed startup releases ownership"
        );
        drop(repaired);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[test]
fn recovery_keeps_an_initialized_empty_checkpoint() {
    let (dir, path) = database_path("initialized-empty");
    let store = crate::testing::config_store(&path).unwrap();
    store
        .import_yaml("server: {port: 8383}\n", "test", "before empty")
        .unwrap();
    let live = live_path(&store);
    let blocked = crate::testing::block_publication(&path);
    assert!(
        store
            .replace(Vec::new(), "test", "empty but initialized", false)
            .is_err()
    );
    drop(blocked);
    assert_eq!(head(&Connection::open(&path).unwrap()).unwrap(), 1);
    drop(store);
    assert!(live.exists());
    let resumed = crate::testing::config_store(&path).unwrap();
    assert_eq!(resumed.head().unwrap(), 2);
    assert!(
        !resumed.is_empty().unwrap(),
        "empty imported state is still initialized"
    );
    assert_eq!(
        resumed.load().unwrap().config.port,
        0,
        "do not resurrect the older published setting"
    );
    assert_eq!(
        head(&Connection::open(&path).unwrap()).unwrap(),
        2,
        "republished before readiness"
    );
    drop(resumed);
    assert!(!live.exists());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn databases_sharing_a_temporary_namespace_publish_independently() {
    let (dir, first_path) = database_path("independent");
    let second_path = dir.join("second.db");
    let first = std::sync::Arc::new(crate::testing::config_store(&first_path).unwrap());
    let second = crate::testing::config_store(&second_path).unwrap();
    assert_eq!(
        live_path(&first).parent().unwrap().parent(),
        live_path(&second).parent().unwrap().parent(),
        "both workspaces live in one temporary namespace"
    );
    // The same database still admits exactly one owner.
    let error = crate::testing::config_store(&first_path)
        .err()
        .expect("a second owner of the same database");
    assert!(error.to_string().contains("already owned"), "{error}");

    // Holding the first database's working connection must not stall the second's
    // publication: no lock spans databases.
    let (held, ready) = std::sync::mpsc::channel();
    let (release, gate) = std::sync::mpsc::channel::<()>();
    let holder = std::thread::spawn({
        let first = first.clone();
        move || {
            let _conn = first.conn().unwrap();
            held.send(()).unwrap();
            let _ = gate.recv_timeout(std::time::Duration::from_secs(60));
        }
    });
    ready.recv().unwrap();
    let (done, finished) = std::sync::mpsc::channel();
    let writer = std::thread::spawn(move || {
        let committed = second.commit(&[put("setting", "server", json!({"port": 8371}))], "t", "", false);
        done.send(committed.map(|c| c.rev).map_err(|e| e.to_string())).unwrap();
        second
    });
    let outcome = finished.recv_timeout(std::time::Duration::from_secs(5));
    release.send(()).unwrap();
    holder.join().unwrap();
    let second = writer.join().unwrap();
    assert_eq!(
        outcome.expect("another database's open connection stalled this publication"),
        Ok(1)
    );
    let published = crate::testing::existing_config_store(&dir.join("copy.db"));
    assert!(published.is_err(), "no copy exists yet");
    std::fs::copy(&second_path, dir.join("copy.db")).unwrap();
    let copy = crate::testing::existing_config_store(&dir.join("copy.db")).unwrap();
    assert_eq!(copy.load().unwrap().config.port, 8371);
    first
        .commit(&[put("setting", "server", json!({"port": 8372}))], "t", "", false)
        .unwrap();
    assert_eq!(first.load().unwrap().config.port, 8372);
    drop((copy, second, first));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn initializing_another_database_does_not_sweep_other_namespaces() {
    let (dir, path) = database_path("sweep");
    let store = crate::testing::config_store(&path).unwrap();
    let live = live_path(&store);
    let root = live.parent().unwrap().parent().unwrap();
    let stale = root.join(format!("{:064x}", uuid::Uuid::new_v4().as_u128()));
    std::fs::create_dir_all(stale.join("refs")).unwrap();
    std::fs::write(stale.join("refs/0"), b"").unwrap();
    std::fs::write(stale.join("live.db"), b"abandoned").unwrap();
    std::fs::remove_file(&path).unwrap();
    let another_path = dir.join("another.db");
    let another = crate::testing::config_store(&another_path).unwrap();
    assert_eq!(std::fs::read(stale.join("live.db")).unwrap(), b"abandoned");
    assert!(
        live.exists(),
        "a missing snapshot is not permission to delete an active live database"
    );
    store
        .commit(&[put("setting", "server", json!({"port":8360}))], "t", "", false)
        .unwrap();
    assert!(path.exists());
    drop(another);
    drop(store);
    std::fs::remove_dir_all(stale).unwrap();
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn exclusive_owner_cannot_be_bypassed_by_another_workspace() {
    let (dir, path) = database_path("exclusive-workspaces");
    let store = crate::testing::config_store(&path).unwrap();
    store
        .commit(&[put("setting", "server", json!({"port": 8357}))], "t", "", false)
        .unwrap();
    let published = std::fs::read(&path).unwrap();
    let error = ConfigStore::open_in(&path, true, dir.join("other-workspace"))
        .err()
        .expect("another working namespace must not bypass the published database owner");
    assert!(error.to_string().contains("already owned"), "{error}");
    assert_eq!(std::fs::read(&path).unwrap(), published);
    assert_eq!(store.load().unwrap().config.port, 8357);
    drop(store);
    let next = ConfigStore::open_in(&path, true, dir.join("other-workspace")).unwrap();
    assert_eq!(next.load().unwrap().config.port, 8357);
    next.commit(&[put("setting", "server", json!({"port": 8358}))], "t", "", false)
        .unwrap();
    drop(next);
    std::fs::remove_dir_all(dir).unwrap();
}

/// A child forked while the owner runs shares the guard's open file description
/// until it execs. Releasing the owner must not wait for that child.
#[cfg(target_os = "linux")]
#[test]
fn a_duplicated_guard_descriptor_cannot_keep_a_released_owner_locked() {
    let (dir, path) = database_path("inherited-guard");
    let store = crate::testing::config_store(&path).unwrap();
    let owners = path.parent().unwrap().join(".cooker-owners");
    let fd = std::fs::read_dir("/proc/self/fd")
        .unwrap()
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let target = std::fs::read_link(entry.path()).ok()?;
            target.starts_with(&owners).then_some(())?;
            entry.file_name().to_str()?.parse::<i32>().ok()
        })
        .next()
        .expect("the owner holds its guard open");
    // SAFETY: `store` keeps this descriptor open; it is borrowed only to duplicate it.
    let inherited = unsafe { std::os::fd::BorrowedFd::borrow_raw(fd) }
        .try_clone_to_owned()
        .unwrap();
    drop(store);
    let next = ConfigStore::open_in(&path, true, dir.join("next-workspace"))
        .expect("a released owner is free while a forked child still holds its descriptor");
    drop(next);
    drop(inherited);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn exclusive_owner_is_process_safe_and_released_after_shutdown() {
    const TEST: &str = "config_store::tests::database::exclusive_owner_is_process_safe_and_released_after_shutdown";
    const PATH: &str = "CK_TEST_OWNER_PATH";
    const PHASE: &str = "CK_TEST_OWNER_PHASE";
    if let Some(path) = std::env::var_os(PATH) {
        let path = PathBuf::from(path);
        let phase = std::env::var(PHASE).unwrap();
        let opened = ConfigStore::open_in(&path, true, path.parent().unwrap().join(format!("child-{phase}")));
        if phase == "owned" {
            let error = opened
                .err()
                .expect("a different process must not acquire an active owner");
            assert!(error.to_string().contains("already owned"), "{error}");
        } else {
            let store = opened.unwrap();
            assert_eq!(store.head().unwrap(), 1);
            assert_eq!(store.load().unwrap().config.port, 8357);
            store
                .commit(&[put("setting", "server", json!({"port": 8358}))], "child", "", false)
                .unwrap();
        }
        return;
    }
    let (dir, path) = database_path("exclusive-processes");
    let store = crate::testing::config_store(&path).unwrap();
    store
        .commit(&[put("setting", "server", json!({"port": 8357}))], "t", "", false)
        .unwrap();
    let child = |phase| {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST, "--nocapture"])
            .env(PATH, &path)
            .env(PHASE, phase)
            .output()
            .unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stdout));
    };
    child("owned");
    assert_eq!(store.head().unwrap(), 1);
    drop(store);
    child("released");
    let final_store = crate::testing::config_store(&path).unwrap();
    assert_eq!(final_store.head().unwrap(), 2);
    assert_eq!(final_store.load().unwrap().config.port, 8358);
    drop(final_store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn exclusive_owner_racing_shutdown_never_enters_before_workspace_cleanup() {
    let (dir, path) = database_path("exclusive-shutdown");
    for round in 0..4 {
        let owner = ConfigStore::open_in(&path, true, dir.join("old-workspace")).unwrap();
        owner
            .commit(
                &[put("setting", "server", json!({"port": 8600 + round * 2}))],
                "t",
                "",
                false,
            )
            .unwrap();
        let live = live_path(&owner);
        let start = Arc::new(std::sync::Barrier::new(2));
        let closing = start.clone();
        let shutdown = std::thread::spawn(move || {
            closing.wait();
            drop(owner);
        });
        start.wait();
        let contender = ConfigStore::open_in(&path, true, dir.join("new-workspace"));
        if contender.is_ok() {
            assert!(
                !live.exists(),
                "ownership must remain held until old-workspace cleanup finishes"
            );
        }
        shutdown.join().unwrap();
        let next = match contender {
            Ok(store) => store,
            Err(error) => {
                assert!(error.to_string().contains("already owned"), "{error}");
                // A refused racing opener may acquire only after shutdown joins.
                ConfigStore::open_in(&path, true, dir.join("new-workspace")).unwrap()
            }
        };
        assert_eq!(next.head().unwrap(), round * 2 + 1);
        next.commit(
            &[put("setting", "server", json!({"port": 8601 + round * 2}))],
            "t",
            "",
            false,
        )
        .unwrap();
        assert_eq!(next.head().unwrap(), round * 2 + 2);
        drop(next);
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn concurrent_open_and_last_exit_never_split_the_live_database() {
    let (dir, path) = database_path("lifetime-race");
    let owner = Arc::new(crate::testing::config_store(&path).unwrap());
    let start = std::sync::Arc::new(std::sync::Barrier::new(4));
    let workers: Vec<_> = (0..4)
        .map(|worker| {
            let path = path.clone();
            let start = start.clone();
            let store = owner.clone();
            std::thread::spawn(move || {
                start.wait();
                for iteration in 0..4 {
                    assert!(crate::testing::config_store(&path).is_err(), "no competing owner");
                    store
                        .commit(
                            &[put("setting", "server", json!({"port":8400 + worker * 10 + iteration}))],
                            "t",
                            "",
                            false,
                        )
                        .unwrap();
                    assert!(live_path(&store).exists());
                }
            })
        })
        .collect();
    for worker in workers {
        worker.join().unwrap();
    }
    assert_eq!(owner.head().unwrap(), 16);
    let live = live_path(&owner);
    drop(owner);
    assert!(
        !live.exists(),
        "settled owner cleans its workspace before releasing admission"
    );
    let final_store = crate::testing::config_store(&path).unwrap();
    assert_eq!(final_store.head().unwrap(), 16);
    assert_eq!(head(&Connection::open(&path).unwrap()).unwrap(), 16);
    drop(final_store);
    std::fs::remove_dir_all(dir).unwrap();
}
