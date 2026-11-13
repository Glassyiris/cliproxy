## Why

Configuration and credential mutations already converge on a few SQL helpers, but their callers independently own persistence, runtime publication and notifications. This leaves CLI writes, refreshes and background persistence dependent on different reconciliation paths; one application service must own the complete transition instead of using periodic file inspection to repair split ownership.

## What Changes

- Introduce a resident, in-process configuration/state service for the current single-process, multithreaded server. It owns the complete canonical state, immutable runtime views, mutation admission, callback subscriptions and temporary-workspace lifecycle. Reads use memory, not SQLite.
- Route external online mutations, including CLI configuration import and login persistence, through authenticated management APIs. Preserve multi-document CLI saves with one typed atomic credential-batch command, rather than the existing multipart upload's per-file partial commits. Internal refresh/scheduler commands call the same application service without HTTP loopback. Offline commands use the same commit implementation only when no running service owns the selected database.
- Serialize changes through one commit boundary: check preconditions, validate the candidate, persist the recovery checkpoint and an atomically published database image, close transient SQLite resources, publish the in-memory state and notify the relevant subscribers before reporting success. If publication fails after checkpoint installation, retain pending recovery state and block ordinary new writes until it is resolved; required already-in-flight grant preservation must not rebuild from stale memory.
- Generate fresh standalone SQLite images from complete immutable state using a separate encoder. Normal export does not copy a live database or use it as the source of `VACUUM INTO`; schema migration and legacy import remain explicit bootstrap concerns.
- Preserve cold-start versus resume behavior and private temporary workspaces. **Preserve the existing single-file backup contract:** copying only the published database while the service runs is sufficient for a standalone cold recovery, without an export API, WAL/SHM, live workspace or ownership files. Keep configuration history and raw credential documents lossless; configuration-history restore must not restore revoked credentials.
- Replace ad hoc publication with owned function-callback subscriptions receiving explicit snapshots, versions and change categories. Keep credentials and cooldowns distinct from ordinary configuration notifications.
- Remove periodic hash/metadata/SQLite polling and automatic external-file adoption. Retire coordination mechanisms needed only for concurrent online database writers while retaining one-owner exclusion for service startup and offline commands.
- Establish owner-scoped asynchronous, blocking-thread and child-process execution. Isolated computation takes explicit input and returns explicit output; it cannot consult ambient mutable configuration. Shutdown stops admission and waits for owned work before workspace deletion.
- **BREAKING**: an online CLI mutation requires a usable, authenticated management connection; transport or authentication failure never falls back to direct database writes. Replacing or editing the published file while the service runs no longer reloads it.
- Record the stable design contract in `docs/STATE-AND-CONCURRENCY.md`, linked from `docs/CONFIGURATION.md`. Interface names, type layout and file placement may evolve; the ownership, commit, data-flow and lifecycle invariants are not implementation options.

## Capabilities

### New Capabilities

- `configuration-service`: single-owner commands, memory-only queries, domain-aware publication, owned callbacks and online/offline writer admission.
- `configuration-persistence`: lossless state-to-SQLite encoding, durable snapshot publication, transient connections, cold/resume recovery and private workspace ownership.
- `managed-execution`: explicit execution placement, owner-scoped shutdown and versioned data-in/data-out isolated computation.

### Modified Capabilities

None. The initialized OpenSpec project has no existing capability specifications; these deltas establish requirements for the change without claiming that every covered API is new.

## Impact

- Server: `config_store/*`, `credential_store.rs`, `management.rs` and its adapters, `runtime.rs`, `watching.rs` and `cooldown_store.rs`.
- CLI: `config_cli.rs`, login persistence in `main.rs`, and the existing authenticated management client in `tui/client.rs` or its extracted shared equivalent.
- Tests: existing resource/revision, credential/CAS, refresh/cancellation, publication/recovery, CLI, private-namespace and shutdown regressions; idle gates must pass without increasing their budgets.
- Documentation: a durable design contract and corresponding deployment/CLI guidance during implementation. No new daemon, shared-memory protocol, general SQL interface or notification framework is proposed.
- Planning basis: the `sqlite-snapshots` worktree at HEAD `04221761` plus its pending short-connection changes. Earlier PR #39 validation does not prove this target design is implemented or that its current CI failures are resolved. Existing dependencies and reusable runtime/locking primitives are preferred; no new dependency is assumed.
