## 1. Canonical state and the application boundary

- [x] 1.1 Add private-fixture acceptance examples for memory-only queries, sole online ownership and commit/publication order; verify they fail for the current bypass/SQLite-read behavior before implementation, and record the existing `usage_record::tests::redirects_start_the_upload_measurements_over` and `watching::tests::incomplete_documents_keep_the_credential_until_valid_json` outcomes as an explicit baseline rather than hiding them.
- [x] 1.2 Introduce complete service-owned canonical state and derived immutable runtime/domain views using the existing resource/credential/history representations; verify fixture loading preserves IDs/order, opaque plugin fields, raw credential bytes, revision/change history and cooldown checkpoints without a second mutable authority.
- [x] 1.3 Implement memory-only resource, configuration, history and authorized credential queries; verify reads still work with storage disabled after bootstrap and readers retain the old coherent snapshot during a slow mutation.
- [x] 1.4 Add serialized typed command admission with existing resource/credential preconditions and candidate validation; verify invalid input, stale preconditions and dry runs produce no persistence, memory publication or callbacks.

## 2. Fresh images and the commit sequence

- [x] 2.1 Implement the complete-state-to-new-SQLite encoder without an old database input, reusing native SQLite construction/serialization and the supported schema; verify lossless round-trip fixtures with the old database unavailable and standalone header/no-sidecar assertions.
- [x] 2.2 Implement private checkpoint and published-image installation with file synchronization, atomic replacement and native metadata durability; verify ordinary copies taken throughout concurrent publication reopen in a clean location using only the copied file, including already-open old-inode copies.
- [x] 2.3 Wire the ordered storage-close, memory-replacement, notification-dispatch and success boundary; verify fault injection before/after checkpoint and final publication, failed publication plus retry, and the documented recovery of an unacknowledged checkpoint without a false successful-change notification.
- [x] 2.4 Remove idle disk connection ownership from the service/persistence interface; verify startup, successful commands and errors leave no retained disk SQLite handles/page caches, while preserving explicit in-memory fixture/dry-run support and private file permissions.

- [x] 2.5 Implement explicit publication-pending recovery admission rather than rebuilding from old accepted memory; verify grant R0->R1 checkpoint, failed final publication, unrelated mutation attempt and resolved publication/resume retain R1, another already-in-flight grant merges into the latest pending state, and ordinary writes/new grant starts cannot bypass recovery or falsely activate a credential.

## 3. Ownership, startup and recovery

- [x] 3.1 Reuse or minimally extract the existing cross-platform file-lock primitive for exclusive service/offline ownership, with a stable guard identity outside the disposable workspace; verify two owners and an opener racing shutdown cannot write different live inodes or bypass ownership after a network failure.
- [x] 3.2 Implement cold initialization and resume as service-owned transitions; verify valid newer live state wins and republishes before readiness, missing/tmpfs-lost work cold-loads, initialized empty state remains valid, corrupt/schema-empty unowned work falls back, and unsupported newer schemas fail without erasure.
- [x] 3.3 Preserve explicit legacy YAML/credential/schema import and retained-WAL recovery at bootstrap; verify committed legacy WAL content and opaque/raw data survive and an active conflicting legacy connection fails without sidecar deletion.
- [x] 3.4 Implement shutdown admission stop, critical-operation settlement, task/thread/process joining and workspace cleanup; verify in-flight writers finish before deletion, unresolved publication checkpoints are retained with incomplete-cleanup reporting rather than erased, and the existing `DirectoryNotEmpty` regression is exercised repeatedly rather than masked by sleeps or ignored cleanup errors.

## 4. Server-side mutation adapters

- [x] 4.1 Route admin CRUD/apply/import/restore, config API-key toggles and plugin configuration edits through service commands; verify existing ETag/precondition, dry-run, redaction, destination checks, restart-required and configuration-only restore integration tests.
- [x] 4.2 Route credential upload/delete/field/status changes, OAuth/Vertex/SIWC persistence and plugin host/OAuth callbacks through service commands; verify raw document retention, atomicity, stale-edit protection and notification behavior using private mock fixtures.
- [x] 4.3 Route request/background/forced/plugin refresh and normalization through the owner while preserving relevant registration/version checks; verify replaced credentials cannot be overwritten by stale results and cancellation does not lose a grant already responsible for persistence.
- [x] 4.4 Preserve Codex grant-checkpoint versus runtime-admission semantics as explicit domain transitions; verify granted-but-discarded results are durable where required without emitting a false runtime-credential publication.
- [x] 4.5 Move coalesced cooldown persistence behind the service's owned command path without delaying volatile scheduling feedback on disk; verify flush/shutdown, background failure reporting and absence of unrelated configuration callbacks.

## 5. Online and offline CLI integration

- [x] 5.1 Extract/reuse the existing authenticated management client and explicit online context for CLI configuration operations; verify valid import reaches the running owner, TLS/auth/destination checks remain effective, and unauthorized/unreachable service requests leave the local database unchanged.
- [x] 5.2 Add a typed, authenticated atomic credential-batch adapter using existing upload validation and managed-target authorization; verify a later invalid/conflicting document leaves the whole batch unchanged, raw bytes survive, arbitrary host-path writes are refused, and legacy multipart partial-success behavior is not silently changed.
- [x] 5.3 Route provider login/SIWC/Vertex and plugin CLI persistence through that online adapter using private client scratch data; adapt the common save/acknowledgement boundary where necessary and verify no writes reach server credential caches or SQLite directly, including on a single-worker async runtime and HTTP failure.
- [x] 5.4 Admit offline mutations through the same service/commit implementation only with exclusive ownership; verify stopped-service import/login works, a live owner refuses offline writes even when its API cannot be reached, and read-only backup/export is not misclassified as a competing mutation.

## 6. Callbacks and managed execution

- [x] 6.1 Implement owned function-callback registration with an atomic initial view and version-ordered delivery outside state/list locks; verify registration/publication races, read reentrancy, self-unsubscription, subscriber failure isolation and later-command scheduling without deadlock.
- [x] 6.2 Migrate existing access/logging/usage/plugin/catalog/policy/credential consumers to the supplied authorized views; verify they observe the committed version, receive only relevant domain changes and do not reload ambient globals or obtain secret-bearing canonical exports unnecessarily.
- [x] 6.3 Apply the existing cancellation/task tracking and join primitives to the component's async, blocking and child-process work; verify stop-and-wait ownership, bounded admission and no workspace use after cleanup without imposing a deadlocking global blocking-pool limit.
- [x] 6.4 Make isolated job inputs/results explicit with relevant version/registration fences; verify ambient configuration/CWD/environment changes do not alter the supplied computation and stale results cannot overwrite current state while unrelated changes do not spuriously reject valid output.

## 7. Retire bypasses and update operational guidance

- [x] 7.1 Remove the configuration interval, hash/metadata/data-version polling and external-snapshot adoption once all online writers are routed; verify out-of-band replacement is not hot-adopted, internal notifications still work, and no startup/read path accidentally starts another watcher.
- [x] 7.2 Restrict mutable ConfigStore/CredentialDb/connection escape hatches and retire online multiwriter coordinator/ref-marker machinery; verify a whole-repository caller audit includes harness and test wiring, permitted private SQL remains behind the service, and test fixtures cannot sweep a production workspace.
- [x] 7.3 Update CLI/setup/container/restore guidance to match the implemented boundary and link the accepted design contract; verify examples distinguish current behavior from target design, keep the single-file copy promise, and explain deliberate cold restore plus temporary-storage loss without promising tmpfs survives reboot.

## 8. Final-tree verification and handoff

- [x] 8.1 Run affected configuration, credential, management/admin, refresh/plugin, CLI and lifecycle suites on private mock state; verify both previously recorded failing tests are resolved or demonstrated as separately tracked baseline failures, with no test skipped or weakened merely to turn the PR green.
- [x] 8.2 Run final-tree format, workspace locked clippy/tests or nextest, actual harness `--locked` check, third-party notices and the repository-required UI checks; verify all generated manifests/lock/notices agree and report every unrun or failed check rather than substituting an equivalent temporary-manifest build.
- [x] 8.3 Measure unchanged idle gates for one and 2,000 credentials, supported-platform atomic publication, memory-only query behavior and representative complete-state export cost; verify existing budgets remain unchanged and record measured peak memory/latency without inventing savings.
- [x] 8.4 Obtain independent source-and-evidence review against the three specs and `docs/STATE-AND-CONCURRENCY.md`; verify every production mutation family and the single-file recovery regressions are accounted for, then present evidence for human acceptance without automatically merging, publishing or deploying.
