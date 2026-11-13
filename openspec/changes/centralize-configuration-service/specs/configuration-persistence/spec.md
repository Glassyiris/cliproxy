## Purpose

Persist complete service-owned state as portable standalone SQLite images while preserving acknowledgement durability, directly copyable backups and explicit startup recovery.

## ADDED Requirements

### Requirement: Fresh database images are built from complete state
Normal export SHALL encode an immutable, complete persistent-state snapshot into a new standalone SQLite image without reading or copying an existing database as its source. The input SHALL retain all supported configuration resources, stable identifiers and ordering, raw credential documents, credential metadata, configuration revision/change history and persisted cooldown data. Runtime projections alone SHALL NOT be treated as a lossless export source.

#### Scenario: State is round-tripped without an old database
- **WHEN** complete state containing supported opaque data, credentials and history is encoded with no previous database available
- **THEN** decoding the new image reconstructs the same persistent data and identities
- **AND** credential source bytes remain intact

#### Scenario: The runtime projection omits persistent information
- **WHEN** an export is requested from a state whose runtime view does not contain its history or raw credential documents
- **THEN** the encoder obtains those fields from the service-owned canonical snapshot
- **AND** it does not silently discard them or read a live SQLite file to fill the gaps

### Requirement: Published databases are independently copyable
The configured database path SHALL be the single portable configuration-state artifact. Copying only that file while the service runs SHALL be sufficient to cold-recover the complete supported persistent state, without invoking a backup/export API or copying WAL/SHM, rollback journals, the live workspace, ownership files or credential caches. Publication SHALL replace a complete standalone SQLite image atomically rather than mutate its published bytes in place. Normal images and working checkpoints SHALL NOT require WAL/SHM sidecars; private transient files used for atomic construction SHALL not become part of the backup contract.

#### Scenario: Copying overlaps publication
- **WHEN** an ordinary file copy overlaps a successful publication
- **THEN** the copied file contains one complete older or newer image that opens without sidecar files
- **AND** it never combines pages from two versions

#### Scenario: A reader already opened the old snapshot
- **WHEN** publication replaces the configured path after a copy has opened its input
- **THEN** that copy can finish reading the previous complete image

#### Scenario: Only the published file is moved
- **WHEN** a user copies only the published database into a clean configuration location with no old working directory, sidecars, ownership metadata or credential cache
- **THEN** cold initialization reconstructs its supported persistent state from that file alone
- **AND** the user is not required to call an export interface or gather companion files

### Requirement: Durability precedes resource closure and success
For a mutation to succeed, it SHALL persist its recovery checkpoint and published image using private temporary construction, file synchronization, atomic replacement and the platform's required directory/metadata durability operations. It SHALL complete publication before closing the successful logical storage operation and acknowledging success; resource closure SHALL NOT defer a successful save to an unowned asynchronous mirror. Error paths SHALL release transient SQLite resources while retaining any required pending checkpoint and recovery admission state.

#### Scenario: Power is lost after success
- **WHEN** a mutation has returned success and power is then lost on storage honoring the supported durability operations
- **THEN** the acknowledged state is recoverable from the persistent published database even if OS temporary storage is lost

#### Scenario: Snapshot publication fails after checkpoint persistence
- **WHEN** checkpoint persistence completes but publication of the configured database fails
- **THEN** the mutation returns an error and does not publish a successful runtime change
- **AND** the pending checkpoint cannot be replaced from older accepted state by a later ordinary mutation
- **AND** a subsequent recovery retry publishes the latest retained state before ordinary mutation admission resumes
- **AND** a later resume can recover that unacknowledged checkpoint, as documented

### Requirement: SQLite resources are operation scoped
SQLite SHALL be used for bootstrap decoding, explicit migration, encoding and persistence operations only. Idle disk-backed services SHALL retain no SQLite connection or page cache. Completion and error paths SHALL close transient connections; no eviction timer or resident database process SHALL be required for this lifecycle.

#### Scenario: Bootstrap or a save completes
- **WHEN** bootstrap or a persistent mutation has completed
- **THEN** no connection to its disk working database or coordinator remains open merely to support future reads

#### Scenario: Encoding or publication fails
- **WHEN** a storage operation encounters an error
- **THEN** its transient SQLite resources are released without deleting recovery data needed by another valid operation

### Requirement: Startup distinguishes resume from cold initialization
The service SHALL acquire exclusive ownership before interpreting working state. A valid initialized working checkpoint SHALL take precedence for resume and SHALL be decoded and republished before readiness. When no recoverable checkpoint exists, a normal cold start SHALL load the configured persistent snapshot and establish new working state. Empty, schema-empty or corrupt unowned working state SHALL not overwrite a valid persistent snapshot. Unsupported newer schemas SHALL fail without destructive fallback.

#### Scenario: An abnormal exit leaves newer valid working state
- **WHEN** startup finds a valid owned-by-no-running-service checkpoint newer than the published file
- **THEN** it resumes that checkpoint, initializes memory, republishes it and only then reports readiness

#### Scenario: Temporary state is absent or unusable
- **WHEN** startup finds no checkpoint or an unowned zero-length, schema-empty or corrupt checkpoint
- **THEN** it cold-starts from the valid persistent snapshot instead of publishing empty state over it
- **AND** a legitimately initialized database containing zero configuration resources remains valid state

#### Scenario: Working state uses an unsupported newer schema
- **WHEN** a checkpoint is structurally valid but requires a schema unsupported by the running binary
- **THEN** startup fails with recovery guidance without deleting it or overwriting the published snapshot

### Requirement: Temporary workspace lifetime belongs to the service
The service SHALL own private workspace creation, recovery selection and cleanup. Ownership SHALL exclude a second server or offline writer even when no SQLite connection is open. Normal shutdown SHALL stop admission and wait for owned writers before deleting the workspace, and SHALL retain it when unresolved publication/recovery data remains. It SHALL never delete another active owner's state. OS tmp loss SHALL select cold recovery, not be represented as a successful resume.

#### Scenario: Shutdown overlaps a commit
- **WHEN** shutdown begins while a storage operation is in its critical commit/publication stage
- **THEN** shutdown waits for that stage to settle before closing ownership
- **AND** it deletes temporary state only if no unresolved recovery checkpoint remains

#### Scenario: Publication is still pending at shutdown
- **WHEN** final publication has failed after a newer checkpoint was installed and shutdown cannot resolve it
- **THEN** the service retains that checkpoint, reports incomplete cleanup and does not delete its recovery workspace as a normal clean exit
- **AND** a later resume can recover the retained grant/state if the temporary storage survives

#### Scenario: A second owner attempts startup
- **WHEN** another server or offline mutator already owns the selected state
- **THEN** startup refuses competing ownership without replacing its checkpoint

#### Scenario: Temporary storage was memory backed and disappeared
- **WHEN** OS temporary storage has been cleared by reboot or power loss
- **THEN** startup cold-loads the durable configured snapshot
- **AND** it does not claim that temporary storage survives power failure

### Requirement: Legacy import preserves committed data
Bootstrap migration SHALL recover supported legacy databases through SQLite and preserve committed WAL content before creating the new standalone state image. It SHALL refuse conflicting active legacy users rather than manually delete their sidecars. Supported schema and opaque-data migration behavior SHALL remain lossless.

#### Scenario: A legacy database has retained WAL commits
- **WHEN** bootstrap imports an otherwise supported legacy database with committed content in a retained WAL
- **THEN** the resulting canonical state and standalone image include those commits

#### Scenario: A legacy connection prevents conversion
- **WHEN** an active legacy connection prevents safe import or journal conversion
- **THEN** startup reports the conflict without silently dropping commits or removing its sidecars

### Requirement: State files remain private and restoration is deliberate
Working directories and ownership metadata SHALL be restricted to the service user, and databases, temporary images, exports and backups SHALL have private permissions or equivalent access controls. Full-backup restoration SHALL require stopped ownership and explicit removal or isolation of stale recoverable working state. Configuration-history restoration SHALL remain distinct from full credential-bearing backup restoration.

#### Scenario: New images are published
- **WHEN** the service creates a checkpoint or published image
- **THEN** it is private before becoming visible at its final path
- **AND** export or error logs do not reveal credentials

#### Scenario: A user intentionally restores an older backup
- **WHEN** all owners have stopped and a user follows the documented cold-restore procedure
- **THEN** the restored snapshot seeds the next cold start rather than being overwritten by an unintended orphan resume
