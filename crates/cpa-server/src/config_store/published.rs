//! Immutable snapshots at `--db`, with the mutable SQLite database kept in OS tmp.
use super::*;
use anyhow::{Context as _, bail};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::sync::OnceLock;

static HANDLES: OnceLock<Mutex<HashMap<PathBuf, usize>>> = OnceLock::new();

// This field is dropped after ConfigStore's connection, so cleanup never unlinks
// a database while that handle still has it open.
pub(super) struct Disk {
    root: PathBuf,
    directory: PathBuf,
}

impl ConfigStore {
    pub(crate) fn write_guard(&self) -> anyhow::Result<Option<Connection>> {
        self.disk.as_ref().map(|disk| lock(&disk.root)).transpose()
    }

    pub(crate) fn publish(&self, conn: &Connection) -> anyhow::Result<()> {
        if let Some(path) = &self.path {
            publish(conn, path)?;
        }
        Ok(())
    }
}

pub(super) fn open(path: &Path, migrate: bool) -> anyhow::Result<ConfigStore> {
    open_in(path, migrate, std::env::temp_dir().join("cook-router"))
}

pub(super) fn open_in(path: &Path, migrate: bool, root: PathBuf) -> anyhow::Result<ConfigStore> {
    private_dir(&root)?;
    let _coordination = lock(&root)?;
    let path = canonical_path(path, migrate)?;
    let directory = root.join(path_hash(&path));
    sweep(&root, &directory)?;
    private_dir(&directory)?;
    let active = active_references(&directory)?;
    private_dir(&directory.join("refs"))?;
    let live = directory.join("live.db");
    let existing = match std::fs::metadata(&live) {
        Ok(metadata) if metadata.len() > 0 => match open_live(&live) {
            Ok(conn) => {
                let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
                let tables: i64 = conn.query_row(
                    "SELECT count(*) FROM sqlite_schema WHERE type='table' AND name IN ('resource', 'revision', 'change')",
                    [], |row| row.get(0),
                )?;
                if version > 0 && tables == 3 {
                    Some(conn)
                } else if active {
                    bail!("temporary config database is uninitialized while another process is using it");
                } else {
                    None
                }
            }
            Err(error) if !active && corrupt(&error) => None,
            Err(error) => return Err(error).context("resume temporary config database"),
        },
        Ok(_) if active => bail!("temporary config database is empty while another process is using it"),
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
                private_dir(&directory.join("refs"))?;
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
    publish(&store.conn(), &path)?;
    register(&directory)?;
    store.disk = Some(Disk { root, directory });
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

fn publish(conn: &Connection, destination: &Path) -> anyhow::Result<()> {
    let temporary = destination.with_file_name(format!(".cook-snapshot-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let file = private_file(&temporary)?;
        conn.execute(
            "VACUUM INTO ?1",
            [temporary.to_str().context("snapshot directory must be UTF-8")?],
        )?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, destination).context("publish config database snapshot")?;
        sync_directory(destination.parent().expect("canonical database parent"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

fn sync_directory(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn private_dir(path: &Path) -> std::io::Result<()> {
    let mut options = std::fs::DirBuilder::new();
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

fn process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let Ok(pid) = i32::try_from(pid) else { return false };
        if pid <= 0 {
            return false;
        }
        // SAFETY: signal zero probes existence without sending a signal.
        (unsafe { libc::kill(pid, 0) }) == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, GetLastError};
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        // SAFETY: this only opens and closes an OS process handle.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return GetLastError() != ERROR_INVALID_PARAMETER;
            }
            CloseHandle(handle);
            true
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        true
    }
}

fn active_references(directory: &Path) -> anyhow::Result<bool> {
    let entries = match std::fs::read_dir(directory.join("refs")) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    let mut active = false;
    for entry in entries {
        let entry = entry?;
        if entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
            .is_some_and(process_alive)
        {
            active = true;
        } else {
            std::fs::remove_file(entry.path())?;
        }
    }
    Ok(active)
}

fn sweep(root: &Path, current: &Path) -> anyhow::Result<()> {
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        if entry.path() == current || !entry.file_type()?.is_dir() {
            continue;
        }
        let name = entry.file_name();
        if !name
            .to_str()
            .is_some_and(|name| name.len() == 64 && name.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            continue;
        }
        if !active_references(&entry.path())? {
            std::fs::remove_dir_all(entry.path())?;
        }
    }
    Ok(())
}

fn register(directory: &Path) -> anyhow::Result<()> {
    let mut handles = HANDLES
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let count = handles.entry(directory.to_owned()).or_default();
    if *count == 0 {
        let _file = private_file(&directory.join("refs").join(std::process::id().to_string()))?;
    }
    *count += 1;
    Ok(())
}

impl Drop for Disk {
    fn drop(&mut self) {
        let release = || -> anyhow::Result<()> {
            let _coordination = lock(&self.root)?;
            let mut handles = HANDLES
                .get_or_init(Mutex::default)
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            let Some(count) = handles.get_mut(&self.directory) else {
                return Ok(());
            };
            *count -= 1;
            if *count != 0 {
                return Ok(());
            }
            handles.remove(&self.directory);
            let marker = self.directory.join("refs").join(std::process::id().to_string());
            match std::fs::remove_file(marker) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
                _ => {}
            }
            if !active_references(&self.directory)? {
                std::fs::remove_dir_all(&self.directory)?;
            }
            Ok(())
        };
        if let Err(error) = release() {
            tracing::warn!(%error, "could not clean up temporary configuration database");
        }
    }
}
