//! The config store: every setting, provider key, client key, model router and plugin
//! config as one row of a SQLite database, written in transactions that each make one
//! numbered revision. The runtime reads the [`Config`] the rows compile to
//! ([`resources::config`]).
//!
//! One connection per process, behind a mutex. Writes take SQLite's write lock first
//! (`BEGIN IMMEDIATE`), so a second process (the CLI) serializes with this one.
//! History keeps every revision's changes with secrets replaced by
//! [`resources::SECRET`]; deleted rows are zeroed (`secure_delete`) and the WAL is
//! truncated after each commit, so a removed key does not stay in the files.

pub mod resources;

use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use cpa_core::config::Config;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use sha2::{Digest, Sha256};

pub use resources::{Fault, Kind, Resource};

const SCHEMA: &str = "
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
";

/// The schema version in `PRAGMA user_version`; each step upgrades from the one before.
const MIGRATIONS: &[&str] = &[SCHEMA];

/// Revisions the credential and plugin layers keep in the config; clients do not set
/// them.
const READ_ONLY: &[&str] = &[
    "credentials/concurrency/lifecycle-config-revision",
    "credentials/concurrency/observation-barrier-revision",
    "plugins/auth-revision",
];

pub struct ConfigStore {
    conn: Mutex<Connection>,
    path: Option<PathBuf>,
    /// `PRAGMA data_version` when it was last read: it moves when another connection
    /// commits.
    seen: Mutex<i64>,
}

/// One write: an operation on one resource, or on the document at a path.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Op {
    /// Creates or replaces a resource. `if_rev` requires its current revision,
    /// `if_absent` that it does not exist. A new list entry without `ord` goes last.
    Put {
        kind: String,
        id: String,
        spec: Json,
        #[serde(default)]
        ord: Option<i64>,
        #[serde(default)]
        description: Option<String>,
        #[serde(default)]
        if_rev: Option<u64>,
        #[serde(default)]
        if_absent: bool,
    },
    /// Merges `patch` into an existing resource's spec (RFC 7396: `null` removes a key).
    Patch {
        kind: String,
        id: String,
        patch: Json,
        #[serde(default)]
        if_rev: Option<u64>,
    },
    Delete {
        kind: String,
        id: String,
        #[serde(default)]
        if_rev: Option<u64>,
    },
    /// Moves a list entry before or after another of its kind; neither moves it last.
    Move {
        kind: String,
        id: String,
        #[serde(default)]
        before: Option<String>,
        #[serde(default)]
        after: Option<String>,
        #[serde(default)]
        if_rev: Option<u64>,
    },
    /// Sets the value at a slash-separated path of the document `GET
    /// /admin/v1/effective/config` shows. `expect`, when sent, must equal what that
    /// document holds there now (an absent value equals `null`, `[]` and `{}`).
    Set {
        path: String,
        value: Json,
        #[serde(default, deserialize_with = "present")]
        expect: Option<Json>,
    },
    /// Removes the value at a document path.
    Unset {
        path: String,
        #[serde(default, deserialize_with = "present")]
        expect: Option<Json>,
    },
}

/// Tells an explicit `null` from an absent field.
fn present<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Json>, D::Error> {
    Json::deserialize(d).map(Some)
}

#[derive(Debug, Clone, Serialize)]
pub struct Revision {
    pub rev: u64,
    pub at: String,
    pub actor: String,
    pub message: String,
    pub digest: String,
}

/// One resource a revision changed, with secrets hidden. `None` before is a creation,
/// `None` after a deletion.
#[derive(Debug, Clone, Serialize)]
pub struct Change {
    pub kind: Kind,
    pub id: String,
    pub before: Option<Json>,
    pub after: Option<Json>,
}

/// A successful commit or dry run.
pub struct Committed {
    /// The new revision, or the current one when nothing changed or on a dry run.
    pub rev: u64,
    /// Whether a revision was written.
    pub written: bool,
    pub changes: Vec<Change>,
    pub config: Config,
    pub digest: String,
}

impl std::fmt::Debug for Committed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Committed")
            .field("rev", &self.rev)
            .field("written", &self.written)
            .field("changes", &self.changes.len())
            .finish_non_exhaustive()
    }
}

/// The config the store holds now.
pub struct Loaded {
    pub rev: u64,
    pub config: Config,
    pub digest: String,
    pub resources: Vec<Resource>,
}

#[derive(Debug)]
pub struct CommitError {
    pub status: u16,
    pub code: &'static str,
    pub fault: Fault,
}

impl CommitError {
    fn new(status: u16, code: &'static str, resource: Option<String>, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            fault: Fault::new(resource, message),
        }
    }
    /// A 422 for a config that cannot be stored.
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(422, "invalid_config", None, message)
    }
    fn db(e: impl std::fmt::Display) -> Self {
        Self::new(500, "store_failed", None, e.to_string())
    }
}

impl std::fmt::Display for CommitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.fault)
    }
}

impl std::error::Error for CommitError {}

impl ConfigStore {
    /// Opens or creates the database at `path`, readable by this user only.
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        use anyhow::Context as _;
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .mode(0o600)
                .open(path)
                .with_context(|| format!("open {}", path.display()))?;
        }
        let conn = Connection::open(path).with_context(|| format!("open config database {}", path.display()))?;
        Self::init(conn, Some(path.to_owned()))
    }

    /// A private in-memory store (tests, and the CLI's dry runs).
    pub fn memory() -> Self {
        Self::init(Connection::open_in_memory().expect("in-memory SQLite"), None).expect("in-memory schema")
    }

    /// An in-memory store holding the config file `text` (tests).
    pub fn memory_with(text: &str) -> Self {
        let store = Self::memory();
        store.import_yaml(text, "import", "").expect("config imports");
        store
    }

    fn init(conn: Connection, path: Option<PathBuf>) -> anyhow::Result<Self> {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        // WAL lets the CLI read while the server writes; FULL syncs every commit.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.pragma_update(None, "secure_delete", "ON")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        let version = usize::try_from(version).unwrap_or(usize::MAX);
        anyhow::ensure!(
            version <= MIGRATIONS.len(),
            "config database schema {version} is newer than this build ({})",
            MIGRATIONS.len()
        );
        for (i, step) in MIGRATIONS.iter().enumerate().skip(version) {
            let tx = conn.unchecked_transaction()?;
            tx.execute_batch(step)?;
            tx.pragma_update(None, "user_version", (i + 1) as i64)?;
            tx.commit()?;
        }
        let seen = conn.pragma_query_value(None, "data_version", |r| r.get(0))?;
        Ok(Self {
            conn: Mutex::new(conn),
            path,
            seen: Mutex::new(seen),
        })
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Whether nothing was ever stored: a first start imports `config.yaml` then.
    pub fn is_empty(&self) -> anyhow::Result<bool> {
        let n: i64 = self
            .conn()
            .query_row("SELECT count(*) FROM revision", [], |r| r.get(0))?;
        Ok(n == 0)
    }

    /// The latest revision, 0 before the first.
    pub fn head(&self) -> anyhow::Result<u64> {
        Ok(head(&self.conn())?)
    }

    /// Whether another connection committed since the last call.
    pub fn changed_elsewhere(&self) -> anyhow::Result<bool> {
        let now: i64 = self.conn().pragma_query_value(None, "data_version", |r| r.get(0))?;
        let mut seen = self.seen.lock().unwrap_or_else(PoisonError::into_inner);
        Ok(std::mem::replace(&mut *seen, now) != now)
    }

    /// Every resource, by kind, then order, then id.
    pub fn resources(&self) -> anyhow::Result<Vec<Resource>> {
        Ok(all(&self.conn())?)
    }

    pub fn get(&self, kind: Kind, id: &str) -> anyhow::Result<Option<Resource>> {
        Ok(all(&self.conn())?.into_iter().find(|r| r.kind == kind && r.id == id))
    }

    /// The config the stored resources compile to.
    pub fn load(&self) -> Result<Loaded, Fault> {
        let conn = self.conn();
        let db = |e: rusqlite::Error| Fault::new(None, e.to_string());
        let rev = head(&conn).map_err(db)?;
        let resources = all(&conn).map_err(db)?;
        drop(conn);
        let (config, text) = resources::config(&resources).map_err(|f| culprit(&resources, &resources, f))?;
        Ok(Loaded {
            rev,
            config,
            digest: digest(&text),
            resources,
        })
    }

    /// Replaces everything with the resources of the config file `text`.
    pub fn import_yaml(&self, text: &str, actor: &str, message: &str) -> Result<Committed, CommitError> {
        let resources = resources::import_yaml(text)
            .map_err(|e| CommitError::new(422, "invalid_config", None, format!("{e:#}")))?;
        self.replace(resources, actor, message, false)
    }

    /// Makes the store hold exactly `resources`. A [`resources::SECRET`] keeps the
    /// value the same resource holds now.
    pub fn replace(
        &self,
        resources: Vec<Resource>,
        actor: &str,
        message: &str,
        dry_run: bool,
    ) -> Result<Committed, CommitError> {
        self.transact(actor, message, dry_run, |current| {
            let mut next = resources;
            for r in &mut next {
                let stored = current.iter().find(|c| c.kind == r.kind && c.id == r.id);
                resources::resolve_secrets(r, stored).map_err(fault_422)?;
                resources::hash_management_key(r).map_err(fault_422)?;
                if let Some(stored) = stored {
                    r.created_rev = stored.created_rev;
                    r.rev = stored.rev;
                }
            }
            Ok(next)
        })
    }

    /// Applies `ops` in order, all or none, as one revision. The fields the server
    /// keeps itself ([`READ_ONLY`]) cannot change this way.
    pub fn commit(&self, ops: &[Op], actor: &str, message: &str, dry_run: bool) -> Result<Committed, CommitError> {
        self.transact(actor, message, dry_run, |current| {
            let mut next = current.to_vec();
            for op in ops {
                apply(&mut next, op)?;
            }
            let (before, after) = (resources::document(current, false), resources::document(&next, false));
            for field in READ_ONLY {
                let parts: Vec<&str> = field.split('/').collect();
                if resources::at_path(&before, &parts) != resources::at_path(&after, &parts) {
                    return Err(CommitError::new(400, "read_only_field", None, *field));
                }
            }
            Ok(next)
        })
    }

    /// Lets `edit` change the annotated document (`"@id"` on each provider and router
    /// entry), then stores the resources it splits into, as one revision.
    pub fn edit(
        &self,
        actor: &str,
        message: &str,
        edit: impl FnOnce(&mut Json) -> Result<(), CommitError>,
    ) -> Result<Committed, CommitError> {
        self.transact(actor, message, false, |current| {
            let mut doc = resources::document(current, true);
            edit(&mut doc)?;
            from_document(&doc, current)
        })
    }

    /// The state the store held after `rev`, with secrets hidden (history keeps no
    /// secrets): [`Self::replace`] restores it with the current secrets.
    pub fn state_at(&self, rev: u64) -> anyhow::Result<Vec<Resource>> {
        let conn = self.conn();
        anyhow::ensure!(rev >= 1 && rev <= head(&conn)?, "no revision {rev}");
        let mut stmt = conn.prepare(
            "SELECT kind, id, after FROM change c
             WHERE rev = (SELECT max(rev) FROM change WHERE kind = c.kind AND id = c.id AND rev <= ?1)
             AND after IS NOT NULL",
        )?;
        let rows = stmt.query_map([rev as i64], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (kind, id, after) = row?;
            let Some(kind) = Kind::parse(&kind) else { continue };
            let stored: Stored = serde_json::from_str(&after)?;
            let mut r = Resource::new(kind, id, stored.ord, stored.spec);
            r.description = stored.description;
            out.push(r);
        }
        out.sort_by(|a, b| (a.kind, a.ord, &a.id).cmp(&(b.kind, b.ord, &b.id)));
        Ok(out)
    }

    /// Revisions, newest first: at most `limit`, older than `before` when given.
    pub fn revisions(&self, limit: u32, before: Option<u64>) -> anyhow::Result<Vec<Revision>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT rev, at, actor, message, digest FROM revision WHERE rev < ?1 ORDER BY rev DESC LIMIT ?2",
        )?;
        let before = before.map_or(i64::MAX, |b| b as i64);
        let rows = stmt.query_map(params![before, limit], |r| {
            Ok(Revision {
                rev: r.get::<_, i64>(0)? as u64,
                at: r.get(1)?,
                actor: r.get(2)?,
                message: r.get(3)?,
                digest: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// One revision and what it changed.
    pub fn revision(&self, rev: u64) -> anyhow::Result<Option<(Revision, Vec<Change>)>> {
        let conn = self.conn();
        let found = conn
            .query_row(
                "SELECT rev, at, actor, message, digest FROM revision WHERE rev = ?1",
                [rev as i64],
                |r| {
                    Ok(Revision {
                        rev: r.get::<_, i64>(0)? as u64,
                        at: r.get(1)?,
                        actor: r.get(2)?,
                        message: r.get(3)?,
                        digest: r.get(4)?,
                    })
                },
            )
            .optional()?;
        let Some(revision) = found else { return Ok(None) };
        let mut stmt = conn.prepare("SELECT kind, id, before, after FROM change WHERE rev = ?1 ORDER BY kind, id")?;
        let rows = stmt.query_map([rev as i64], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })?;
        let mut changes = Vec::new();
        for row in rows {
            let (kind, id, before, after) = row?;
            let parse = |t: Option<String>| t.and_then(|t| serde_json::from_str(&t).ok());
            if let Some(kind) = Kind::parse(&kind) {
                changes.push(Change {
                    kind,
                    id,
                    before: parse(before),
                    after: parse(after),
                });
            }
        }
        Ok(Some((revision, changes)))
    }

    /// The write path every commit takes: under SQLite's write lock, `edit` turns the
    /// current resources into the next ones, which must compile; their differences
    /// become one revision.
    fn transact(
        &self,
        actor: &str,
        message: &str,
        dry_run: bool,
        edit: impl FnOnce(&[Resource]) -> Result<Vec<Resource>, CommitError>,
    ) -> Result<Committed, CommitError> {
        let mut conn = self.conn();
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(CommitError::db)?;
        let current = all(&tx).map_err(CommitError::db)?;
        let rev = head(&tx).map_err(CommitError::db)?;
        let next = edit(&current)?;
        let mut seen = std::collections::HashSet::new();
        for r in &next {
            resources::check(r).map_err(fault_422)?;
            if !seen.insert((r.kind, r.id.as_str())) {
                return Err(CommitError::new(
                    422,
                    "invalid_config",
                    Some(r.key()),
                    "the same resource twice",
                ));
            }
        }
        let (config, text) = resources::config(&next).map_err(|f| fault_422(culprit(&current, &next, f)))?;
        let digest = digest(&text);
        let changes = diff(&current, &next);
        let shown: Vec<Change> = changes.iter().map(|(b, a)| shown_change(*b, *a)).collect();
        if changes.is_empty() || dry_run {
            return Ok(Committed {
                rev,
                written: false,
                changes: shown,
                config,
                digest,
            });
        }
        let rev = rev + 1;
        let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let write = || -> rusqlite::Result<()> {
            tx.execute(
                "INSERT INTO revision (rev, at, actor, message, digest) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![rev as i64, at, actor, message, digest],
            )?;
            for ((before, after), change) in changes.iter().zip(&shown) {
                let (kind, id) = after
                    .or(*before)
                    .map(|r| (r.kind, r.id.as_str()))
                    .expect("a change has a side");
                match after {
                    Some(r) => {
                        let created = before.map_or(rev, |b| b.created_rev);
                        tx.execute(
                            "INSERT OR REPLACE INTO resource (kind, id, ord, spec, description, rev, created_rev)
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                            params![
                                kind.name(),
                                id,
                                r.ord,
                                r.spec.to_string(),
                                r.description,
                                rev as i64,
                                created as i64
                            ],
                        )?;
                    }
                    None => {
                        tx.execute(
                            "DELETE FROM resource WHERE kind = ?1 AND id = ?2",
                            params![kind.name(), id],
                        )?;
                    }
                }
                tx.execute(
                    "INSERT INTO change (rev, kind, id, before, after) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        rev as i64,
                        kind.name(),
                        id,
                        change.before.as_ref().map(Json::to_string),
                        change.after.as_ref().map(Json::to_string)
                    ],
                )?;
            }
            Ok(())
        };
        write().map_err(CommitError::db)?;
        tx.commit().map_err(CommitError::db)?;
        // The old pages of a rewritten row stay in the WAL until a checkpoint; a busy
        // reader in another process can defer it to a later commit.
        let _ = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
        Ok(Committed {
            rev,
            written: true,
            changes: shown,
            config,
            digest,
        })
    }
}

fn fault_422(f: Fault) -> CommitError {
    CommitError {
        status: 422,
        code: "invalid_config",
        fault: f,
    }
}

/// A document-wide fault, tied to the first changed resource that fails on its own.
fn culprit(current: &[Resource], next: &[Resource], fault: Fault) -> Fault {
    if fault.resource.is_some() {
        return fault;
    }
    let changed = next
        .iter()
        .filter(|r| !current.iter().any(|c| c == *r) || current.len() == next.len() && current == next);
    for r in changed {
        if let Err(alone) = resources::config(std::slice::from_ref(r)) {
            return Fault::new(Some(r.key()), alone.message);
        }
    }
    fault
}

fn digest(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// What history stores of a resource.
#[derive(Serialize, Deserialize)]
struct Stored {
    ord: i64,
    #[serde(default)]
    description: String,
    spec: Json,
}

fn shown_change(before: Option<&Resource>, after: Option<&Resource>) -> Change {
    let side = |r: Option<&Resource>| {
        r.map(|r| {
            let r = resources::redacted(r);
            serde_json::to_value(Stored {
                ord: r.ord,
                description: r.description,
                spec: r.spec,
            })
            .expect("JSON")
        })
    };
    let r = after.or(before).expect("a change has a side");
    Change {
        kind: r.kind,
        id: r.id.clone(),
        before: side(before),
        after: side(after),
    }
}

/// The resources that differ between `current` and `next`, as (before, after).
fn diff<'a>(current: &'a [Resource], next: &'a [Resource]) -> Vec<(Option<&'a Resource>, Option<&'a Resource>)> {
    let find = |set: &'a [Resource], r: &Resource| set.iter().find(|o| o.kind == r.kind && o.id == r.id);
    let mut out: Vec<_> = next
        .iter()
        .filter_map(|n| match find(current, n) {
            Some(c) if c.same_content(n) => None,
            c => Some((c, Some(n))),
        })
        .collect();
    out.extend(
        current
            .iter()
            .filter(|c| find(next, c).is_none())
            .map(|c| (Some(c), None)),
    );
    out
}

fn head(conn: &Connection) -> rusqlite::Result<u64> {
    conn.query_row("SELECT coalesce(max(rev), 0) FROM revision", [], |r| r.get::<_, i64>(0))
        .map(|n| n as u64)
}

fn all(conn: &Connection) -> rusqlite::Result<Vec<Resource>> {
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
    for row in rows {
        let (kind, id, ord, spec, description, rev, created_rev) = row?;
        // A kind a newer build wrote is left alone rather than dropped on the next write.
        let Some(kind) = Kind::parse(&kind) else { continue };
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

fn kind_of(name: &str) -> Result<Kind, CommitError> {
    Kind::parse(name).ok_or_else(|| CommitError::new(404, "unknown_kind", None, format!("no resource kind {name:?}")))
}

fn expect_rev(existing: Option<&Resource>, key: &str, if_rev: Option<u64>, if_absent: bool) -> Result<(), CommitError> {
    let stale = || {
        CommitError::new(
            412,
            "precondition_failed",
            Some(key.to_owned()),
            "changed since it was read",
        )
    };
    match (existing, if_rev, if_absent) {
        (Some(_), _, true) => Err(CommitError::new(
            409,
            "already_exists",
            Some(key.to_owned()),
            "it exists already",
        )),
        (Some(r), Some(want), _) if r.rev != want => Err(stale()),
        (None, Some(_), _) => Err(stale()),
        _ => Ok(()),
    }
}

/// RFC 7396 merge patch.
fn merge_patch(target: &mut Json, patch: &Json) {
    let Json::Object(patch) = patch else {
        *target = patch.clone();
        return;
    };
    if !target.is_object() {
        *target = Json::Object(serde_json::Map::new());
    }
    let map = target.as_object_mut().expect("object");
    for (key, value) in patch {
        if value.is_null() {
            map.remove(key);
        } else {
            merge_patch(map.entry(key.clone()).or_insert(Json::Null), value);
        }
    }
}

fn empty_like(v: &Json) -> bool {
    match v {
        Json::Null => true,
        Json::Array(a) => a.is_empty(),
        Json::Object(o) => o.is_empty(),
        _ => false,
    }
}

/// Applies one operation to `next`, the resources so far in this commit.
fn apply(next: &mut Vec<Resource>, op: &Op) -> Result<(), CommitError> {
    let position = |next: &[Resource], kind: Kind, id: &str| next.iter().position(|r| r.kind == kind && r.id == id);
    match op {
        Op::Put {
            kind,
            id,
            spec,
            ord,
            description,
            if_rev,
            if_absent,
        } => {
            let kind = kind_of(kind)?;
            let at = position(next, kind, id);
            let existing = at.map(|i| &next[i]);
            let key = format!("{}/{id}", kind.name());
            expect_rev(existing, &key, *if_rev, *if_absent)?;
            let group = spec
                .get("type")
                .and_then(Json::as_str)
                .filter(|_| kind == Kind::Provider)
                .unwrap_or_default();
            let last = next
                .iter()
                .filter(|r| r.kind == kind && r.group() == group)
                .map(|r| r.ord + 1)
                .max()
                .unwrap_or(0);
            let mut r = Resource::new(kind, id.clone(), 0, spec.clone());
            r.ord = match (kind.ordered(), ord, existing) {
                (false, _, _) => 0,
                (true, Some(o), _) => *o,
                (true, None, Some(e)) => e.ord,
                (true, None, None) => last,
            };
            r.description = description
                .clone()
                .or_else(|| existing.map(|e| e.description.clone()))
                .unwrap_or_default();
            if let Some(e) = existing {
                r.rev = e.rev;
                r.created_rev = e.created_rev;
            }
            resources::resolve_secrets(&mut r, existing).map_err(fault_422)?;
            resources::hash_management_key(&mut r).map_err(fault_422)?;
            match at {
                Some(i) => next[i] = r,
                None => next.push(r),
            }
        }
        Op::Patch {
            kind,
            id,
            patch,
            if_rev,
        } => {
            let kind = kind_of(kind)?;
            let key = format!("{}/{id}", kind.name());
            let i = position(next, kind, id)
                .ok_or_else(|| CommitError::new(404, "not_found", Some(key.clone()), "no such resource"))?;
            expect_rev(Some(&next[i]), &key, *if_rev, false)?;
            let stored = next[i].clone();
            let mut r = stored.clone();
            merge_patch(&mut r.spec, patch);
            resources::resolve_secrets(&mut r, Some(&stored)).map_err(fault_422)?;
            resources::hash_management_key(&mut r).map_err(fault_422)?;
            next[i] = r;
        }
        Op::Delete { kind, id, if_rev } => {
            let kind = kind_of(kind)?;
            let key = format!("{}/{id}", kind.name());
            let i = position(next, kind, id)
                .ok_or_else(|| CommitError::new(404, "not_found", Some(key.clone()), "no such resource"))?;
            expect_rev(Some(&next[i]), &key, *if_rev, false)?;
            next.remove(i);
        }
        Op::Move {
            kind,
            id,
            before,
            after,
            if_rev,
        } => {
            let kind = kind_of(kind)?;
            let key = format!("{}/{id}", kind.name());
            if !kind.ordered() {
                return Err(CommitError::new(
                    400,
                    "unordered_kind",
                    Some(key),
                    "only list entries have an order",
                ));
            }
            let i = position(next, kind, id)
                .ok_or_else(|| CommitError::new(404, "not_found", Some(key.clone()), "no such resource"))?;
            expect_rev(Some(&next[i]), &key, *if_rev, false)?;
            let mut order: Vec<String> = {
                let group = next[i].group().to_owned();
                let mut of_kind: Vec<&Resource> =
                    next.iter().filter(|r| r.kind == kind && r.group() == group).collect();
                of_kind.sort_by_key(|r| r.ord);
                of_kind
                    .into_iter()
                    .map(|r| r.id.clone())
                    .filter(|other| other != id)
                    .collect()
            };
            let anchor = |target: &String| {
                order.iter().position(|o| o == target).ok_or_else(|| {
                    CommitError::new(
                        404,
                        "not_found",
                        Some(format!("{}/{target}", kind.name())),
                        "no such resource",
                    )
                })
            };
            let slot = match (before, after) {
                (Some(b), None) => anchor(b)?,
                (None, Some(a)) => anchor(a)? + 1,
                (None, None) => order.len(),
                (Some(_), Some(_)) => {
                    return Err(CommitError::new(
                        400,
                        "invalid_move",
                        Some(key),
                        "give before or after, not both",
                    ));
                }
            };
            order.insert(slot, id.clone());
            for (n, entry) in order.iter().enumerate() {
                if let Some(j) = position(next, kind, entry) {
                    next[j].ord = n as i64;
                }
            }
        }
        Op::Set { path, value, expect } => set_at(next, path, Some(value.clone()), expect.as_ref())?,
        Op::Unset { path, expect } => set_at(next, path, None, expect.as_ref())?,
    }
    Ok(())
}

/// A [`Op::Set`] or [`Op::Unset`]: edits the annotated document, then splits it back
/// into resources that keep their identity.
fn set_at(next: &mut Vec<Resource>, path: &str, value: Option<Json>, expect: Option<&Json>) -> Result<(), CommitError> {
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    if let Some(expect) = expect {
        let shown = resources::document_for_read(next);
        let now = resources::at_path(&shown, &parts)
            .cloned()
            .map(resources::without_read_only);
        let expect = resources::without_read_only(expect.clone());
        let same = match now {
            Some(v) => v == expect || empty_like(&v) && empty_like(&expect),
            None => empty_like(&expect),
        };
        if !same {
            return Err(CommitError::new(
                412,
                "precondition_failed",
                None,
                format!("{path} changed since it was read"),
            ));
        }
    }
    let mut doc = resources::document(next, true);
    resources::set_path(&mut doc, &parts, value).map_err(|e| CommitError::new(400, "invalid_path", None, e))?;
    *next = from_document(&doc, next)?;
    Ok(())
}

/// `doc` split into resources that keep the identity they have in `current`, with
/// each [`resources::SECRET`] resolved and a plaintext management key hashed.
fn from_document(doc: &Json, current: &[Resource]) -> Result<Vec<Resource>, CommitError> {
    let mut split = resources::split(doc, current).map_err(fault_422)?;
    for r in &mut split {
        let stored = current.iter().find(|s| s.kind == r.kind && s.id == r.id);
        resources::resolve_secrets(r, stored).map_err(fault_422)?;
        resources::hash_management_key(r).map_err(fault_422)?;
    }
    Ok(split)
}

#[cfg(test)]
mod tests;
