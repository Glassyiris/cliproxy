use super::*;

#[test]
fn opening_fresh_databases_serializes_migrations() {
    let dir = std::env::temp_dir().join(format!("cook-config-race-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("cook.db");
    let start = std::sync::Arc::new(std::sync::Barrier::new(4));
    let workers: Vec<_> = (0..4)
        .map(|_| {
            let path = path.clone();
            let start = start.clone();
            std::thread::spawn(move || {
                start.wait();
                ConfigStore::open(&path).unwrap()
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
    drop(conn);
    drop(stores);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn offline_open_preserves_old_schema_and_migrating_open_upgrades_it() {
    let dir = std::env::temp_dir().join(format!("cook-config-old-read-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("cook.db");
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    conn.pragma_update(None, "user_version", 1).unwrap();
    drop(conn);
    let store = ConfigStore::open_without_migration(&path).unwrap();
    assert_eq!(schema_version(&store.conn()).unwrap(), 1);
    store.load().unwrap();
    assert!(store.conn().prepare("SELECT * FROM credential_document").is_err());
    drop(store);
    let store = ConfigStore::open(&path).unwrap();
    assert_eq!(schema_version(&store.conn()).unwrap(), MIGRATIONS.len());
    assert!(store.conn().prepare("SELECT * FROM credential_document").is_ok());
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[test]
fn opening_tightens_existing_database_and_sidecar_permissions() {
    use std::os::unix::fs::PermissionsExt as _;
    let dir = std::env::temp_dir().join(format!("cook-config-perms-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("cook.db");
    let store = ConfigStore::open(&path).unwrap();
    for name in ["cook.db", "cook.db-wal", "cook.db-shm"] {
        std::fs::set_permissions(dir.join(name), std::fs::Permissions::from_mode(0o644)).unwrap();
    }
    let another = ConfigStore::open_without_migration(&path).unwrap();
    for name in ["cook.db", "cook.db-wal", "cook.db-shm"] {
        assert_eq!(
            std::fs::metadata(dir.join(name)).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    drop(another);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn busy_checkpoints_do_not_wait_and_restore_the_store_timeout() {
    let dir = std::env::temp_dir().join(format!("cook-config-checkpoint-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("cook.db");
    let store = ConfigStore::open(&path).unwrap();
    store
        .commit(&[put("setting", "server", json!({"port":8001}))], "t", "", false)
        .unwrap();
    let mut reader = Connection::open(&path).unwrap();
    let snapshot = reader.transaction().unwrap();
    assert_eq!(head(&snapshot).unwrap(), 1);
    let start = std::time::Instant::now();
    store
        .commit(&[put("setting", "server", json!({"port":8002}))], "t", "", false)
        .unwrap();
    assert!(start.elapsed() < std::time::Duration::from_secs(2));
    assert_eq!(
        store
            .conn()
            .pragma_query_value(None, "busy_timeout", |row| row.get::<_, i64>(0))
            .unwrap(),
        5000
    );
    drop(snapshot);
    drop(reader);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}
