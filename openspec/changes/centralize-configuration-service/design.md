## Context

See [proposal.md](proposal.md) for motivation and the three capability deltas under `specs/` for behavioral requirements. The long-lived model is recorded in [State and concurrency](../../../docs/STATE-AND-CONCURRENCY.md); illustrative interface names below are not compatibility requirements.

The planning baseline is `sqlite-snapshots` at `04221761` plus the existing uncommitted candidate. This is a target architecture, not a claim that PR #39 already implements it. The server uses one multithreaded runtime (`crates/cook-router/src/main.rs:505–509`). Its current configuration is a `RwLock<Arc<Config>>`, with publication/subscription mechanisms already present in `runtime.rs:240–325`.

The source audit found four production SQL sink files, but several independent application owners:

| Existing entry family | Current persistence/publication seam | Migration target |
|---|---|---|
| Admin resource edits, import and restore | `Management::commit_with/commit_locked`, `config_store/commit.rs` | Public API adapter submitting a service command |
| API-key toggles | `Management::edit_document` | The same configuration command path |
| Credential upload, edit, delete, OAuth and SIWC | Management adapters plus `CredentialDb`/runtime patch methods | Credential commands with existing admission checks |
| Request/background refresh and normalization | `runtime.rs` save/patch/admission callbacks | Internal commands; preserve relevant registration/version fences |
| Granted Codex token before admission | `refresh_codex_file` persists before `admit_codex_refresh` | Explicit grant-checkpoint versus admitted-runtime transitions |
| Cooldown result/reset persistence | `cooldown_store::Writer` to `Backend::save` | Owned coalesced domain command, not a second persistence owner |
| CLI import and provider login | `config_cli.rs`, `main::login_save` direct writes | Online API adapter or exclusively admitted offline service |
| Bootstrap, migrations, encoding and backups | `config_store/db.rs`, `published.rs` | Private service persistence/lifecycle implementation |

`Management::config_store()` and `CredentialStore::credential_backend()` currently expose writable backends. The pending candidate still contains hash polling and external-snapshot adoption; those are superseded, not retained requirements.

## Goals / Non-Goals

**Goals:**
- Give persistence, current canonical state, runtime publication, callbacks and workspace lifetime one application owner.
- Keep one independently copyable persistent database file throughout the refactor.
- Keep state transformations/encoding explicit and reuse the existing runtime, client, locks, schema and data-preservation behavior.
- Make ownership, ordering, lifecycle and admission rules testable independently of names or module placement.

**Non-Goals:**
- A separately deployed configuration daemon, shared-memory protocol, generic SQL endpoint, new message broker or general concurrency framework.
- Runtime external-file adoption, YAML watching, periodic hashing/metadata/SQLite polling, or an idle connection-eviction timer.
- Dropping history, opaque configuration, credential bytes or existing startup-only setting semantics to simplify serialization.
- Treating all scheduler/credential events as configuration changes, bypassing management authentication, or increasing performance budgets to conceal a regression.

## Decisions

### 1. One in-process service, with adapters rather than competing writers

Use the existing server process. External management interfaces and online CLI commands submit commands; internal refresh/cooldown code calls the same application boundary directly. Do not HTTP-loopback internal work.

Expose read-only views, command submission and callback registration. Move SQL helpers, writable backend handles and workspace mutation behind that boundary. Names and exact type layout can change. A private helper per table is fine; a caller choosing independently whether to persist, replace memory or notify is not.

The existing Home mode is a mutually exclusive remote authority, not a local persistent owner. Main still constructs its disabled Management wrapper, but that wrapper must neither bind nor subscribe to a local SQLite configuration view. Preserve the existing remote Home publication path; do not treat this as a local volatile-write exception.

Reuse/extract `Management::commit_with` semantics instead of building a second publication system. Move the authority below both Management and Runtime adapters so neither needs a cyclic ownership dependency on the other. Keep existing request-held immutable views valid.

**Rejected:** retaining direct online CLI writes plus a watcher, because that restores split ownership and reconciliation. **Deferred:** a true sidecar; it adds transport, identity and lifecycle concerns without a current isolation requirement, and direct callbacks do not cross process boundaries.

### 2. Complete canonical state, with derived and authorized runtime views

The service owns lossless persistent state: resources and stable IDs/order, raw credential documents and metadata, configuration revisions/changes, and persisted cooldown state. The runtime `Config` is a derived view, not sufficient export input.

Load supported durable state once during bootstrap. Serve resource/history/credential queries from memory and derive request configuration, policy and scheduling views from the accepted state. Use immutable snapshots and structural sharing where practical rather than cloning all historical data per request. Existing configuration revision semantics remain; notification versions identify the state supplied to a subscriber. Credential registration/resource versions remain the relevant admission fences.

Do not broadcast the complete secret-bearing canonical state. Export encoding is privileged; consumers receive only their authorized domain views. Configuration history remains separate from credential history, so restoring config cannot recreate revoked tokens. The granted-token checkpoint and runtime admission distinction remains explicit rather than becoming a generic "SQL succeeded, notify everyone" rule.

Volatile request counters, active leases and immediate scheduler feedback remain runtime-owned execution state, not additional writable configuration authorities. A coalesced cooldown command records a canonical durable checkpoint through the service; it need not delay the request's live scheduling decision or broadcast a configuration change.

**Rejected:** rebuilding from `Runtime::config()` alone, which loses resource metadata, raw documents and history; and keeping a second independently writable memory cache in each module.

### 3. A serialized commit, without holding read locks over I/O

A command obtains the write-admission gate, checks its relevant preconditions and builds a validated next-state candidate. Network grants and other long external work happen before this gate; their results are admitted with the existing relevant version/registration checks.

```text
command + current snapshot
          |
          v
validate next state and preconditions
          |
          v
encode complete standalone SQLite image
          |
          v
persist live checkpoint --> publish configured file durably
          |
          v
close transient SQLite/storage operation
          |
          v
replace current memory view --> dispatch ordered callbacks
          |
          v
return committed result
```

The memory read/write lock is held only to obtain/replace snapshot references, never for SQL, filesystem sync or callbacks. The write gate orders commit and notification dispatch; callbacks are notification-only and cannot synchronously reenter that gate. They can schedule a later owned command. Read requests continue using the previous complete state while a candidate is persisted.

Validation/dry-run/precondition failures do not mutate accepted state. A failure before installing a new checkpoint leaves the accepted state intact. A failure after checkpoint installation is different: the candidate can contain a non-repeatable token grant that must not be overwritten from the older accepted view.

#### Publication-pending state

Retain the complete latest checkpoint candidate as private recovery state of the same service. Ordinary mutations and the start of new grant work are refused with a retryable recovery-required result until that candidate has been durably published and reconciled. A retry resolves this state first; it must not regenerate an image from older accepted memory. Queries can still read the last accepted views with an explicit pending/degraded status. An affected credential known to have been invalidated is withheld from new dispatch rather than reused from that older view.

Already-in-flight non-repeatable grant results are preserved when retainable, rather than discarded merely by this gate. Their required preservation is a narrow internal recovery operation: under the same owner, merge/reconcile canonical file-backed results against the **latest pending checkpoint**, persist the resulting checkpoint, and retain the existing relevant registration/admission fences. This does not admit an ordinary configuration command, declare the credential active, or emit a successful-change notification. No separate writer or hidden SQL cache is introduced.

The configured SQLite file remains the complete backup of **supported persistent state**. Volatile held results, like active leases, are component-owned execution state, not an omitted persistent-state domain.

#### User decision: completion-time storage/rendering failures

Controlling user decision: “If the disk fails at the exact moment a login or token refresh completes, it is acceptable for that login to fail and require re-login, provided: never report success, never overwrite already-durable data from stale memory, never deadlock, never resurrect deleted/revoked credentials.” This narrows the preservation guarantee, not the admission or durability rules for acknowledged state. A result lost because local storage/rendering fails at completion may require re-login; it must not permanently block unrelated writes.

Builtin held results distinguish retryable local I/O/storage effects from terminal validation rejection, changed/deleted captured destinations or lost authorization. Retryable failures retain their existing recovery behavior. Terminal failures visibly fail the login and dispose the held value instead of remaining a writer prerequisite; they never apply over changed canonical bytes. Disposal removes only that holder's provider-wide pre-destination withholding. If a resolved destination is still exactly its captured, synthesizable source, retain an exact-source dispatch fence until replacement, deletion or a later successful login settles it. A changed destination or invalid/unsynthesized source needs no extra fence. Unrelated commits do not release the exact-source fence.

Known limitations (accepted, not full task completion):

- Unrendered builtin results are owner-lifetime memory until complete bytes enter the retained checkpoint. Owner exit during a coincident local completion failure can lose that result and require re-login; no process-exit/power-loss promise is made for it.
- Before a retryable failure's exact destination can be rendered, existing file-backed sources of its provider stay withheld until a later owner admission drains the queue. There is no timed background retry, and without later admission withholding can persist indefinitely. This does not permit terminal results to wedge writer admission.
- Legacy builtin writer APIs expose strings. Known validation codes are terminal; opaque effect errors remain conservatively retryable. New validation codes must join that classification or migrate to a typed writer boundary.

Recovery publishes the latest pending state, then installs the appropriate accepted views and dispatches notifications before ordinary mutation admission resumes. The service can retain this state without an open SQLite connection. If publication remains unresolved at shutdown, retain the recovery workspace and report incomplete cleanup; deleting it is not a clean shutdown. Resume can recover an unacknowledged checkpoint only when its storage survives; tmpfs loss still has no such guarantee.

Callback failure does not roll back already durable state. Continue dispatch to other eligible subscribers and report the subscriber error separately. Success means the state is durable, memory is published and notifications have been dispatched, not that every subscriber's expensive downstream work has finished.

### 4. Two logical snapshot functions, with filesystem effects at the edge

Separate `freeze complete state` from `encode immutable state to a new SQLite image`. These descriptions are roles, not mandated function names. The encoder gets every input explicitly and does not read the old working/published database. Use SQLite to construct/serialize a temporary in-memory database or an equivalent fresh builder; do not implement the SQLite file format manually. The native serialization interface is documented at https://sqlite.org/c3ref/serialize.html.

One encoded image can be installed independently as the private recovery checkpoint and configured published file; this reuses generated bytes, not a copy of an existing SQL file. Use private temporary files on each destination filesystem, sync contents, atomically replace, and complete platform-specific directory/metadata durability before success. Close temporary SQLite connections after encoding/persistence; no disk connection/page cache remains idle.

Preserve the currently supported schema and lossless data unless a deliberate migration is required. Legacy WAL recovery is a bootstrap-only exception: read/convert through SQLite so committed WAL data is not lost. Normal export is never sourced from live SQLite or `VACUUM INTO` of an existing database.

The configured path remains one portable artifact: ordinary copies while running need no API, WAL/SHM, journal, live directory, owner file or credential cache. Temporary same-directory construction files are allowed, but are not backup dependencies. Containers still mount its directory so atomic replacement can work.

### 5. Exclusive workspace ownership replaces online multiwriter coordination

Acquire one per-database, process-safe ownership guard before inspecting or creating the working state. Reuse an existing mature cross-platform file-lock primitive (currently available through `codex_siwc_bind` locking helpers or a small provider-neutral extraction). Keep the stable ownership-lock inode outside the recyclable per-database workspace; never unlink it beneath a waiting contender. Holding the guard must not require keeping SQLite open.

Online CLI calls use the existing authenticated management client or a shared extraction of it. Endpoint, credentials and TLS validation are explicit and preserve existing management access policy. Failed discovery, authentication or requests cannot authorize a local-write fallback. An offline command may instantiate the same application service only after obtaining the ownership guard. Read-only copies/exports are not competing mutations.

The current multipart credential upload commits files individually and can return partial results (`management/auth_files.rs:1092–1130`). Keep that legacy behavior separate: introduce a typed authenticated atomic credential-batch operation for CLI batches, reusing existing validation, managed-path authorization and the service transaction. Stage provider outputs in a private CLI scratch area before submitting bytes; never write the running server's credential cache as a substitute for the API. The new adapter must not grant arbitrary host-filesystem write access. Route/payload names are implementation details, not the stable model.

Remove obsolete online multiwriter PID-reference/global-SQL-coordinator machinery after all writers have migrated; do not remove ownership exclusion itself. The service owns cleanup, not arbitrary adapters.

### 6. Bootstrap and shutdown are owned state transitions

- Acquire exclusive ownership and inspect the private working checkpoint.
- Valid initialized checkpoint: decode, validate, establish current memory and republish before readiness (resume).
- No recoverable checkpoint: decode the configured snapshot, establish memory and a fresh checkpoint (cold start). Initial legacy YAML import, if selected, is bootstrap input, not runtime monitoring.
- Empty/schema-empty/corrupt unowned work state: isolate/remove only that disposable state and cold-seed. A supported empty configuration with valid schema is not corrupt. A newer unsupported schema is an error, not permission to erase it.
- Readiness follows validated state and completed required publication. If OS tmp vanished, cold recovery is expected; tmpfs is not power-loss storage.
- Shutdown stops admission, settles critical grants/commits, cancels and joins other owned work, and releases callbacks. It removes the recyclable workspace only when no unresolved recovery checkpoint remains; otherwise it reports incomplete cleanup and preserves that state for resume before releasing ownership. An abnormal exit also leaves recoverable work when its storage survives.

Document cold restoration: stop the owner, prevent an old checkpoint from resuming, then restore the single published file. Do not quietly replace this rule with file hot reload.

### 7. Callback ownership and execution placement stay explicit

Use service-owned function callbacks receiving an immutable authorized view, version and change category. Registration obtains an initial view and subscribes atomically with respect to publication; no change can fall between "read current" and "subscribe". A registration handle ties unsubscription to component lifetime. Invoke without holding the state or subscriber-list lock and preserve commit-order dispatch. Expensive catalog/reconfigure work is enqueued into the receiving component's owned scope, not executed under state locks.

Reuse existing runtime catalog/policy publication behavior and migrate callers, rather than adding parallel watch and callback authorities. A compatibility adapter can translate existing consumers temporarily, but all notifications originate at the service.

Use asynchronous tasks for waits and bounded/owned blocking work for SQL encoding and filesystem work. Use child processes only for external-program or isolation needs. Isolated workers take serialized data/options/relevant versions and return results/errors; they do not capture a Runtime, query global config, infer CWD/env, or load live state. Side-effect adapters supply declared inputs. Admit results at the owner using relevant fences; never pass all credentials to every job.

Use existing cancellation/task tracking and joins, not a new scheduler framework. Every task/thread/process has an owner that can stop admission and wait for it.

## Risks / Trade-offs

- **Complete in-memory history plus image construction increases peak memory and full-image save cost** -> retain data losslessly, use immutable sharing/bounded buffers where useful, and measure representative sizes and current idle/heap/latency budgets. Do not silently truncate history or raise budgets. Every commit re-encodes all credentials and the unbounded configuration history, so commits queue at the single authority; measured costs are recorded in `docs/STATE-AND-CONCURRENCY.md`.
- **API-only CLI behavior changes authentication and offline expectations** -> reuse trusted management discovery/client behavior, document explicit online context, and test authentication/transport failure without disk fallback.
- **Reentrant or slow callbacks can stall writes** -> notification-only dispatch outside memory/list locks, owned follow-up work, explicit non-reentrancy and per-subscriber errors.
- **A checkpoint can be newer than accepted memory after failed export** -> retain explicit publication-pending state, refuse ordinary new mutations until it is resolved, merge already-in-flight required grants only into the latest pending checkpoint, and preserve unresolved work on exit. Test an unrelated mutation between failure and recovery so an old full-state image cannot erase a grant.
- **Platform durability differs** -> use and test native atomic-replacement/synchronization primitives and report unsupported guarantees. A non-Unix no-op directory-sync path is not automatically proof of power-loss durability.
- **Ownership cleanup can recreate unlink races** -> stable lock identity outside disposable work, one owner, and join-before-delete tests.
- **Current partial candidate is not a verified implementation** -> keep known CI failures visible; rerun final-tree gates rather than cite earlier PR reviews.

## Migration Plan

1. Keep the accepted model document as the contract; add behavior examples before changing the existing publication boundary.
2. Introduce service-owned canonical state, memory queries, private encoding/storage and ownership lifecycle while retaining supported schema/legacy import.
3. Route Management, internal refresh/normalization/cooldown paths and startup through it; remove writable backend escape hatches.
4. Route online CLI mutations through management and admit offline mutations exclusively. Preserve raw documents, registration fences, config restore scope and startup-only setting reporting.
5. Migrate subscribers to owned callbacks, then remove polling and external-snapshot adoption. Remove online multiwriter machinery only after this boundary is enforced.
6. Run the final-tree regressions, platform checks and unchanged performance gates. Update operational docs and the PR's evidence without claiming unrun checks passed.

Rollback requires stopping ownership and using a tested earlier binary against a compatible standalone snapshot, with stale working state explicitly isolated. Do not run old online direct writers alongside the new service. No destructive or unsupported schema rollback is assumed; take a standalone backup before migrating real state.
