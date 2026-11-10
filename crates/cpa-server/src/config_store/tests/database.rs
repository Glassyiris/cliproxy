use super::*;

fn database_path(name: &str) -> (PathBuf, PathBuf) {
    let dir = std::env::temp_dir().join(format!("cook-config-{name}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("cook.db");
    (dir, path)
}

fn live_path(store: &ConfigStore) -> PathBuf {
    PathBuf::from(store.conn().path().unwrap())
}

#[test]
fn opening_fresh_databases_serializes_migrations() {
    let (dir, path) = database_path("race");
    let start = std::sync::Arc::new(std::sync::Barrier::new(4));
    let workers: Vec<_> = (0..4)
        .map(|_| {
            let path = path.clone();
            let start = start.clone();
            std::thread::spawn(move || {
                start.wait();
                crate::testing::config_store(&path).unwrap()
            })
        })
        .collect();
    let stores: Vec<_> = workers.into_iter().map(|worker| worker.join().unwrap()).collect();
    let conn = stores[0].conn();
    assert_eq!(schema_version(&conn).unwrap(), MIGRATIONS.len());
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
        "only the process's last handle removes its marker"
    );
    assert!(working_dir.parent().unwrap().join("coordination.db").exists());
    assert!(!dir.join("cook.db-wal").exists());
    assert!(!dir.join("cook.db-shm").exists());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn offline_open_preserves_old_schema_and_migrating_open_upgrades_it() {
    let (dir, path) = database_path("old-read");
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    conn.pragma_update(None, "user_version", 1).unwrap();
    drop(conn);
    let store = crate::testing::config_store_without_migration(&path).unwrap();
    assert_eq!(schema_version(&store.conn()).unwrap(), 1);
    store.load().unwrap();
    assert!(store.conn().prepare("SELECT * FROM credential_document").is_err());
    drop(store);
    let store = crate::testing::config_store(&path).unwrap();
    assert_eq!(schema_version(&store.conn()).unwrap(), MIGRATIONS.len());
    assert!(store.conn().prepare("SELECT * FROM credential_document").is_ok());
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[test]
fn opening_tightens_snapshot_and_temporary_database_permissions() {
    use std::os::unix::fs::PermissionsExt as _;
    let (dir, path) = database_path("perms");
    let store = crate::testing::config_store(&path).unwrap();
    let live = live_path(&store);
    for file in [&path, &live] {
        std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o644)).unwrap();
    }
    std::fs::set_permissions(live.parent().unwrap(), std::fs::Permissions::from_mode(0o755)).unwrap();
    let another = crate::testing::config_store_without_migration(&path).unwrap();
    for file in [&path, &live] {
        assert_eq!(std::fs::metadata(file).unwrap().permissions().mode() & 0o777, 0o600);
    }
    assert_eq!(
        std::fs::metadata(live.parent().unwrap()).unwrap().permissions().mode() & 0o777,
        0o700
    );
    let mut conn = store.conn();
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
        let copied = crate::testing::config_store_without_migration(&copy).unwrap();
        assert_eq!(copied.get(Kind::Setting, "server").unwrap().unwrap().spec["port"], port);
    }
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn legacy_uncheckpointed_wal_is_preserved_in_the_published_backup() {
    let (dir, path) = database_path("legacy-wal");
    let legacy = Connection::open(&path).unwrap();
    legacy.execute_batch(SCHEMA).unwrap();
    legacy.pragma_update(None, "user_version", 1).unwrap();
    legacy.pragma_update(None, "journal_mode", "WAL").unwrap();
    legacy
        .set_db_config(rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)
        .unwrap();
    legacy
        .execute_batch(
            "INSERT INTO revision VALUES (1, '2026-01-01', 'test', '', '');
        INSERT INTO resource(kind, id, spec, rev, created_rev)
        VALUES ('setting', 'server', '{\"port\":8123}', 1, 1);",
        )
        .unwrap();
    drop(legacy);
    assert!(dir.join("cook.db-wal").exists());
    let store = crate::testing::config_store(&path).unwrap();
    let copy = dir.join("restored.db");
    std::fs::copy(&path, &copy).unwrap();
    assert_eq!(&std::fs::read(&copy).unwrap()[18..20], &[1, 1]);
    let restored = crate::testing::config_store_without_migration(&copy).unwrap();
    assert_eq!(
        restored.get(Kind::Setting, "server").unwrap().unwrap().spec["port"],
        8123
    );
    assert!(!dir.join("cook.db-wal").exists());
    assert!(!dir.join("cook.db-shm").exists());
    drop(restored);
    drop(store);
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
    let old = crate::testing::config_store_without_migration(&copy).unwrap();
    assert_eq!(old.get(Kind::Setting, "server").unwrap().unwrap().spec["port"], 8001);
    assert_eq!(store.get(Kind::Setting, "server").unwrap().unwrap().spec["port"], 8002);
    drop(old);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn raw_copies_remain_consistent_during_concurrent_commits() {
    let (dir, path) = database_path("copy-race");
    let store = crate::testing::config_store(&path).unwrap();
    store
        .commit(&[put("setting", "server", json!({"port":8200}))], "t", "", false)
        .unwrap();
    let second = crate::testing::config_store(&path).unwrap();
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
    let saved = dir.join("previous.db");
    std::fs::rename(&path, &saved).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert!(
        store
            .commit(&[put("setting", "server", json!({"port":8302}))], "t", "", false)
            .is_err()
    );
    std::fs::remove_dir(&path).unwrap();
    std::fs::rename(&saved, &path).unwrap();
    assert_eq!(head(&Connection::open(&path).unwrap()).unwrap(), 1);
    let resumed = crate::testing::config_store(&path).unwrap();
    assert_eq!(
        resumed.get(Kind::Setting, "server").unwrap().unwrap().spec["port"],
        8302
    );
    assert_eq!(head(&Connection::open(&path).unwrap()).unwrap(), 2);
    let live = live_path(&resumed);
    drop(store);
    assert!(live.exists());
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
    let saved = dir.join("previous.db");
    std::fs::rename(&path, &saved).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert!(store.commit(std::slice::from_ref(&op), "t", "", false).is_err());
    std::fs::remove_dir(&path).unwrap();
    std::fs::rename(&saved, &path).unwrap();
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
    resumed.conn().pragma_update(None, "user_version", 0).unwrap();
    assert!(crate::testing::config_store(&path).is_err());
    assert!(live.exists());
    drop(resumed);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn stale_working_directories_are_swept_but_active_orphans_are_not() {
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
    assert!(!stale.exists());
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
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn concurrent_open_and_last_exit_never_split_the_live_database() {
    let (dir, path) = database_path("lifetime-race");
    let start = std::sync::Arc::new(std::sync::Barrier::new(4));
    let workers: Vec<_> = (0..4)
        .map(|worker| {
            let path = path.clone();
            let start = start.clone();
            std::thread::spawn(move || {
                start.wait();
                for iteration in 0..4 {
                    let store = crate::testing::config_store(&path).unwrap();
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
    let final_store = crate::testing::config_store(&path).unwrap();
    assert_eq!(final_store.head().unwrap(), 16);
    assert_eq!(head(&Connection::open(&path).unwrap()).unwrap(), 16);
    drop(final_store);
    std::fs::remove_dir_all(dir).unwrap();
}
