use super::*;

pub(super) const SCHEMA: &str = "
CREATE TABLE resource (
  kind        TEXT    NOT NULL,
  id          TEXT    NOT NULL,
  ord         INTEGER NOT NULL DEFAULT 0,
  spec        TEXT    NOT NULL CHECK (json_valid(spec) AND length(spec) <= 1048576),
  description TEXT    NOT NULL DEFAULT '',
  rev         INTEGER NOT NULL,
  created_rev INTEGER NOT NULL,
  PRIMARY KEY (kind, id)
) STRICT;
CREATE TABLE revision (
  rev     INTEGER PRIMARY KEY,
  at      TEXT    NOT NULL,
  actor   TEXT    NOT NULL,
  message TEXT    NOT NULL DEFAULT '',
  digest  TEXT    NOT NULL
) STRICT;
CREATE TABLE change (
  rev    INTEGER NOT NULL REFERENCES revision(rev),
  kind   TEXT    NOT NULL,
  id     TEXT    NOT NULL,
  before TEXT,
  after  TEXT,
  PRIMARY KEY (rev, kind, id)
) STRICT;
CREATE INDEX change_resource_rev ON change(kind, id, rev);
CREATE TABLE credential_document (
  name  TEXT    PRIMARY KEY,
  bytes BLOB    NOT NULL,
  rev   INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE TABLE credential_meta (
  name  TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
CREATE TABLE credential_cooldown (
  id     TEXT PRIMARY KEY,
  record TEXT NOT NULL CHECK (json_valid(record))
) STRICT;
";

/// The only schema this build reads, kept in `PRAGMA user_version`. There are no
/// upgrade steps: a database with any other version is refused at open.
pub(super) const SCHEMA_VERSION: i64 = 4;

impl ConfigStore {
    /// Opens or creates the database at `path`, readable by this user only.
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        Self::open_mode(path, true)
    }

    /// Opens an existing database for offline reads and dry runs; never creates one.
    pub fn open_existing(path: &Path) -> anyhow::Result<Self> {
        Self::open_mode(path, false)
    }

    /// A read-only in-memory view of the published single-file snapshot, for reads
    /// while another process owns it. The owner only replaces that path atomically, so
    /// the open file is one complete image; no ownership, workspace or companion file is
    /// used, and nothing is written back.
    pub fn open_published(path: &Path) -> anyhow::Result<Self> {
        let conn = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        Self::init(conn, None, false)
    }

    fn open_mode(path: &Path, create: bool) -> anyhow::Result<Self> {
        super::published::open(path, create)
    }

    /// Fixtures choose a private namespace; production always uses OS tmp.
    #[cfg(any(test, feature = "testing"))]
    pub(crate) fn open_in(path: &Path, create: bool, root: PathBuf) -> anyhow::Result<Self> {
        super::published::open_in(path, create, root)
    }

    /// A private in-memory store (tests, and the CLI's dry runs).
    pub fn memory() -> Self {
        Self::init(Connection::open_in_memory().expect("in-memory SQLite"), None, true).expect("in-memory schema")
    }

    /// An in-memory store holding the config file `text` (tests).
    pub fn memory_with(text: &str) -> Self {
        let store = Self::memory();
        store.import_yaml(text, "import", "").expect("config imports");
        store
    }

    pub(super) fn init(mut conn: Connection, path: Option<PathBuf>, create: bool) -> anyhow::Result<Self> {
        initialize(&mut conn, path.is_some(), create)?;
        let state = State::decode(&conn)?;
        Ok(Self {
            state: RwLock::new(Arc::new(state)),
            writer: Mutex::new(None),
            grant_sources: RwLock::default(),
            held_logins: Mutex::default(),
            held_login_sources: RwLock::default(),
            rejected_login_sources: RwLock::default(),
            admission_pins: Mutex::default(),
            subscriptions: Arc::default(),
            conn: Some(Mutex::new(conn)),
            path,
            disk: None,
        })
    }

    /// Encodes one accepted complete snapshot into a new standalone SQLite file;
    /// never reads the working database or replaces an existing destination.
    pub fn backup(&self, destination: &Path) -> anyhow::Result<()> {
        #[cfg(unix)]
        use std::os::unix::fs::OpenOptionsExt as _;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let file = options.open(destination)?;
        let result = self.current().encode(destination).and_then(|()| {
            file.sync_all()?;
            Ok(())
        });
        drop(file);
        if result.is_err() {
            let _ = std::fs::remove_file(destination);
        }
        result?;
        Ok(())
    }
}

/// Checks the schema version; with `create`, an empty database first receives the
/// whole schema. A database that holds anything else is never changed.
pub(super) fn initialize(conn: &mut Connection, disk: bool, create: bool) -> anyhow::Result<()> {
    configure(conn, disk)?;
    if create {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let objects: i64 = tx.query_row("SELECT count(*) FROM sqlite_schema", [], |r| r.get(0))?;
        if user_version(&tx)? == 0 && objects == 0 {
            tx.execute_batch(SCHEMA)?;
            tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        }
        tx.commit()?;
    }
    check_schema(conn)
}

pub(super) fn configure(conn: &Connection, disk: bool) -> anyhow::Result<()> {
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.pragma_update(None, "synchronous", "FULL")?;
    if disk {
        delete_journal(conn)?;
    }
    conn.pragma_update(None, "secure_delete", "ON")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(())
}

pub(super) fn user_version(conn: &Connection) -> anyhow::Result<i64> {
    Ok(conn.pragma_query_value(None, "user_version", |r| r.get(0))?)
}

pub(super) fn check_schema(conn: &Connection) -> anyhow::Result<()> {
    let version = user_version(conn)?;
    anyhow::ensure!(
        version == SCHEMA_VERSION,
        "config database schema {version} is not supported by this build, which reads only schema {SCHEMA_VERSION}; \
         start from a new database and import the configuration"
    );
    Ok(())
}

pub(super) fn private_files(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        // WAL/SHM exist only while importing a database left in WAL mode.
        for suffix in ["", "-journal", "-wal", "-shm"] {
            let mut name = path.as_os_str().to_owned();
            name.push(suffix);
            match std::fs::set_permissions(Path::new(&name), std::fs::Permissions::from_mode(0o600)) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
                _ => {}
            }
        }
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

pub(super) fn delete_journal(conn: &Connection) -> anyhow::Result<()> {
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.pragma_update(None, "synchronous", "FULL")?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let mode: String = loop {
        match conn.pragma_update_and_check(None, "journal_mode", "DELETE", |row| row.get(0)) {
            Err(rusqlite::Error::SqliteFailure(error, _))
                if error.code == rusqlite::ErrorCode::DatabaseBusy && std::time::Instant::now() < deadline =>
            {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            result => break result?,
        }
    };
    anyhow::ensure!(mode == "delete", "config database did not enter DELETE journal mode");
    Ok(())
}

pub(super) fn stored_kind(name: &str) -> rusqlite::Result<Kind> {
    Kind::parse(name).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "unsupported stored resource kind",
            )),
        )
    })
}

#[cfg(test)]
pub(super) fn head(conn: &Connection) -> rusqlite::Result<u64> {
    conn.query_row("SELECT coalesce(max(rev), 0) FROM revision", [], |r| r.get::<_, i64>(0))
        .map(|n| n as u64)
}

pub(super) fn all(conn: &Connection) -> rusqlite::Result<Vec<Resource>> {
    let mut stmt =
        conn.prepare("SELECT kind, id, ord, spec, description, rev, created_rev FROM resource ORDER BY kind, ord, id")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, i64>(5)?,
            r.get::<_, i64>(6)?,
        ))
    })?;
    let mut out = Vec::new();
    let mut bytes = 0usize;
    for row in rows {
        if out.len() >= resources::MAX_RESOURCES {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let (kind, id, ord, spec, description, rev, created_rev) = row?;
        bytes = bytes
            .saturating_add(spec.len())
            .saturating_add(description.len())
            .saturating_add(id.len() + 128);
        if bytes > resources::MAX_STATE_BYTES || spec.len() > resources::MAX_SPEC_BYTES || rev < 0 || created_rev < 0 {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let kind = stored_kind(&kind)?;
        let spec = serde_json::from_str(&spec)
            .map_err(|e| rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(e)))?;
        out.push(Resource {
            kind,
            id,
            ord,
            spec,
            description,
            rev: rev as u64,
            created_rev: created_rev as u64,
        });
    }
    out.sort_by(|a, b| (a.kind, a.ord, &a.id).cmp(&(b.kind, b.ord, &b.id)));
    Ok(out)
}
