//! Raw credential source documents in the config database. The private, stable
//! working directory is a cache for existing provider/plugin file protocols; only
//! SQLite is durable, and these rows never enter config revisions or exports.

use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use anyhow::{Context as _, bail};
use rusqlite::{OptionalExtension, TransactionBehavior, params};

use crate::config_store::ConfigStore;
use crate::cooldown_store::{Backend, Record};

pub struct CredentialDb {
    store: Arc<ConfigStore>,
    dir: PathBuf,
}

/// Absolute lexical identity for credential documents and their refresh locks.
/// Windows canonicalization adds a verbatim disk prefix; ordinary writers do not.
pub fn credential_path_key(path: &Path) -> std::io::Result<PathBuf> {
    let absolute = std::path::absolute(path)?;
    let mut clean = PathBuf::new();
    for component in absolute.components() {
        match component {
            #[cfg(windows)]
            Component::Prefix(prefix) if matches!(prefix.kind(), std::path::Prefix::VerbatimDisk(_)) => {
                let std::path::Prefix::VerbatimDisk(drive) = prefix.kind() else {
                    unreachable!()
                };
                clean.push(format!("{}:", char::from(drive)));
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(clean.components().next_back(), Some(Component::Normal(_))) {
                    clean.pop();
                }
            }
            component => clean.push(component.as_os_str()),
        }
    }
    Ok(clean)
}

impl CredentialDb {
    /// Imports legacy credentials exactly once, independently of config import, and
    /// recreates the working copies from SQLite. Never attach this in Home mode.
    pub fn initialize(store: Arc<ConfigStore>, legacy_auth_dir: &Path) -> anyhow::Result<Arc<Self>> {
        let path = store
            .path()
            .context("credential persistence requires an on-disk database")?;
        // Resolve aliases before deriving both the working path and refresh-lock identity.
        let mut dir = credential_path_key(&std::fs::canonicalize(path)?)?.into_os_string();
        dir.push(".credentials");
        let db = Arc::new(Self {
            store,
            dir: PathBuf::from(dir),
        });
        private_dir(&db.dir)?;
        let _init = cpa_exec::codex_siwc_bind::lock_file(&db.dir.join(".initialize")).map_err(anyhow::Error::msg)?;
        db.import_legacy(legacy_auth_dir)?;
        db.materialize()?;
        Ok(db)
    }

    pub fn auth_dir(&self) -> PathBuf {
        self.dir.clone()
    }

    fn name(&self, path: &Path) -> anyhow::Result<String> {
        let absolute = credential_path_key(path)?;
        let (prefix, path) = match absolute.strip_prefix(&self.dir) {
            Ok(relative) if !relative.as_os_str().is_empty() => ("local:", relative),
            _ => ("external:", absolute.as_path()),
        };
        Ok(format!(
            "{prefix}{}",
            path.to_str().context("credential path is not UTF-8")?
        ))
    }

    fn path(&self, name: &str) -> anyhow::Result<PathBuf> {
        if let Some(relative) = name.strip_prefix("local:") {
            let relative = Path::new(relative);
            anyhow::ensure!(
                !relative.as_os_str().is_empty()
                    && relative
                        .components()
                        .all(|p| matches!(p, std::path::Component::Normal(_))),
                "invalid stored credential path"
            );
            return Ok(self.dir.join(relative));
        }
        if let Some(absolute) = name.strip_prefix("external:").map(Path::new)
            && absolute.is_absolute()
        {
            return Ok(absolute.to_owned());
        }
        bail!("invalid stored credential path")
    }

    fn import_legacy(&self, dir: &Path) -> anyhow::Result<()> {
        let _coordination = self.store.write_guard()?;
        let mut conn = self.store.conn();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let imported: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM credential_meta WHERE name = 'legacy_auth_imported')",
            [],
            |r| r.get(0),
        )?;
        if imported {
            drop(tx);
            self.store.publish(&conn)?;
            return Ok(());
        }
        for path in json_files(dir, false)? {
            let relative = path.strip_prefix(dir)?;
            let target = self.dir.join(relative);
            let bytes = std::fs::read(&path).with_context(|| format!("read legacy credential {}", path.display()))?;
            // Import source bytes, including plugin-only/unknown documents, verbatim.
            tx.execute(
                "INSERT INTO credential_document(name, bytes) VALUES (?1, ?2) ON CONFLICT(name) DO NOTHING",
                params![self.name(&target)?, bytes],
            )?;
        }
        let records = crate::cooldown_store::load(dir).map_err(anyhow::Error::msg)?;
        write_cooldowns(&tx, records, SystemTime::now())?;
        tx.execute(
            "INSERT INTO credential_meta(name, value) VALUES ('legacy_auth_imported', '1')",
            [],
        )?;
        tx.commit()?;
        self.store.publish(&conn)?;
        Ok(())
    }

    /// The original source bytes, read from SQLite even if the working file is gone.
    pub fn read(&self, path: &Path) -> anyhow::Result<Option<Vec<u8>>> {
        Ok(self
            .store
            .conn()
            .query_row(
                "SELECT bytes FROM credential_document WHERE name = ?1",
                [self.name(path)?],
                |r| r.get(0),
            )
            .optional()?)
    }

    pub fn documents(&self) -> anyhow::Result<Vec<(PathBuf, Vec<u8>)>> {
        let conn = self.store.conn();
        let mut query = conn.prepare("SELECT name, bytes FROM credential_document ORDER BY name")?;
        let rows = query.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?)))?;
        rows.map(|r| {
            let (name, bytes) = r?;
            Ok((self.path(&name)?, bytes))
        })
        .collect()
    }

    /// Synthesizes all canonical documents, including plugin paths outside the
    /// top-level working directory, through the same parser as legacy file scans.
    pub fn scan(&self, config: &cpa_core::config::Config) -> anyhow::Result<cpa_core::config::credentials::AuthScan> {
        Ok(cpa_core::config::credentials::scan_documents(config, self.documents()?))
    }

    /// Plugin parsers run outside management/runtime locks; scans consume only
    /// their cached answers for these exact canonical source bytes.
    pub fn preparse(&self, config: &cpa_core::config::Config) -> anyhow::Result<()> {
        cpa_core::config::credentials::preparse_documents(config, self.documents()?);
        Ok(())
    }

    /// Commits before any caller may publish the new credential. The SQLite write
    /// lock covers materialization too, so another process cannot restore old bytes
    /// between the provider write and its durable acknowledgement.
    pub fn save(&self, path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
        self.save_checked(path, bytes, None).map(|_| ())
    }

    /// Checks the source-byte hash inside the same transaction as the write.
    /// `None` expects an absent document; `false` leaves SQL and memory untouched.
    pub fn save_if_current(&self, path: &Path, bytes: &[u8], expected: Option<[u8; 32]>) -> anyhow::Result<bool> {
        self.save_checked(path, bytes, Some(expected))
    }

    fn save_checked(&self, path: &Path, bytes: &[u8], expected: Option<Option<[u8; 32]>>) -> anyhow::Result<bool> {
        let result = (|| {
            let _coordination = self.store.write_guard()?;
            let mut conn = self.store.conn();
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let name = self.name(path)?;
            if let Some(expected) = expected {
                let held: Option<Vec<u8>> = tx
                    .query_row("SELECT bytes FROM credential_document WHERE name = ?1", [&name], |r| {
                        r.get(0)
                    })
                    .optional()?;
                let held = held
                    .as_deref()
                    .map(|b| <sha2::Sha256 as sha2::Digest>::digest(b).into());
                if held != expected {
                    return Ok(false);
                }
            }
            put(&tx, &name, Some(bytes))?;
            materialize(path, bytes)?;
            tx.commit()?;
            self.store.publish(&conn)?;
            Ok(true)
        })();
        if result.is_err() {
            let _ = self.restore(path);
        }
        result
    }

    /// Hydrates canonical documents, runs provider/plugin writers, then commits
    /// their final source documents together under the SQLite write lock. A failed
    /// write or transaction restores the unchanged canonical working documents.
    pub fn write_files<T>(&self, paths: &[PathBuf], write: impl FnOnce() -> anyhow::Result<T>) -> anyhow::Result<T> {
        let result = (|| {
            let _coordination = self.store.write_guard()?;
            let mut conn = self.store.conn();
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            for path in paths {
                self.restore_in(&tx, path)?;
            }
            let value = write()?;
            for path in paths {
                persist_file(self, &tx, path)?;
            }
            tx.commit()?;
            self.store.publish(&conn)?;
            Ok(value)
        })();
        if result.is_err() {
            for path in paths {
                // Preserve the original error; a broken cache is rebuilt at the next load.
                let _ = self.restore(path);
            }
        }
        result
    }

    /// A missing cache file does not prevent deletion and cannot resurrect the
    /// document on restart. File and SQL changes finish before acknowledgement.
    pub fn delete(&self, path: &Path) -> anyhow::Result<()> {
        self.write_files(std::slice::from_ref(&path.to_owned()), || remove(path))
    }

    /// Refresh callers invoke this under the stable document lock before spending
    /// a refresh token, so another process's committed grant is adopted first.
    pub fn restore(&self, path: &Path) -> anyhow::Result<()> {
        let mut conn = self.store.conn();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        self.restore_in(&tx, path)?;
        tx.commit()?;
        Ok(())
    }

    fn restore_in(&self, conn: &rusqlite::Connection, path: &Path) -> anyhow::Result<()> {
        let bytes: Option<Vec<u8>> = conn
            .query_row(
                "SELECT bytes FROM credential_document WHERE name = ?1",
                [self.name(path)?],
                |r| r.get(0),
            )
            .optional()?;
        match bytes {
            Some(bytes) => materialize(path, &bytes),
            None => remove(path),
        }
    }

    /// Recreates documents and clears abandoned cache files. Each restoration
    /// holds SQLite's write lock through the copy; it cannot overwrite a newer save.
    pub fn materialize(&self) -> anyhow::Result<()> {
        private_dir(&self.dir)?;
        let mut paths: BTreeSet<PathBuf> = json_files(&self.dir, true)?.into_iter().collect();
        paths.extend(self.documents()?.into_iter().map(|(path, _)| path));
        for path in paths {
            self.restore(&path)?;
        }
        Ok(())
    }
}

impl Backend for CredentialDb {
    fn load(&self) -> Result<Vec<Record>, String> {
        let load = || -> anyhow::Result<Vec<Record>> {
            let conn = self.store.conn();
            let mut query = conn.prepare("SELECT record FROM credential_cooldown ORDER BY id")?;
            let rows = query.query_map([], |r| r.get::<_, String>(0))?;
            rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
        };
        load().map_err(|e| e.to_string())
    }

    fn save(&self, records: Vec<Record>, now: SystemTime) -> Result<(), String> {
        let save = || -> anyhow::Result<()> {
            let _coordination = self.store.write_guard()?;
            let mut conn = self.store.conn();
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            write_cooldowns(&tx, records, now)?;
            tx.commit()?;
            self.store.publish(&conn)?;
            Ok(())
        };
        save().map_err(|e| e.to_string())
    }
}

fn write_cooldowns(conn: &rusqlite::Connection, records: Vec<Record>, now: SystemTime) -> anyhow::Result<()> {
    conn.execute("DELETE FROM credential_cooldown", [])?;
    for mut record in records {
        record.updated_at = Some(now);
        let id = serde_json::to_string(&(&record.auth_id, &record.model))?;
        conn.execute(
            "INSERT OR REPLACE INTO credential_cooldown(id, record) VALUES (?1, ?2)",
            params![id, serde_json::to_string(&record)?],
        )?;
    }
    Ok(())
}

fn persist_file(db: &CredentialDb, conn: &rusqlite::Connection, path: &Path) -> anyhow::Result<()> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e).with_context(|| format!("read credential {}", path.display())),
    };
    put(conn, &db.name(path)?, bytes.as_deref())
}

fn put(conn: &rusqlite::Connection, name: &str, bytes: Option<&[u8]>) -> anyhow::Result<()> {
    match bytes {
        Some(bytes) => {
            conn.execute(
                "INSERT INTO credential_document(name, bytes) VALUES (?1, ?2)
                 ON CONFLICT(name) DO UPDATE SET bytes = excluded.bytes, rev = credential_document.rev + 1
                 WHERE credential_document.bytes != excluded.bytes",
                params![name, bytes],
            )?;
        }
        None => {
            conn.execute("DELETE FROM credential_document WHERE name = ?1", [name])?;
        }
    }
    Ok(())
}

fn create_dir(dir: &Path) -> anyhow::Result<()> {
    let mut create = std::fs::DirBuilder::new();
    create.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut create, 0o700);
    create.create(dir)?;
    anyhow::ensure!(
        std::fs::symlink_metadata(dir)?.file_type().is_dir(),
        "credential working directory is not a directory"
    );
    Ok(())
}

fn private_dir(dir: &Path) -> anyhow::Result<()> {
    create_dir(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        if std::fs::metadata(dir)?.permissions().mode() & 0o777 != 0o700 {
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        }
    }
    Ok(())
}

fn materialize(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    // Avoid replacing equal files: provenance, plugin parse caches and file times
    // remain stable when a config-only reload hydrates the credential cache.
    if std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_file())
        && std::fs::read(path).ok().as_deref() == Some(bytes)
    {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        create_dir(parent)?;
    }
    cpa_plugin::auth::atomic_write(path, bytes).map_err(anyhow::Error::msg)
}

fn remove(path: &Path) -> anyhow::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e).with_context(|| format!("remove credential working file {}", path.display())),
    }
}

fn json_files(dir: &Path, recursive: bool) -> anyhow::Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e).with_context(|| format!("read credential directory {}", dir.display())),
    };
    for entry in entries {
        let entry = entry?;
        let ty = entry.file_type()?;
        if ty.is_dir() && recursive {
            out.extend(json_files(&entry.path(), true)?);
        } else if (ty.is_file() || (ty.is_symlink() && std::fs::metadata(entry.path()).is_ok_and(|m| m.is_file())))
            && entry
                .path()
                .extension()
                .is_some_and(|ext| ext.as_encoded_bytes().eq_ignore_ascii_case(b"json"))
        {
            out.push(entry.path());
        }
    }
    out.sort();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn directory() -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "cpa-credential-db-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn retrying_a_failed_legacy_import_republishes_with_the_same_store() {
        let root = directory();
        let path = root.join("cook.db");
        let store = Arc::new(crate::testing::config_store(&path).unwrap());
        let legacy = root.join("legacy");
        std::fs::create_dir(&legacy).unwrap();
        let bytes = br#"{"type":"private","access_token":"test-only"}"#;
        std::fs::write(legacy.join("login.json"), bytes).unwrap();
        let saved = root.join("previous.db");
        std::fs::rename(&path, &saved).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(CredentialDb::initialize(store.clone(), &legacy).is_err());
        std::fs::remove_dir(&path).unwrap();
        std::fs::rename(&saved, &path).unwrap();
        let retried = CredentialDb::initialize(store.clone(), &legacy).unwrap();
        let published = rusqlite::Connection::open(&path).unwrap();
        let count: i64 = published
            .query_row("SELECT count(*) FROM credential_document", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            count, 1,
            "successful initialization must publish the previously committed import"
        );
        assert_eq!(
            retried.read(&retried.auth_dir().join("login.json")).unwrap().as_deref(),
            Some(bytes.as_slice())
        );
        drop(published);
        drop(retried);
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn initialize_save_reopen_documents_round_trip() {
        let root = directory();
        let path = root.join("cook.db");
        let db = CredentialDb::initialize(
            Arc::new(crate::testing::config_store(&path).unwrap()),
            &root.join("missing"),
        )
        .unwrap();
        let local = db.auth_dir().join("auth.json");
        let nested = db.auth_dir().join("nested/auth.json");
        let external = root.join("external.json");
        for path in [&local, &nested, &external] {
            db.save(path, b"{\"type\":\"private\"}").unwrap();
            assert_eq!(db.path(&db.name(path).unwrap()).unwrap(), *path);
        }
        assert_eq!(db.name(&local).unwrap(), "local:auth.json");
        assert!(db.name(&nested).unwrap().starts_with("local:nested"));
        assert!(db.name(&external).unwrap().starts_with("external:"));
        let before = db.documents().unwrap();
        drop(db);
        let db = CredentialDb::initialize(
            Arc::new(crate::testing::config_store(&path).unwrap()),
            &root.join("missing"),
        )
        .unwrap();
        assert_eq!(db.documents().unwrap(), before);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn save_replaces_fifo_symlink_without_reading_target() {
        use std::os::unix::fs::{FileTypeExt as _, symlink};

        let root = directory();
        let db = CredentialDb::initialize(
            Arc::new(crate::testing::config_store(&root.join("cook.db")).unwrap()),
            &root.join("missing"),
        )
        .unwrap();
        let path = db.auth_dir().join("auth.json");
        db.save(&path, b"{\"token\":\"before\"}").unwrap();
        std::fs::remove_file(&path).unwrap();
        let fifo = root.join("pipe");
        let name = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
        // SAFETY: valid NUL-terminated path in this test's private directory.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        symlink(&fifo, &path).unwrap();

        let bytes = b"{\"token\":\"after\"}";
        let (tx, rx) = std::sync::mpsc::channel();
        let (writer_db, writer_path) = (db.clone(), path.clone());
        let writer = std::thread::spawn(move || tx.send(writer_db.save(&writer_path, bytes)).unwrap());
        rx.recv_timeout(std::time::Duration::from_secs(2))
            .expect("saving must replace the FIFO symlink without opening it")
            .unwrap();
        writer.join().unwrap();

        assert!(std::fs::symlink_metadata(&path).unwrap().file_type().is_file());
        assert!(std::fs::symlink_metadata(&fifo).unwrap().file_type().is_fifo());
        assert_eq!(db.read(&path).unwrap().as_deref(), Some(bytes.as_slice()));
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_import_ignores_nested_and_unreadable_directories() {
        let root = directory();
        let legacy = root.join("legacy");
        let nested = legacy.join("..2024_mount");
        let unreadable = legacy.join("lost+found");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::create_dir_all(&unreadable).unwrap();
        std::fs::write(nested.join("nested.json"), b"{}").unwrap();
        std::fs::write(legacy.join("auth.JSON"), b"{}").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::{PermissionsExt as _, symlink};
            symlink("..2024_mount/nested.json", legacy.join("linked.json")).unwrap();
            std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o000)).unwrap();
        }
        let db = CredentialDb::initialize(
            Arc::new(crate::testing::config_store(&root.join("cook.db")).unwrap()),
            &legacy,
        )
        .unwrap();
        let names: Vec<_> = db
            .documents()
            .unwrap()
            .into_iter()
            .map(|(path, _)| db.name(&path).unwrap())
            .collect();
        #[cfg(unix)]
        assert_eq!(names, ["local:auth.JSON", "local:linked.json"]);
        #[cfg(not(unix))]
        assert_eq!(names, ["local:auth.JSON"]);
        drop(db);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn unix_path_keys_clean_local_nested_and_external_names() {
        let db = CredentialDb {
            store: Arc::new(ConfigStore::memory_with("")),
            dir: "/cache".into(),
        };
        for (path, name, clean) in [
            ("/cache/./auth.json", "local:auth.json", "/cache/auth.json"),
            (
                "/cache/sub/../nested/auth.json",
                "local:nested/auth.json",
                "/cache/nested/auth.json",
            ),
            ("/outside/../external.json", "external:/external.json", "/external.json"),
        ] {
            assert_eq!(db.name(Path::new(path)).unwrap(), name);
            assert_eq!(db.path(name).unwrap(), Path::new(clean));
        }
        assert_eq!(
            credential_path_key(Path::new("./auth.json")).unwrap(),
            std::env::current_dir().unwrap().join("auth.json")
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_disk_and_verbatim_path_keys_round_trip() {
        let db = CredentialDb {
            store: Arc::new(ConfigStore::memory_with("")),
            dir: r"C:\cache".into(),
        };
        for path in [r"C:\cache\nested\..\auth.json", r"\\?\C:\cache\nested\..\auth.json"] {
            assert_eq!(
                credential_path_key(Path::new(path)).unwrap(),
                Path::new(r"C:\cache\auth.json")
            );
            assert_eq!(db.name(Path::new(path)).unwrap(), "local:auth.json");
            assert_eq!(db.path("local:auth.json").unwrap(), Path::new(r"C:\cache\auth.json"));
        }
        let path = Path::new(r"\\?\D:\external\auth.json");
        assert_eq!(db.name(path).unwrap(), r"external:D:\external\auth.json");
        assert_eq!(
            db.path(&db.name(path).unwrap()).unwrap(),
            Path::new(r"D:\external\auth.json")
        );
    }

    #[test]
    fn raw_documents_and_deletions_survive_discarded_cache_without_legacy_resurrection() {
        let root = directory();
        let legacy = root.join("legacy");
        std::fs::create_dir_all(&legacy).unwrap();
        let original = b"{\n  \"type\":\"plugin-private\",\"opaque\":{\"secret\":\"first\"}\n}\n";
        std::fs::write(legacy.join("auth.json"), original).unwrap();
        let path = root.join("cook.db");
        let store = Arc::new(crate::testing::config_store(&path).unwrap());
        store
            .import_yaml("server: {port: 8317}\n", "test", "preinitialized config")
            .unwrap();
        let config_head = store.snapshot().unwrap().0;
        let db = CredentialDb::initialize(store.clone(), &legacy).unwrap();
        let auth = db.auth_dir().join("auth.json");
        assert_eq!(db.read(&auth).unwrap().unwrap(), original);
        let updated = b"{\"type\":\"plugin-private\",\"opaque\":[1,2],\"access_token\":\"second\"}\n";
        db.save(&auth, updated).unwrap();
        assert_eq!(store.snapshot().unwrap().0, config_head);
        assert!(!store.load().unwrap().text.contains("second"));
        let dir = db.auth_dir();
        drop(db);
        drop(store);
        std::fs::remove_dir_all(&dir).unwrap();
        let db = CredentialDb::initialize(Arc::new(crate::testing::config_store(&path).unwrap()), &legacy).unwrap();
        assert_eq!(std::fs::read(&auth).unwrap(), updated);
        std::fs::remove_file(&auth).unwrap();
        db.delete(&auth).unwrap();
        drop(db);
        std::fs::remove_dir_all(&dir).unwrap();
        let db = CredentialDb::initialize(Arc::new(crate::testing::config_store(&path).unwrap()), &legacy).unwrap();
        assert!(db.read(&auth).unwrap().is_none());
        assert!(!auth.exists());
        assert!(legacy.join("auth.json").exists());
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn canonical_scan_preserves_external_documents_and_auth_indexes_across_restart() {
        let root = directory();
        let path = root.join("cook.db");
        let store = Arc::new(crate::testing::config_store(&path).unwrap());
        store.import_yaml("oauth: {}\n", "test", "").unwrap();
        let db = CredentialDb::initialize(store.clone(), &root.join("missing")).unwrap();
        let nested = db.auth_dir().join("nested/auth.json");
        let external = root.join("explicit.json");
        let bytes = br#"{"type":"claude","access_token":"durable","opaque":{"plugin":"kept"}}"#;
        db.save(&nested, bytes).unwrap();
        db.save(&external, bytes).unwrap();
        let mut cfg = store.load().unwrap().config;
        cfg.auth_dir = db.auth_dir();
        let identities = |db: &CredentialDb| {
            db.scan(&cfg)
                .unwrap()
                .credentials
                .iter()
                .map(|c| (c.id.clone(), cpa_core::config::credentials::auth_index(c)))
                .collect::<Vec<_>>()
        };
        let before = identities(&db);
        assert_eq!(before.len(), 2);
        let dir = db.auth_dir();
        drop(db);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
        std::fs::remove_file(&external).unwrap();
        let db = CredentialDb::initialize(
            Arc::new(crate::testing::config_store(&path).unwrap()),
            &root.join("missing"),
        )
        .unwrap();
        assert_eq!(identities(&db), before);
        assert_eq!(db.read(&nested).unwrap().unwrap(), bytes);
        assert_eq!(std::fs::read(&external).unwrap(), bytes);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_batch_is_atomic_and_restores_working_documents() {
        let root = directory();
        let store = Arc::new(crate::testing::config_store(&root.join("cook.db")).unwrap());
        let db = CredentialDb::initialize(store.clone(), &root.join("missing")).unwrap();
        let first = db.auth_dir().join("first.json");
        let second = db.auth_dir().join("second.json");
        db.save(&first, b"{\"old\":true}").unwrap();
        store.conn().execute_batch("CREATE TRIGGER fail_second BEFORE INSERT ON credential_document WHEN NEW.name = 'local:second.json' BEGIN SELECT RAISE(ABORT, 'injected durable failure'); END;").unwrap();
        assert!(
            db.write_files(&[first.clone(), second.clone()], || {
                std::fs::write(&first, b"{\"new\":true}")?;
                std::fs::write(&second, b"{\"new\":true}")?;
                Ok(())
            })
            .is_err()
        );
        assert_eq!(db.read(&first).unwrap().unwrap(), b"{\"old\":true}");
        assert_eq!(std::fs::read(&first).unwrap(), b"{\"old\":true}");
        assert!(db.read(&second).unwrap().is_none());
        assert!(!second.exists());
        drop(db);
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cooldown_records_survive_removal_of_working_directory() {
        let root = directory();
        let path = root.join("cook.db");
        let db = CredentialDb::initialize(
            Arc::new(crate::testing::config_store(&path).unwrap()),
            &root.join("missing"),
        )
        .unwrap();
        let records = vec![Record {
            auth_id: "auth.json".into(),
            model: "model".into(),
            reason: "quota".into(),
            ..Record::default()
        }];
        Backend::save(&*db, records, SystemTime::now()).unwrap();
        let dir = db.auth_dir();
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
        let db = CredentialDb::initialize(
            Arc::new(crate::testing::config_store(&path).unwrap()),
            &root.join("missing"),
        )
        .unwrap();
        let saved = Backend::load(&*db).unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(
            (&saved[0].auth_id, &saved[0].model, &saved[0].reason),
            (&"auth.json".to_owned(), &"model".to_owned(), &"quota".to_owned())
        );
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
