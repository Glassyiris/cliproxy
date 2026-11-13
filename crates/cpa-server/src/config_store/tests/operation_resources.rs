//! Operation-lifetime checks through real commands and private filesystem effects.
//! Linux supplies the descriptor oracle; other Unix targets still run the privacy test.
#[cfg(unix)]
use super::*;

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use crate::credential_store::CredentialDb;
    use crate::testing::installation_effects::{self, Stage};

    // Inspect only this fixture. Read existing descriptors with pread, not by
    // opening/closing another file on a SQLite inode (which can release locks).
    // A future non-SQLite ownership-lock FD is deliberately not a connection.
    fn sqlite_descriptors(directory: &Path) -> Vec<PathBuf> {
        let mut open = Vec::new();
        for entry in std::fs::read_dir("/proc/self/fd").expect("Linux descriptor oracle requires procfs") {
            let entry = entry.unwrap();
            let Ok(target) = std::fs::read_link(entry.path()) else {
                continue;
            };
            if !target.starts_with(directory) {
                continue;
            }
            let fd: i32 = entry.file_name().to_str().unwrap().parse().unwrap();
            let mut header = [0u8; 16];
            // SAFETY: pread borrows the enumerated descriptor, writes only within
            // header, and neither changes its offset nor takes ownership. A
            // concurrently closed descriptor yields an error, not an owned FD.
            let n = unsafe { libc::pread(fd, header.as_mut_ptr().cast(), header.len(), 0) };
            if n == 16 && &header == b"SQLite format 3\0" {
                open.push(target);
            }
        }
        open
    }

    fn assert_closed(directory: &Path) {
        assert_eq!(
            sqlite_descriptors(directory),
            Vec::<PathBuf>::new(),
            "retained fixture SQLite descriptor"
        );
    }

    fn fixture() -> (PathBuf, PathBuf) {
        let directory = std::env::temp_dir().join(format!("cook-operation-resources-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("config.db");
        (directory, path)
    }

    fn command(store: &ConfigStore, port: u16) -> Result<Committed, CommitError> {
        store.commit(&[put("setting", "server", json!({"port": port}))], "test", "", false)
    }

    #[test]
    fn detector_catches_real_sqlite_handles_including_replaced_inodes() {
        let (dir, path) = fixture();
        let store = crate::testing::config_store(&path).unwrap();
        assert_closed(&dir);
        let held = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        held.query_row("SELECT count(*) FROM resource", [], |r| r.get::<_, i64>(0))
            .unwrap();
        assert_eq!(sqlite_descriptors(&dir), vec![path.clone()]);
        command(&store, 8701).unwrap();
        let replaced = sqlite_descriptors(&dir);
        assert_eq!(
            replaced.len(),
            1,
            "positive control must retain its real SQLite descriptor"
        );
        assert!(replaced[0].as_os_str().as_encoded_bytes().ends_with(b" (deleted)"));
        held.close().unwrap();
        assert_closed(&dir);
        assert_eq!(store.load().unwrap().config.port, 8701);
        assert_closed(&dir);
        drop(store);
        assert_closed(&dir);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn commands_credentials_callbacks_and_backups_release_sqlite_resources() {
        let (dir, path) = fixture();
        let store = Arc::new(crate::testing::config_store(&path).unwrap());
        assert_closed(&dir); // Immediately after bootstrap, before any query.
        let scope = dir.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let subscription = store
            .subscribe_configuration(move |_| {
                tx.send(sqlite_descriptors(&scope)).unwrap();
                anyhow::bail!("fixture subscriber failure")
            })
            .unwrap();
        assert!(rx.recv().unwrap().is_empty()); // Initial delivery.
        command(&store, 8702).unwrap();
        assert!(rx.recv().unwrap().is_empty()); // Committed delivery, before success.
        assert_closed(&dir);
        let before = std::fs::read(&path).unwrap();
        assert!(store.import_yaml("[", "test", "").is_err());
        assert_closed(&dir);
        let op = put("setting", "server", json!({"port": 8703}));
        assert!(
            store
                .commit_if(
                    std::slice::from_ref(&op),
                    "test",
                    "",
                    false,
                    Some(Precondition::Revision(0))
                )
                .is_err()
        );
        assert_closed(&dir);
        assert!(!store.commit(&[op], "test", "", true).unwrap().written);
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_closed(&dir);
        let db = CredentialDb::initialize(store.clone(), &dir.join("legacy")).unwrap();
        assert_closed(&dir);
        let credential = db.auth_dir().join("fixture.json");
        db.save(&credential, b"{\"refresh_token\":\"fixture-only\"}").unwrap();
        assert_closed(&dir);
        assert!(db.read(&credential).unwrap().is_some());
        assert_closed(&dir);
        store.backup(&dir.join("backup.db")).unwrap();
        assert_closed(&dir);
        assert!(store.backup(&dir.join("backup.db")).is_err());
        assert_closed(&dir);
        // The output itself fits NAME_MAX, but SQLite's rollback journal does
        // not. This fails after opening the fresh image, during schema creation.
        let failed_output = dir.join("x".repeat(250));
        let error = store.backup(&failed_output).unwrap_err();
        assert!(
            error.downcast_ref::<rusqlite::Error>().is_some(),
            "expected SQLite encoding failure: {error}"
        );
        assert!(!failed_output.exists(), "failed encoding must remove its output");
        assert_closed(&dir);
        drop((subscription, db, store));
        let reopened = crate::testing::existing_config_store(&path).unwrap();
        assert_closed(&dir);
        assert_eq!(reopened.load().unwrap().config.port, 8702);
        drop(reopened);
        assert_closed(&dir);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn checkpoint_and_publication_errors_close_resources_before_retry() {
        for checkpoint in [true, false] {
            for stage in [Stage::BeforeReplace, Stage::AfterReplace] {
                let (dir, path) = fixture();
                let store = crate::testing::config_store(&path).unwrap();
                let live = PathBuf::from(crate::testing::database_connection(&store).path().unwrap());
                assert_closed(&dir);
                let destination = if checkpoint { &live } else { &path };
                let fault = installation_effects::once(destination, stage, || {
                    Err(std::io::Error::other("fixture install failure"))
                });
                assert!(command(&store, 8704).is_err());
                assert_closed(&dir);
                assert_eq!(store.load().unwrap().config.port, 0);
                assert_closed(&dir);
                drop(fault);
                if !checkpoint || matches!(stage, Stage::AfterReplace) {
                    let retry_fault = installation_effects::once(&path, Stage::BeforeReplace, || {
                        Err(std::io::Error::other("fixture retry failure"))
                    });
                    assert!(command(&store, 8704).is_err());
                    assert_closed(&dir);
                    assert_eq!(store.load().unwrap().config.port, 0);
                    drop(retry_fault);
                }
                command(&store, 8704).unwrap();
                assert_eq!(store.load().unwrap().config.port, 8704);
                assert_closed(&dir);
                let obstruction = crate::testing::block_checkpoint_install(&store);
                assert!(command(&store, 8705).is_err());
                assert_closed(&dir);
                drop(obstruction);
                command(&store, 8705).unwrap();
                assert_closed(&dir);
                drop(store);
                assert_closed(&dir);
                std::fs::remove_dir_all(dir).unwrap();
            }
        }
    }

    #[test]
    fn bootstrap_schema_and_decode_errors_release_all_fixture_connections() {
        for resume in [false, true] {
            for newer in [true, false] {
                let (dir, path) = fixture();
                let store = crate::testing::config_store(&path).unwrap();
                let live = PathBuf::from(crate::testing::database_connection(&store).path().unwrap());
                let mut held = if resume {
                    Some(store)
                } else {
                    drop(store);
                    None
                };
                let conn = Connection::open(if resume { &live } else { &path }).unwrap();
                if newer {
                    conn.pragma_update(None, "user_version", 999).unwrap();
                } else {
                    conn.execute(
                        "INSERT INTO resource(kind,id,spec,rev,created_rev) VALUES ('unknown','fixture','{}',1,1)",
                        [],
                    )
                    .unwrap();
                }
                conn.close().unwrap();
                assert_closed(&dir);
                if let Some(store) = held.take() {
                    assert_eq!(store.load().unwrap().config.port, 0);
                    let image = std::fs::read(&live).unwrap();
                    drop(store);
                    // Preserve the deliberately invalid unowned crash image;
                    // an active owner must never be bypassed to exercise resume.
                    std::fs::create_dir_all(live.parent().unwrap()).unwrap();
                    std::fs::write(&live, image).unwrap();
                }
                let error = crate::testing::config_store(&path)
                    .err()
                    .expect("invalid bootstrap must fail");
                if newer {
                    assert!(error.to_string().contains("not supported"), "{error}");
                }
                assert_closed(&dir);
                assert_closed(&dir);
                std::fs::remove_dir_all(dir).unwrap();
            }
        }
        for stage in [Stage::BeforeReplace, Stage::AfterReplace] {
            let (dir, path) = fixture();
            let fault = installation_effects::once(&path, stage, || {
                Err(std::io::Error::other("fixture bootstrap publication failure"))
            });
            assert!(crate::testing::config_store(&path).is_err());
            assert_closed(&dir);
            drop(fault);
            let recovered = crate::testing::config_store(&path).unwrap();
            assert_closed(&dir);
            drop(recovered);
            assert_closed(&dir);
            std::fs::remove_dir_all(dir).unwrap();
        }
    }
}

#[cfg(unix)]
#[test]
fn images_and_workspace_remain_private_before_and_after_installation() {
    use crate::testing::installation_effects::{self, Stage};
    use std::os::unix::fs::PermissionsExt as _;

    fn private_tree(path: &Path) {
        let metadata = std::fs::metadata(path).unwrap();
        assert_eq!(
            metadata.permissions().mode() & 0o777,
            if metadata.is_dir() { 0o700 } else { 0o600 }
        );
        if metadata.is_dir() {
            for entry in std::fs::read_dir(path).unwrap() {
                private_tree(&entry.unwrap().path());
            }
        }
    }

    let dir = std::env::temp_dir().join(format!("cook-operation-privacy-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let path = dir.join("config.db");
    let store = crate::testing::config_store(&path).unwrap();
    let live = PathBuf::from(crate::testing::database_connection(&store).path().unwrap());
    let root = live.parent().unwrap().parent().unwrap();
    private_tree(root);
    private_tree(&path);
    let mut guards = Vec::new();
    for destination in [&live, &path] {
        let parent = destination.parent().unwrap().to_owned();
        guards.push(installation_effects::once(
            destination,
            Stage::BeforeReplace,
            move || {
                // Includes the still-unpublished construction image.
                for entry in std::fs::read_dir(parent)? {
                    let path = entry?.path();
                    if path.is_file() {
                        private_tree(&path);
                    }
                }
                Ok(())
            },
        ));
    }
    store
        .commit(&[put("setting", "server", json!({"port": 8706}))], "test", "", false)
        .unwrap();
    private_tree(root);
    private_tree(&path);
    let backup = dir.join("backup.db");
    store.backup(&backup).unwrap();
    private_tree(&backup);
    drop(guards);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}
