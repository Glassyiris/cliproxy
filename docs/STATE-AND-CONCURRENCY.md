# State and concurrency

**Accepted design contract; implementation is in progress.** This document records the configuration/state model agreed for cook-router. It is not a claim that every path in the current tree already conforms. [Configuration](CONFIGURATION.md) describes operational interfaces.

Function names, type names, method signatures and file layout can change. The ownership, persistence, data-flow, notification and lifecycle model below is not an implementation preference: a refactor must preserve it. Do not weaken it to accommodate a new caller or make a check pass. A change to the model requires an explicit architecture decision and corresponding contract/test updates before implementation.

## One portable state file

**The configured database is one file that a user can copy at any time, including while the service runs, and use for a complete supported-state recovery. This existing guarantee must not regress.**

- Copying the published file does not require a backup API, an export command or stopping the service.
- The copy needs no WAL, SHM, rollback journal, live workspace, lock/owner metadata or materialized credential cache beside it.
- Publication replaces a complete immutable image. A concurrent copy gets a complete older or newer version, never mixed pages.
- Successful writes are represented by durable publication before success is acknowledged. A copy already in progress can still finish the older complete version.
- Private transient files for construction/atomic replacement are allowed. They are not backup dependencies or a reason to ask users to gather a directory of files.
- The image contains the supported persistent configuration/credential state. It is not an installer bundle containing application binaries or unrelated external assets.

```text
persistent configuration directory
  cook.db                     one required portable state artifact

private OS temporary storage
  working checkpoint          owned recovery data, not a backup companion
  ownership bookkeeping       never needed to restore cook.db
```

Keep secret-bearing files private before publication. Containers mount the persistent directory, not an old database inode, so atomic replacement remains possible.

## One logical owner

A resident application service owns canonical state, command admission, persistence, current runtime views, callback subscriptions and workspace lifetime. The current server is one process with multiple threads; this service belongs inside that process. A new daemon or cross-process shared-memory model is not needed to provide a common interface.

External online clients, including CLI import/login persistence, submit authenticated management requests. Internal OAuth/refresh/plugin/scheduler work submits commands directly to the same service; it does not need HTTP loopback. When stopped, an offline tool can use the same commit implementation only after obtaining exclusive ownership.

Do not expose a writable SQL/backend handle to these adapters. Private table-specific helpers are fine; independently writable modules are not. A failed online request or authentication attempt never authorizes a fallback local write. SQLite's transaction lock does not replace application-level ownership.

## Current state lives in memory

Queries use immutable memory views. Readers can keep a snapshot for a whole request while a later version is published; they do not open SQLite or wait for disk I/O under the state lock.

The canonical persistent snapshot is more complete than a runtime configuration struct. Preserve resources and IDs/order, opaque plugin data, raw credential documents/metadata, configuration history and persisted cooldowns. Derive runtime configuration and scheduling views from that state; do not create a second independently mutable authority.

Keep domains distinct. Restoring configuration history cannot revive a revoked credential. A cooldown update is not a configuration change. Persisting a granted token and admitting it for runtime use are different transitions. Consumers receive only their authorized views, not a broadcast of all secrets.

Volatile request counters, active leases and immediate scheduler feedback remain component-owned execution state. Their durable cooldown checkpoints still go through the sole writer; that is not permission to create another mutable configuration authority or to delay every request on disk persistence.

## One commit sequence

```text
command + accepted state
          |
          v
check preconditions and validate candidate
          |
          v
encode complete standalone SQLite image
          |
          v
persist recovery checkpoint
          |
          v
publish configured file, sync file and directory metadata
          |
          v
close transient storage resources
          |
          v
replace current memory snapshot
          |
          v
dispatch relevant ordered callbacks
          |
          v
return success
```

Serialize mutations without holding the memory read/write lock over encoding, filesystem work or callbacks. Long network grants run outside the commit gate; their results must still satisfy the relevant registration/resource preconditions when admitted.

Invalid input, stale preconditions and dry runs do not advance accepted state. Failure to publish the configured file is not a successful save. Once a newer checkpoint exists, retain it as explicit **publication-pending recovery state**: refuse ordinary new mutations until it is durably published and reconciled. Never build a later full-state image from older accepted memory, because that can erase a rotated token whose previous value is no longer valid.

Already-in-flight non-repeatable grant results must still be preserved by the same owner against the latest pending checkpoint, with the relevant admission/version checks retained. Pause new grant starts; do not discard completed grants or reuse an affected invalidated credential from an older view. Resolving pending publication precedes normal write admission and successful-change notifications. Pending state does not require a resident SQLite connection.

A checkpoint written before failed publication can be recovered on resume even though the caller saw an error; do not claim rollback of it. If publication is still unresolved at shutdown, preserve the recovery workspace and report incomplete cleanup instead of deleting the only newer state. Temporary-storage loss can still lose unacknowledged work; the single published file remains the recovery guarantee for acknowledged state.

A subscriber failure does not undo a committed state. Report it and continue notifying eligible subscribers. Commit success means persistence, memory publication and notification dispatch completed, not that every subscriber's expensive downstream work finished.

## Functional core, explicit effects

Snapshot export has two logical transformations: obtain immutable complete state, then encode that value into a fresh SQLite image. These are roles, not required function names.

The encoder does not read or copy an old database. Use mature SQLite construction/serialization support, not a custom SQLite file-format writer. SQLite connections exist only for explicit bootstrap, migration or encoding operations and are closed afterward; there is no idle disk connection/page cache to maintain. Filesystem synchronization and atomic replacement live at the persistence edge.

Isolated computation receives all business inputs and returns a result or error. It must not look up a global runtime/configuration object, reread live SQL, infer a mutable environment/current directory, or capture the owner's mutable state. Required file/network/environment input is supplied by explicit adapters. Pass the minimum required data, not all credentials.

Results carry the relevant input preconditions. The owner accepts or rejects them; finishing later does not entitle a worker to overwrite newer state. Unrelated changes must not invalidate otherwise valid results merely because a global number changed.

## Owned function callbacks

The service registers, invokes and releases subscriptions. Registration establishes an initial view and future notifications atomically with respect to publication.

Callbacks receive an immutable authorized view, its version and change category. They use that input instead of rereading ambient configuration. Notification dispatch follows commit order and runs without the memory or subscriber-list lock held.

Callbacks are short notifications. Expensive work belongs to the receiving component's owned execution scope; a follow-up mutation is scheduled as a later command, not a synchronous reentry into the active commit gate. An ownership handle releases registration when the component exits, preventing strong-reference cycles and stale subscribers.

Function pointers and closures do not cross process address spaces. If a separately approved future deployment introduces a sidecar, its transport exchanges serialized messages and invokes callbacks locally. Thread-safe structures are not a cross-process sharing protocol.

## Explicit execution and lifetime

| Work | Default placement | Required ownership |
|---|---|---|
| Network and notification waits | In-process asynchronous tasks | Cancellation and completion tracking |
| Shared configuration queries/commands | Thread-safe in-process service | Immutable reads and serialized writes |
| Blocking encoding and filesystem work | Owned blocking tasks/threads | Admission bounds and completion before cleanup |
| External tools or justified isolation | Child processes | Explicit input/output, cancellation policy and wait/reap |

Unify ownership and shutdown rules, not every execution type into one global queue. Reuse existing runtime/task/locking primitives. Do not indiscriminately shrink a blocking pool when plugin calls can wait for callbacks that need that pool.

Every background task, thread, process and subscription has a component owner. Stopping admission and asking for cancellation are not equivalent to waiting for termination. Preserve critical grants/commits, collect their outcomes, and join owned work before deleting files it can still write. No detached task may outlive its owner and recreate a removed directory.

## Recovery and temporary storage

The same component acquires exclusive ownership, creates the private workspace, loads state and removes disposable work after orderly shutdown.

- **Resume:** a valid initialized surviving checkpoint wins; decode it, establish memory and republish before readiness.
- **Cold start:** no recoverable checkpoint exists; load the persistent snapshot and establish new memory/working state. Supported legacy import is a bootstrap path, not a file watcher.
- **Unusable work:** empty/schema-empty/corrupt unowned state must not replace a good snapshot with empty data. A newer unsupported schema is an error, not permission to erase it.
- **Shutdown:** stop admission, settle critical persistence, cancel/join remaining owned work and release callbacks. Clean the workspace only if no unresolved recovery checkpoint remains; otherwise report incomplete cleanup and preserve it for resume before releasing ownership.

A tmpfs can disappear on power loss. Resume is possible only if recoverable work survives; otherwise use the durable published file. Stable ownership-lock identity must not be removed beneath a waiting process, and is not part of the recyclable checkpoint or portable backup.

A deliberate older-backup restore stops all owners and prevents stale working state from resuming before the published file is replaced. Replacing the file while running is not a configuration API. There is no periodic hash, metadata, SQLite or filesystem-event reconciliation to repair bypass writes.

## What a refactor must demonstrate

Names and code organization may evolve; these behavioral checks must continue to hold:

- Copy only the published database during overlapping writes, then cold-load it in a clean location with no companion files.
- Query accepted state while persistence is slow/unavailable without opening SQLite.
- Reject invalid/stale/dry-run changes without publishing them; preserve data after publication failure and retry/resume. Specifically test token grant -> checkpoint -> failed publication -> unrelated mutation attempt -> resolved publication/recovery, including shutdown and another already-in-flight grant; required grant data must not disappear.
- Round-trip complete state without an old database, including raw credentials, opaque data, IDs and history.
- Notify in order with supplied views, handle registration races and release subscriptions with their owners.
- Reject stale relevant job results and keep isolated computations independent of ambient state.
- Refuse competing online/offline owners and wait for writers before workspace deletion.
- Preserve legacy WAL import, privacy, cold/resume behavior and configuration-versus-credential restore boundaries.
- Meet unchanged idle/resource budgets; do not reintroduce a poller or raise a ceiling as a substitute for ownership.

These are review criteria, not assertions that the current implementation already passes them. Future implementation work must provide evidence on its final tree.
