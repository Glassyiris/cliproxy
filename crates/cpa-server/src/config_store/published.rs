//! Immutable snapshots at `--db`, with a private recoverable checkpoint in OS tmp.
use super::*;
use anyhow::{Context as _, bail};
use std::fs::{File, OpenOptions};
use std::sync::atomic::{AtomicBool, Ordering};

// A store owns the working directory even while no SQLite connection is open.
pub(super) struct Disk {
    root: PathBuf,
    directory: PathBuf,
    unresolved: AtomicBool,
    // Released only after Drop has finished checkpoint/workspace cleanup.
    _ownership: File,
}

impl Disk {
    pub(super) fn recovery(&self, unresolved: bool) {
        self.unresolved.store(unresolved, Ordering::Release);
    }
    pub(super) fn connection(&self, _store: &ConfigStore, _writing: bool) -> anyhow::Result<StoreConnection<'static>> {
        // Reads also own this lock: a reload must never replace an inode that
        // another operation still has open, even in another process.
        let coordination = lock(&self.root)?;
        let path = self.directory.join("live.db");
        let metadata = std::fs::symlink_metadata(&path)?;
        anyhow::ensure!(metadata.is_file() && owned(&metadata), "unsafe temporary database file");
        // Recovery/seeding belongs to startup or the validated copy above, never
        // silently create a blank database after a failed ordinary reopen.
        let conn = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        super::db::configure(&conn, true)?;
        Ok(StoreConnection::Disk {
            conn,
            _coordination: Box::new(coordination),
        })
    }
}

impl ConfigStore {
    pub(crate) fn working_directory(&self) -> Option<&Path> {
        self.disk.as_ref().map(|disk| disk.directory.as_path())
    }

    pub(super) fn persist(
        &self,
        retained: &state::Pending,
        pending: &mut Option<state::Pending>,
    ) -> anyhow::Result<()> {
        let state = &retained.state;
        let Some(disk) = &self.disk else { return Ok(()) };
        // Coordinate replacement without ever opening the old checkpoint in SQLite.
        let _coordination = lock(&disk.root)?;
        let mut image = install(
            &disk.directory.join("live.db"),
            |temporary| state.encode(temporary),
            || {
                *pending = Some(retained.clone());
                disk.recovery(true);
            },
        )?;
        if let Some(path) = &self.path {
            // This handle contains only the newly encoded immutable bytes, not a
            // reopened live SQL database. Readers of older inodes remain valid.
            install(
                path,
                |temporary| {
                    std::io::copy(&mut image, &mut OpenOptions::new().write(true).open(temporary)?)?;
                    Ok(())
                },
                || {},
            )?;
            #[cfg(test)]
            crate::testing::publication_effects::installed(path);
        }
        Ok(())
    }

    pub(crate) fn publish(&self, state: &State) -> anyhow::Result<()> {
        if let Some(path) = &self.path {
            install(path, |temporary| state.encode(temporary), || {})?;
        }
        Ok(())
    }
}

pub(super) fn open(path: &Path, migrate: bool) -> anyhow::Result<ConfigStore> {
    open_in(path, migrate, std::env::temp_dir().join("cook-router"))
}

pub(super) fn open_in(path: &Path, migrate: bool, root: PathBuf) -> anyhow::Result<ConfigStore> {
    let path = canonical_path(path, migrate)?;
    let ownership = ownership(&path)?;
    private_dir(&root)?;
    let _coordination = lock(&root)?;
    let directory = root.join(path_hash(&path));
    // Other namespaces may contain valid unacknowledged grants. Only their own
    // resumed owner can decide that recovery is settled and clean them up.
    private_dir(&directory)?;
    // The native guard already proves exclusive ownership; PID markers can be stale.
    let live = directory.join("live.db");
    let existing = match std::fs::metadata(&live) {
        Ok(metadata) if metadata.len() > 0 => match open_live(&live) {
            Ok(conn) => {
                // Unknown newer tables are not permission to discard their data.
                let version = super::db::schema_version(&conn)?;
                let tables: i64 = conn.query_row(
                    "SELECT count(*) FROM sqlite_schema WHERE type='table' AND name IN ('resource', 'revision', 'change')",
                    [], |row| row.get(0),
                )?;
                if version > 0 && tables == 3 { Some(conn) } else { None }
            }
            Err(error) if corrupt(&error) => None,
            Err(error) => return Err(error).context("resume temporary config database"),
        },
        Ok(_) => None,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    let conn = match existing {
        Some(conn) => conn,
        None => {
            if live.exists() {
                // A broken working copy is disposable only when no process owns it.
                std::fs::remove_dir_all(&directory)?;
                private_dir(&directory)?;
            }
            if path.exists() && std::fs::metadata(&path)?.len() > 0 {
                super::db::private_files(&path)?;
                let source = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)?;
                super::db::delete_journal(&source).context("close old WAL users before importing this database")?;
                let file = private_file(&live)?;
                source.execute(
                    "VACUUM INTO ?1",
                    [live.to_str().context("temporary database path must be UTF-8")?],
                )?;
                file.sync_all()?;
            } else if !migrate {
                bail!("config database {} does not exist or is empty", path.display());
            }
            open_live(&live)?
        }
    };
    let mut store = ConfigStore::init(conn, Some(path.clone()), migrate)?;
    // Includes recovery of a committed live transaction whose earlier publication
    // failed. Readiness is never acknowledged before the snapshot catches up.
    // Bootstrap-only conversion preserves explicit old-schema/offline-read behavior.
    // Ordinary publications below encode the canonical State, not this connection.
    publish_bootstrap(&*store.conn()?, &path)?;
    store.disk = Some(Disk {
        root,
        directory,
        unresolved: AtomicBool::new(false),
        _ownership: ownership,
    });
    // The runtime retains only paths/lifetime ownership, not a SQLite connection.
    drop(store.conn.take());
    Ok(store)
}

fn canonical_path(path: &Path, create: bool) -> anyhow::Result<PathBuf> {
    if path.exists() {
        return std::fs::canonicalize(path).context("resolve config database path");
    }
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    if create {
        std::fs::create_dir_all(parent)?;
    }
    let parent = std::fs::canonicalize(parent)?;
    Ok(parent.join(path.file_name().context("config database needs a file name")?))
}

fn ownership(path: &Path) -> anyhow::Result<File> {
    #[cfg(not(any(unix, windows)))]
    bail!(
        "exclusive configuration ownership is unsupported for {}",
        path.display()
    );
    #[cfg(any(unix, windows))]
    {
        // Independent of TMPDIR/working roots and atomic replacements of the DB.
        // This generated lock is never a backup input and must never be unlinked
        // during workspace cleanup: contenders must keep the same lock inode.
        let directory = path
            .parent()
            .context("config database needs a parent")?
            .join(".cook-router-owners");
        private_dir(&directory)?;
        // Use the native name so filesystem case aliases share the same lock.
        let file = cpa_exec::codex_siwc_bind::open_lock_file(
            &directory.join(path.file_name().context("config database needs a file name")?),
        )
        .map_err(anyhow::Error::msg)
        .context("open configuration ownership guard")?;
        let metadata = file.metadata()?;
        anyhow::ensure!(
            metadata.is_file() && owned(&metadata),
            "unsafe configuration ownership guard"
        );
        if !cpa_exec::codex_siwc_bind::try_lock(&file).map_err(anyhow::Error::msg)? {
            return Err(AlreadyOwned(path.to_owned()).into());
        }
        Ok(file)
    }
}

/// Another service or offline command owns the selected database.
#[derive(Debug)]
pub struct AlreadyOwned(PathBuf);

impl std::fmt::Display for AlreadyOwned {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "config database {} is already owned; use the authenticated management API for online changes",
            self.0.display()
        )
    }
}

impl std::error::Error for AlreadyOwned {}

fn path_hash(path: &Path) -> String {
    Sha256::digest(path.as_os_str().as_encoded_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn open_live(path: &Path) -> anyhow::Result<Connection> {
    let conn = open_database(path)?;
    super::db::delete_journal(&conn)?;
    let integrity: String = conn.pragma_query_value(None, "quick_check", |row| row.get(0))?;
    anyhow::ensure!(
        integrity == "ok",
        "temporary config database failed its integrity check"
    );
    Ok(conn)
}

fn corrupt(error: &anyhow::Error) -> bool {
    error.downcast_ref::<rusqlite::Error>().is_some_and(|error| {
        matches!(error, rusqlite::Error::SqliteFailure(code, _) if matches!(code.code,
            rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase))
    }) || error.to_string() == "temporary config database failed its integrity check"
}

fn lock(root: &Path) -> anyhow::Result<Connection> {
    let path = root.join("coordination.db");
    let conn = open_database(&path)?;
    super::db::delete_journal(&conn).context("configure snapshot coordinator")?;
    // Startup and publication for separate databases share this small lock.
    // Give that queue its own bounded budget; live SQLite transactions retain 5s.
    conn.busy_timeout(std::time::Duration::from_secs(30))?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS coordination (id INTEGER PRIMARY KEY) STRICT")
        .context("initialize snapshot coordinator")?;
    conn.execute_batch("BEGIN IMMEDIATE")
        .context("wait for snapshot publication coordinator")?;
    Ok(conn) // Dropping the connection releases the reserved SQLite write lock.
}

/// Bootstrap/migration is the only publication sourced from an imported database.
fn publish_bootstrap(conn: &Connection, destination: &Path) -> anyhow::Result<()> {
    install(
        destination,
        |temporary| {
            conn.execute(
                "VACUUM INTO ?1",
                [temporary.to_str().context("snapshot directory must be UTF-8")?],
            )?;
            Ok(())
        },
        || {},
    )?;
    Ok(())
}

fn install(
    destination: &Path,
    build: impl FnOnce(&Path) -> anyhow::Result<()>,
    replaced: impl FnOnce(),
) -> anyhow::Result<File> {
    let temporary = destination.with_file_name(format!(".cook-snapshot-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let file = private_file(&temporary)?;
        build(&temporary)?;
        file.sync_all()?;
        #[cfg(test)]
        crate::testing::installation_effects::run(
            destination,
            crate::testing::installation_effects::Stage::BeforeReplace,
        )?;
        let replacement = replace(&temporary, destination);
        // A write-through rename can report a metadata-flush error after moving
        // the file. The vanished construction name still requires recovery.
        if replacement.is_ok() || !temporary.try_exists()? {
            replaced();
        }
        replacement.context("publish config database snapshot")?;
        #[cfg(test)]
        crate::testing::installation_effects::run(
            destination,
            crate::testing::installation_effects::Stage::AfterReplace,
        )?;
        #[cfg(unix)]
        sync_directory(destination.parent().expect("canonical database parent"))?;
        Ok(file)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

#[cfg(unix)]
fn replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::rename(source, destination)
}

#[cfg(windows)]
fn replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt as _;
    use windows_sys::Win32::Storage::FileSystem::{MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW};
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination.as_os_str().encode_wide().chain(Some(0)).collect();
    // Same-directory rename only: never request COPY_ALLOWED, which can expose
    // partial copied contents. WRITE_THROUGH completes native metadata durability.
    // https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-movefileexw
    // SAFETY: both buffers are NUL-terminated and remain valid throughout the call.
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn replace(_source: &Path, _destination: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "durable snapshot replacement is unsupported on this platform",
    ))
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> std::io::Result<()> {
    File::open(path)?.sync_all()
}

fn private_dir(path: &Path) -> std::io::Result<()> {
    let options = std::fs::DirBuilder::new();
    #[cfg(unix)]
    let mut options = options;
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt as _;
        options.mode(0o700);
    }
    match options.create(path) {
        Err(error) if error.kind() != std::io::ErrorKind::AlreadyExists => return Err(error),
        _ => {}
    }
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_dir() || !owned(&metadata) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "unsafe temporary database directory",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn open_database(path: &Path) -> anyhow::Result<Connection> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => anyhow::ensure!(metadata.is_file() && owned(&metadata), "unsafe temporary database file"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    // Do not open/close an extra File on an active SQLite inode: POSIX close
    // would cancel this process's SQLite locks. The private parent protects a
    // newly created file until chmod, before it contains any credential data.
    let conn = Connection::open(path)?;
    super::db::private_files(path)?;
    Ok(conn)
}

fn private_file(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || !owned(&metadata) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "unsafe temporary database file",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(file)
}

fn owned(metadata: &std::fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        // SAFETY: geteuid has no preconditions or mutable process state.
        metadata.uid() == unsafe { libc::geteuid() }
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        true
    }
}

impl Drop for Disk {
    fn drop(&mut self) {
        let release = || -> anyhow::Result<()> {
            let _coordination = lock(&self.root)?;
            if self.unresolved.load(Ordering::Acquire) {
                bail!("publication recovery is unresolved; temporary checkpoint retained");
            }
            std::fs::remove_dir_all(&self.directory)?;
            Ok(())
        };
        if let Err(error) = release() {
            tracing::warn!(%error, "could not clean up temporary configuration database");
        }
    }
}
