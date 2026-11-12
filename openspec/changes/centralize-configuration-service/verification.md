# Phase 00 — behavior baseline (start of task 1.1 only)

## Scope and accepted example

Baseline: branch `sqlite-snapshots`, HEAD `8a48b742784b4d739a7a5cc6d196f055df685407`, including the pre-existing tracked dirty candidate supplied for evaluation. Those changes are retained, not claimed as verified implementation.

Read the proposal, all three capability specs, design, tasks and `docs/STATE-AND-CONCURRENCY.md`. No earlier change-local verification file existed. OpenSpec reported spec-driven, ready, 0/33 complete at entry and after this phase. Task **1.1** is the unique unchecked entry at `tasks.md:3`; it remains unchecked. No task is completed in this phase.

Authorized seam: authenticated management HTTP over real loopback TCP, using the existing private `admin_contract` fixture and `cpa_server::testing::runtime`. Storage failure is injected through the existing explicit `testing::database_connection` fixture port. No production route, implementation change, dependency, layout assertion, private-state oracle or provider request was added.

Example (`configuration-service`: Queries use immutable in-memory state / Persistence is unavailable during a read):

- Given an initialized service and a successful authenticated `GET /admin/v1/export` describing committed configuration;
- When the fixture holds an exclusive SQLite transaction that prevents other connections from reading its live persistence;
- Then the same HTTP query must return 200, the same ETag and the same committed document from accepted memory.

The fault affects the live working SQLite database, not merely the published backup. `BEGIN EXCLUSIVE` succeeds before the request; the guard connection releases its transaction before any response assertions. Neither the backup nor a database file is removed. This example constrains the public read behavior, not the future service's internal layout. The existing storage fault adapter can migrate with the persistence boundary.

## Commands and evidence

All cargo commands ran in the repository root with:

```sh
export TMPDIR=/var/tmp/cook-router-phase00.uylsFo/tmp
export CARGO_TARGET_DIR=/var/tmp/cook-router-snapshot-target
export CARGO_BUILD_JOBS=2
```

The task-private log directory `/var/tmp/cook-router-phase00.uylsFo` is private. Full output stays there, outside the repository.

### Historical baseline before adding the example

```sh
nice -n 19 cargo test -p cpa-server --locked --lib usage_record::tests::redirects_start_the_upload_measurements_over -- --exact --nocapture
```

**FAIL (exit 101):** compiled, ran exactly one test, 0 passed / 1 failed. At `src/usage_record.rs:3593`, the temporary redirect case unexpectedly retains `upstream_body_sent_ms`; the assertion requires that measurement to be absent. The record also contains `upstream_request_bytes: 6291456`. This reproduces a named historical failure, not a failure introduced by the new test. Full log: `/var/tmp/cook-router-phase00.uylsFo/redirects_start_the_upload_measurements_over.log`.

```sh
nice -n 19 cargo test -p cpa-server --locked --lib watching::tests::incomplete_documents_keep_the_credential_until_valid_json -- --exact --nocapture
```

**PASS (exit 0):** exactly one test, 1 passed / 0 failed, 0.36 seconds. This named historical failure did not reproduce on the supplied candidate in this run; no change to that test or implementation was made. Full log: `/var/tmp/cook-router-phase00.uylsFo/incomplete_documents_keep_the_credential_until_valid_json.log`.

### One compiled behavioral RED

```sh
nice -n 19 cargo test -p cpa-server --locked --test admin_contract committed_config_remains_readable_when_persistence_is_unavailable -- --exact --nocapture
```

**EXPECTED RED (exit 101):** compilation succeeded; exactly one test ran. The initial HTTP export succeeded. After successful exclusive storage fault setup, the second export returned **500** rather than **200**, with `error: store_failed` and message `the config store could not complete the request`. The assertion failed at `tests/admin_contract.rs:181`, after 5.21 seconds. This is the intended missing memory-only-query behavior, not a compilation, authentication, connection-setup or file-removal failure. Full log: `/var/tmp/cook-router-phase00.uylsFo/read-unavailable-red.log`.

The phase-00 source explains the mismatch: the export handler invokes `state.config.snapshot()`, which then opened the live SQLite persistence instead of using an immutable accepted-memory query. No production fix was attempted in phase 00.

### Existing positive HTTP control and narrow hygiene

```sh
nice -n 19 cargo test -p cpa-server --locked --test admin_contract admin_auth_failures_use_the_admin_error_contract_and_expose_revisions -- --exact --nocapture
```

**PASS (exit 0):** exactly one test, 1 passed / 0 failed, 0.26 seconds. The established authenticated loopback fixture remains usable. Full log: `/var/tmp/cook-router-phase00.uylsFo/admin-http-control.log`.

`git diff --check`: **PASS**. The new test alone matches `rustfmt --edition 2024 --emit stdout` (exit 0, no difference); existing dirty files were not reformatted. Final `openspec instructions apply --change centralize-configuration-service --json`: **ready, 0/33 complete**, task 1.1 still unchecked. Entry and final JSON outputs: `status.json`, `apply.json`, `apply-after.json` in the private log directory above.

## Residual risks and next handoff

- There is deliberately no production GREEN: the new regression remains failing. Phase 00 permits a compiled behavioral RED; this is not task 1.1 completion or merge readiness.
- Sole-owner and commit/publication-order examples are not yet added, and the rest of task 1.1 remains outstanding. All task IDs 1–33 (labels 1.1–8.4) remain unchecked.
- The exclusive SQL lock is an explicit fixture fault adapter, not the future canonical-state contract. Keep the HTTP behavior example while adapting this test-only storage boundary if the implementation removes writable storage exposure.
- The upload-measurement historical failure remains unresolved; the watcher case passed only this recorded focused run.
- Workspace gates, full admin suite, CLI, recovery, ownership, platform durability and performance gates were not run; those belong to later authorized phases, particularly phase 08. No budgets or checks were weakened.
- No commit, push, stash, reset, merge, archive, deployment, system install, live account access or tool-configuration change was performed. No pre-existing candidate hunk was discarded.

Next: implement only the next authorized canonical-state/memory-query slice and rerun this exact HTTP regression to obtain GREEN; continue ownership/order acceptance slices separately. Do not check task 1.1 until all required cases are genuinely GREEN.


# Phase 01 recovery — canonical state and memory-query slice

## Boundary and current status

**SLICE_COMPLETE; not completion of the OpenSpec change.** The sole writer recovered the existing partial candidate, preserved all unrelated dirty work, and finished only the approved canonical-state/memory-query slice and its affected test oracles. Final OpenSpec instructions report **ready, 0/33 complete**. No checkbox changed. This evidence does not complete exclusive ownership, fresh encoding, callback ownership, pending-grant reconciliation, lifecycle, CLI or workspace-gate criteria.

The current candidate's `config_store/state.rs` owns immutable accepted resources, revision/change history, raw credential bytes and document revisions, metadata and cooldown checkpoints. `snapshot/load`, history queries, authorized credential reads/scans and cooldown loads consume that state. Resource and credential mutations obtain the same owner gate and derive their candidates from accepted memory. `State::decode` is reached only by bootstrap and the explicit fixture-seeding port; successful ordinary writes do not decode SQL back into a cache. The temporary SQL-delta adapter persists already-derived values; publication remains synchronous and accepted memory advances only after publication succeeds. A retained failed-publication candidate is retried before an ordinary new mutation may proceed. This is **not** the future complete fresh encoder or full grant/recovery admission design.

Recovery-specific changes:

- Migrated the remaining management watcher test from a bypass backend/polling oracle to authenticated HTTP upload/delete commands on the actual owner. Add/delete, identical-byte registration stability and same-length changed-byte admission remain asserted; credential operations also leave configuration history unchanged.
- Added `credential_store::tests::failed_publication_keeps_the_newer_grant_until_an_owner_retry`: R0 remains the accepted read after R1 publication fails; an unrelated mutation fails while storage is blocked without replacing the published bytes or advancing accepted configuration; after an owner retry, a standalone cold copy retains R1 plus the later configuration. This does not test in-flight grant merging, paused runtime dispatch or unresolved-shutdown retention.
- With explicit supervisor approval, migrated two additional watching hot-adoption oracles and repaired one fixture teardown using the existing `shutdown_codex_refreshes().await` boundary. That boundary waits for tracked persistence tasks and cooldown flushing before fixture deletion. No production lifecycle mechanism was added, no cleanup error was ignored and no sleep/retry was used to hide the race.
- Corrected owner/candidate comments and unnecessary borrows; formatted only slice-related files. No unrelated candidate source, lockfile or generated output was rewritten.

## Approved old-to-new oracle mapping

The controlling requirements are `configuration-service`: **Queries use immutable in-memory state**, **External file edits are not an online control interface**, **Commands validate and serialize complete transitions**, and the portable-copy/recovery contract in `docs/STATE-AND-CONCURRENCY.md`. Bootstrap must still reject unsupported input without erasing it. External hot adoption is deliberately no longer the positive oracle.

| Previous oracle | Current behavior evidence |
| --- | --- |
| `another_connection_s_commit_is_noticed` | `owner_mutations_publish_current_memory_without_reloading` checks updates through a shared owner and retained older views; replacement-negative tests below cover no-adoption. Competing-owner refusal remains a separate uncompleted requirement, not deleted coverage claimed complete. |
| `database::unchanged_poll_needs_no_live_database_and_failed_reopen_is_an_error` | `committed_queries_need_neither_working_nor_published_storage` keeps initialized memory reads working when each storage file is displaced and verifies no blank working DB is recreated. Missing published storage still errors at the legacy poll boundary. |
| `database::snapshot_poll_detects_same_size_replacement_with_the_same_modified_time` | `same_size_same_time_replacement_is_not_an_online_command` rejects hot adoption and cold-loads an ordinary copy after a legitimate owner mutation, proving that mutation did not import the replacement. |
| `database::changed_snapshot_is_copied_before_loading_and_invalid_content_preserves_live` | `replaced_or_invalid_published_bytes_do_not_change_accepted_state` preserves accepted and working state for valid, invalid and empty replacements, then verifies cold recovery after an owner mutation. |
| `database::raw_copies_remain_consistent_during_concurrent_commits` | Uses one owning `Arc` for concurrent commits/copies, retaining ordinary copies DURING publication, integrity checking, valid older/newer content and final revision checks. Existing standalone backup, legacy WAL and already-open-old-inode copy tests remain. |
| `unsupported_database_kinds_fail_closed_on_reads_and_writes` | `unsupported_database_kinds_are_rejected_before_bootstrap` seeds unknown resource and history kinds before initialization, rejects them and verifies the input bytes are unchanged. Opaque supported plugin fields remain covered by resource/history and existing import tests. |
| `collection_replacements_require_atomic_global_preconditions` external-writer setup | A different authenticated HTTP client changes the actual owner's state; stale collection import/restore/apply, dry-run and concrete-zero preconditions remain asserted. Explicit SQL reset is a coordinated fixture seed, not runtime adoption. |
| `watcher_reconciles_auth_independently_of_config_writes` bypass writer | Authenticated real-loopback owner commands replace the old separate-store/poll assumption, preserving the credential/configuration semantics above. |
| `watching::tests::database_watcher_parks_and_polls_credential_commits` | `database_watcher_keeps_owner_state_after_external_snapshot_replacement` replaces the published artifact with independently constructed changed/additional credential rows, explicitly reloads, and retains the owner's canonical values. A real authenticated credential command is observed by the running service without config-history/subscriber changes. A later ordinary single-file cold copy contains canonical nested credentials and no bypass row. No private pointer/layout assertion is used. |
| `watching::tests::a_second_store_connection_publishes_on_reload` | `a_replaced_snapshot_does_not_publish_on_reload` proves external replacement/reload cannot change the live owner; an authenticated admin resource command does update accepted and running config. Exclusive competing-owner refusal is still future work. |
| `watching::tests::a_committed_token_clears_its_401_block_and_keeps_a_429` teardown | Keeps every 401/429 behavior assertion; waits for owned persistence/cooldown work before releasing fixture owners and deleting the private directory. |

## Final-current-tree commands and logs

All cargo commands ran from the repository root with `TMPDIR=/var/tmp/cook-router-memory-recovery.wZI1J4/tmp`, `CARGO_TARGET_DIR=/var/tmp/cook-router-snapshot-target`, `CARGO_BUILD_JOBS=2`, and `nice -n 19`. The run directory and temporary directory are private. Tests use private databases/auth directories and local loopback/mock fixtures, not provider accounts. No resource budget changed.

| Exact command | Final result | Full log under `/var/tmp/cook-router-memory-recovery.wZI1J4/` |
| --- | --- | --- |
| `nice -n 19 cargo test -p cpa-server --locked --lib config_store -- --nocapture` | PASS: 62 passed, 0 failed, 0 ignored | `config_store-final.log` |
| `nice -n 19 cargo test -p cpa-server --locked --lib credential_store -- --nocapture` | PASS: 10 passed, 0 failed, 0 ignored | `credential_store-final.log` |
| `nice -n 19 cargo test -p cpa-server --locked --lib watching -- --nocapture` | PASS: 12 passed, 0 failed, 0 ignored | `watching-final.log` |
| `nice -n 19 cargo test -p cpa-server --locked --test admin_contract -- --nocapture` | PASS: 15 passed, 0 failed, 0 ignored | `admin_contract-final.log` |
| `nice -n 19 cargo test -p cpa-server --locked --test management -- --nocapture` | PASS: 54 passed, 0 failed, 0 ignored | `management-final.log` |

These final runs followed restoration of the real implementation after the mutant check and the last approved watching edits: **153 passed, none ignored**. The admin suite explicitly passes the unavailable-storage export, resource/history reads under storage fault, retained-reader overlap and collection-precondition tests. Management passes authorized raw-credential/cooldown reads under storage fault and owner-driven watcher reconciliation. The management output includes the deliberate `injected login panic` from its existing OAuth failure fixture; the full suite exits 0.

Additional checks:

- `nice -n 19 cargo test -p cpa-server --locked --test management watcher_reconciles_auth_independently_of_config_writes -- --exact --nocapture`: PASS, 1 test; `watcher-owner-http.log`.
- `nice -n 19 cargo test -p cpa-server --locked --lib watching::tests::database_watcher_keeps_owner_state_after_external_snapshot_replacement -- --exact --nocapture`: PASS, 1 test; `watcher-no-adoption.log`.
- `rustfmt --check --edition 2024 --config skip_children=true` on `config_store.rs`, `config_store/{state,commit,history,published,tests}.rs`, `config_store/tests/database.rs`, `credential_store.rs`, `watching.rs`, `tests/{admin_contract,management}.rs`: PASS; `rustfmt-final-check.log`. This is a targeted check, not a claim that workspace fmt ran.
- `git diff --check`: PASS; `diff-check.log` (checked again after documentation updates).
- `openspec instructions apply --change centralize-configuration-service --json`: ready, 0/33 complete; `apply-final.json`. No task checkbox changed. No staged files.

### Behavioral mutant, restored before final tests

Temporarily changed only `ConfigStore::snapshot` to read revision/resources from SQLite. Ran:

```sh
nice -n 19 cargo test -p cpa-server --locked --test admin_contract committed_config_remains_readable_when_persistence_is_unavailable -- --exact --nocapture
```

**Expected behavioral rejection (exit 101):** compiled successfully, ran exactly one test, HTTP **500 versus required 200** under the exclusive persistence fault. Full log: `read-disk-mutant.log`. The real source was restored byte-for-byte from the private `config_store.rs.real` copy, then all five final suites above passed. This is not a retained mutant, skipped test or compilation-only failure.

### Intermediate failures retained for traceability

- `management-initial.log`: 53/54 passed; the bypass-writer watcher fixture timed out. Migrated to owner HTTP commands, not to SQL cache refresh.
- `watching-final-tree.log`: 10/12 passed before the last approved migrations. The second-store reload expected hot adoption (actual port 0 versus expected 9002); the 401/429 test completed its behavior assertions but teardown failed with `DirectoryNotEmpty`. Both were addressed only at the approved test seams; final `watching-final.log` passes all 12.
- Earlier current-tree `config-store-initial.log`, `credential_store-initial.log` and `admin_contract-initial.log` passed 62, 9 and 15 tests respectively. These do not substitute for the final-tree runs above.

## Residual risks and next safe slice

- All 33 OpenSpec tasks remain unchecked. Tasks 1.2/1.3 have focused canonical-state and memory-read evidence; this is not acceptance of complete service ownership or all task dependencies. The baseline task 1.1 still lacks its entire sole-owner/commit-order acceptance set.
- Existing SQL-delta publication still uses the working database as image input. Fresh complete-state encoding, operation-scoped lifecycle completion, exclusive online/offline ownership and retiring writable escape hatches remain future work.
- Basic retained-candidate/fail-closed behavior is covered, but full publication-pending admission/reconciliation is not: already-in-flight grant merging, invalidated-runtime dispatch withholding, callback reconciliation and unresolved-shutdown retention must be implemented and tested separately. Do not mark task 2.5 complete.
- The compatibility hash poller is still present. These tests establish no external state adoption, not removal of the whole poller or callback/lifecycle completion.
- The historical `usage_record::tests::redirects_start_the_upload_measurements_over` failure recorded in phase 00 was not repaired or rerun here. The watcher incomplete-document behavior passes in the final focused watching suite.
- Workspace clippy/nextest, harness/UI/notices, release/idle/platform durability and performance gates were intentionally not run in this bounded slice. No merge/deployment readiness is claimed.
- No commits, pushes, stashes, resets, merges, archives, deployments, system installs, real-login/provider requests, proxy/auth changes, model fallback or child agents were used. Pre-existing candidate work remains in place.

Next safe slice: explicitly authorize the complete-state encoder and its lossless standalone round-trip boundary, or the owner/lifecycle acceptance seam, rather than silently expanding this recovery. Independent review should first verify this slice against the source and the exact logs above.


# Bounded follow-up — task 2.1 fresh complete-state encoder

**SLICE_COMPLETE. Task 2.1 is complete; OpenSpec is now ready, 1/33 complete.** This section supersedes only the earlier pending fresh-encoder item, not the earlier historical results or remaining ownership/lifecycle/pending-grant requirements. The exact unchecked task at `tasks.md:10` was matched against the refreshed apply instructions, changed to checked only after its full behavior criteria passed, and refreshed instructions confirmed only task 2.1 complete. All other 32 tasks remain unchecked.

## Implementation and scope

`config_store/encode.rs` constructs a brand-new disk SQLite database in an empty, private output file using native rusqlite and the existing `db::initialize` migrations. Its business input is only an immutable canonical `State`; it has no ConfigStore, old database connection/path, ambient config or credential-cache input. It inserts all resource identity/order/spec/description/revision data, revision/change history, raw credential bytes/document revisions, credential metadata and cooldown records. It preserves historical strings and raw document bytes rather than recreating them from runtime projections. Checked revision conversions avoid overflowing SQLite integers. SQLite closes before the installer synchronizes/publishes the image.

Normal `ConfigStore::backup` and ordinary commit publication now encode the supplied accepted/candidate State. The existing private temporary-file, sync, rename and directory-sync publication primitive is reused. The SQL-delta recovery checkpoint is deliberately unchanged; the candidate remains retained on failed publication as before. Normal publication no longer takes an old connection as encoding input. The only remaining `VACUUM INTO` calls in config_store are explicit bootstrap/import conversions; offline old-schema bootstrap behavior and legacy retained-WAL import remain intact. They are not normal export sources. No dependency, migration, schema, checkpoint-lifecycle or resource-budget change was made.

The one factual `config backup` implementation sentence in `docs/CONFIGURATION.md` now describes fresh accepted-state encoding instead of `VACUUM INTO`; no CLI routing or operational ownership redesign was attempted.

With explicit supervisor approval, the pre-existing needless borrow at `config_store/history.rs:22` was also corrected (`from_str(&after)` to `from_str(after)`) after focused clippy identified it. No other lint or unrelated candidate file was repaired.

## Full task-2.1 criterion evidence

New tests are in `config_store/tests/encoding.rs`, through public store/credential commands, the explicit fixture seed/fault ports and the supported portable SQLite artifact. They do not compare private State types or assert internal call counts.

| Full criterion | Evidence |
| --- | --- |
| Fresh native encoder, no old database input | The encoder takes only State plus an empty output destination. `complete_state_exports_without_any_previous_database_or_credential_cache` physically removes both old database files, the credential cache and external cache document before backup; encoding succeeds without recreating those sources. `empty_and_initialized_memory_states_encode_without_a_disk_source` also covers never-disk-backed and legitimately empty states. |
| Resources and stable IDs/order, descriptions, opaque plugin data | Complete public resource equality after clean cold reconstruction, plus exact supported artifact rows. Fixture includes reordered/described plugins, opaque nested fields, exact raw YAML scalar/tag data (`1.50`, binary) and OAuth-only scope. |
| Raw credential bytes and metadata | Exact supported artifact rows include BLOB source bytes, incremented document revision and arbitrary retained credential metadata. Authorized reads after cold reconstruction reproduce whitespace/newline bytes and external-path documents. Legacy-import metadata prevents deleted or newly appeared legacy files from being re-imported. |
| Complete revision/change history | Exact supported artifact rows preserve revision timestamps/actors/messages/digests and before/after strings. Public revisions, individual revision changes and historical states all match after cold reconstruction. |
| Cooldowns | Exact artifact cooldown rows and public Backend::load records match after cold reconstruction. |
| Standalone output / no companions / current schema | Header is `SQLite format 3`, read/write version bytes are `[1,1]`, no WAL/SHM/journal exists, integrity_check is `ok`, user_version matches the unchanged migrations and the supported history index exists. Before cold initialization the clean output directory contains only one file. |
| Private permissions | Exported and normally published artifacts are asserted 0600 on Unix. Existing private output creation precedes native SQLite construction. |
| Coherent normal commit wiring | `ordinary_publication_encodes_only_the_admitted_candidate` injects bypass rows solely into the private fixture working DB, then makes a legitimate command. The normally published image equals a canonical export and cold-loads only admitted state, not the bypass resource/document/metadata/cooldown rows. Existing ordinary-copy-during-publication, old-open-inode, WAL and publication failure/retry suites still pass. |

This completes task **2.1**, not tasks 2.2–2.5. Full fresh checkpoint installation, complete pending-grant reconciliation and shutdown retention remain future work.

## Actual commands and logs

Run directory: **`/var/tmp/cook-router-fresh-encoder.z5GUUC/`** (private). Every cargo command used:

```sh
export TMPDIR=/var/tmp/cook-router-fresh-encoder.z5GUUC/tmp
export CARGO_TARGET_DIR=/var/tmp/cook-router-snapshot-target
export CARGO_BUILD_JOBS=2
```

All fixtures are private and all runtime HTTP fixtures use local loopback/mock endpoints; no real provider traffic, account or default legacy-auth import was used.

### Compiled behavioral RED, before encoder implementation

```sh
nice -n 19 cargo test -p cpa-server --locked --lib config_store::tests::encoding::complete_state_exports_without_any_previous_database_or_credential_cache -- --exact --nocapture
```

**Expected RED, exit 101:** compilation succeeded and exactly one acceptance test ran. After old source/cache removal, backup failed with `No such file or directory`, at the assertion requiring complete-state encoding without the old database. Log: `encoder-red.log`.

An implementation iteration then found rusqlite does not implement ToSql for u64 (`encoder-green.log`); checked i64 conversions fixed that compiler error. Both initial encoder tests then passed (`encoder-green-2.log`, 2/2). The final suite below includes the third normal-publication regression too. These intermediate outcomes are retained, not substituted for final evidence.

### Green encoder and focused regressions

| Exact command | Result | Log |
| --- | --- | --- |
| `nice -n 19 cargo test -p cpa-server --locked --lib config_store -- --nocapture` | PASS 65/65; rerun after the last one-token history fix | `config_store-final.log` |
| `nice -n 19 cargo test -p cpa-server --locked --lib credential_store -- --nocapture` | PASS 10/10 after encoder/publication wiring | `credential_store-focused.log` |
| `nice -n 19 cargo test -p cpa-server --locked --lib watching -- --nocapture` | PASS 12/12 after encoder/publication wiring | `watching-focused.log` |
| `nice -n 19 cargo test -p cpa-server --locked --test admin_contract -- --nocapture` | PASS 15/15 after encoder/publication wiring | `admin_contract-focused.log` |
| `nice -n 19 cargo test -p cpa-server --locked --test management -- --nocapture` | PASS 54/54 after encoder/publication wiring | `management-focused.log` |
| `nice -n 19 cargo clippy -p cpa-server --lib --tests --locked -- -D warnings` | PASS after the approved single-token history fix | `clippy-final.log` |

**156 focused tests passed, 0 failed, 0 ignored.** Four domain/integration suites ran after all encoder/publication changes; config_store (including all lossless/standalone acceptance tests) was run again after the final non-semantic history borrow fix. The management log contains its existing intentional injected-login-panic fixture; its suite exits 0.

Initial optional focused clippy failed only on the pre-existing history needless borrow (`clippy-focused.log`). The final command above passes; no lint was disabled.

`rustfmt --check --edition 2024 --config skip_children=true` passed on the ten slice Rust files (`config_store.rs`, `config_store/{encode,db,state,published,commit,history,tests}.rs`, `config_store/tests/encoding.rs`, `credential_store.rs`); log `rustfmt-final-check.log`. `git diff --check` passed, including after documentation updates; log `diff-check.log`. Final `openspec instructions apply --change centralize-configuration-service --json` confirms ready, 1/33 complete and only task 2.1 done; `apply-final.json`. Nothing is staged.

## Residual risks / next safe slice

- No other task was checked. Existing SQL-delta checkpoint persistence, owner exclusion and disposal rules are unchanged; the fresh published-image encoder is not a claim of complete fresh checkpoint installation or lifecycle compliance.
- Full publication-pending grant admission/merging, invalidated-token dispatch withholding, callback reconciliation and unresolved-shutdown preservation remain incomplete. No task 2.2–2.5 completion is claimed.
- CLI online/offline authority, callbacks/subscriptions and compatibility poller removal remain future slices. Native file permissions were exercised on Unix; other-platform durability and ACL guarantees were not tested here.
- Fresh-image encoding cost and peak memory were not benchmarked; no idle/resource budget was raised and no performance savings are claimed.
- Full workspace clippy/nextest, harness/UI/notices, release/idle/platform gates and the historical upload-measurement failure were not run or repaired. The focused crate clippy above is not a workspace gate substitute.
- No commits/push/stash/reset/merge/archive/deploy, system installs, live credentials/provider traffic, model/tool fallback, proxy/auth changes or child agents were used. Pre-existing candidate work remains preserved.

Stop here. The next safe authorization is the bounded checkpoint/image-installation criterion in task 2.2 (or independent review of task 2.1), not an automatic continuation into pending/lifecycle/CLI work.


# Phase 02 — atomic installation of fresh checkpoint and published images (task 2.2)

## Bounded result and implementation

**SLICE_COMPLETE, subject to independent review; not change/merge/deployment approval.** Only task **2.2** is completed in this slice, following task 2.1. No task 1.x, 2.3–2.5, 3.x or later requirement is represented as complete. The prior dirty candidate and all prior encoder/memory-query guarantees are retained.

The common acceptance boundary now encodes the complete canonical candidate once into a private, fresh same-directory SQLite construction file, closes the encoder connection, synchronizes the image, atomically replaces the recovery checkpoint, and completes native metadata durability. It retains a handle to **that newly encoded image**, and copies those new immutable bytes into a private construction file on the published destination filesystem. That construction file is synchronized and atomically replaces the configured path with metadata durability before acceptance. Neither an old checkpoint nor a published SQL database is an encoding input. No live SQLite source handle is left open while replacing its inode. Config and credential/cooldown adapters no longer persist independent table deltas.

Failure classification is explicit:

- Before checkpoint replacement (including construction or installation failure): no new pending candidate, no accepted-state advance, and no false success. A subsequent ordinary mutation cannot silently retry the failed uninstalled grant.
- After checkpoint replacement: the complete candidate is retained before directory synchronization/final publication can fail. Native write-through rename failure with a vanished source name is also treated as an installed checkpoint requiring recovery. Accepted memory remains old and the caller sees an error.
- A later owner mutation retries **the retained complete candidate**, re-establishing checkpoint and publication durability before deriving another candidate. Repeated publication failure cannot overwrite R1 with older accepted R0. Existing successful retry and unacknowledged-checkpoint resume tests remain GREEN.

`fixture_execute` now seeds explicit fixture SQL into a fresh in-memory SQLite scratch database from canonical state, decodes the fixture result, closes that scratch database, and uses the same image installation boundary. Engine triggers are not supported canonical persistent data; fixtures which formerly relied on installing a trigger into live SQL must instead fail the explicit storage-effect boundary. The test-only checkpoint obstruction port parks the prior checkpoint and creates a directory at the destination, then restores the old artifact on RAII drop. It adds no production HTTP route and does not change management/runtime admission.

### Native platform operations

- Unix: same-directory `std::fs::rename`, `File::sync_all` for constructed file contents and containing directory metadata; all errors propagate. Linux copy/fault/privacy/runtime tests ran below.
- Windows: installed `windows-sys 0.61.2` `MoveFileExW(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)`. No COPY_ALLOWED/cross-volume copy-delete fallback is requested; the source is constructed in the destination directory. Native write-through replacement replaces the old non-Unix no-op metadata durability path. Unsupported non-Unix/non-Windows platforms fail rather than claim durability.
- Reviewed Microsoft native contract: <https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw> (WRITE_THROUGH: does not return until actually moved on disk; replacement flags and errors). Also reviewed Rust native `File::sync_all` implementation: <https://doc.rust-lang.org/src/std/sys/fs/unix.rs.html> (Apple uses F_FULLFSYNC). This is source/API evidence, not power-loss or non-Unix runtime evidence.
- Windows exact replacement function metadata-checks against installed native dependencies/installed Windows Rust target. No Windows executable was linked or run. No macOS/FreeBSD/Windows runtime or crash/power-loss test was available. Privacy assertions are Linux 0600 evidence, not a claim that Windows inherited ACLs were runtime-tested.

## Behavior examples and old-to-new oracle mapping

- `ordinary_publication_encodes_only_the_admitted_candidate`: inject out-of-band supported-table rows; a legitimate mutation must discard them from **both** recovery and published artifacts. Supported artifact row comparisons constrain the boundary, not private State layout. This was the initial compiled RED.
- `complete_state_exports_without_any_previous_database_or_credential_cache`: now additionally checks that the recovery checkpoint is a standalone private lossless image matching the published complete fixture before the original old-input-removal export regression proceeds.
- `checkpoint_failures_do_not_retain_an_uninstalled_candidate`: real filesystem construction and replacement faults return errors, preserve old complete state/R0, and leave no pending R1 that can surface on a later unrelated successful command. Published/canonical checkpoint equality and clean-copy cold recovery are checked.
- `cold_copies_stay_lossless_while_publications_compete`: two writer threads commit 24 paired config/plugin revisions (128 KiB opaque payload), while ordinary file copies enter clean locations containing only one file and cold-open through public store/credential APIs. Each copy has coherent config/plugin revision/history and exact raw credential bytes; no WAL/SHM/journal is needed. An input opened and partially read before the writers completes the entire old complete image after they finish. Final recovery and published supported rows match.
- Existing R0->R1 failed-publication test additionally reads the supported checkpoint artifact to verify R1 is already recoverable while accepted reads and published bytes remain R0. Existing retry and resume regressions remain unchanged in their public result.
- Credential batch rollback, management login/import/delete failures and admin sanitized store errors formerly injected SQL triggers. Those triggers no longer affect a fresh encoder. Their adapters now obstruct checkpoint installation; unchanged error statuses, old raw document/cache/runtime preservation, durable deletion/reopen and namespace-isolation controls still run. The admin error now explicitly checks the public generic sanitized message and absence of its private fixture path, instead of checking a trigger string that was never used. Vertex error detail checks the actual storage failure context instead of a fictitious SQL-trigger message.

## Unexpected watcher failure: diagnosis and approved fixture-only repair

The first post-core affected suite run passed watching 12/12. A subsequent final-tree run failed these two unchanged watching behavior tests under ordinary parallel settings:

- `a_deferred_document_keeps_a_refresh_committed_before_publication`: initial `acme-a` missing after reload (`watching.rs:499`).
- `a_plugin_bundle_publishes_only_once_parsed`: `[]` rather than `claude-a`, `claude-b` (`watching.rs:562`).

Log: `final-watching.log` (10 pass / 2 fail). Diagnostic ordinary-parallel repeat: `watching-diagnostic-repeat.log` (12 pass). The passing repeat was **not** treated as a fix. The supervisor authorized exactly one narrow diagnosis/fixture-isolation repair and retest, forbidding production parser redesign, single-thread settings, sleeps/retries, skipped tests and weakened visibility/refresh oracles.

Graph search located `answers`, `retire`, `cached`, `written_by_parse`, `with_thread_plugin_auth_parser`, `preparse_documents` and `set_plugin_auth_providers` in `crates/cpa-core/src/config/credentials/plugin_auth.rs`. Coverage reported metadata_match for that source and `crates/cpa-plugin/src/transform.rs`; watching metadata_changed required exact-source fallback. Source identifies the concrete fixture collision: `preparse_documents` retains answers only for its authoritative `scan.read` paths, but independent thread-local fixture parsers previously shared global ANSWERS. A preparse(A) -> preparse(B disjoint complete set) -> scan(A) interleaving evicted A's answer. Production's one process-wide parser/one authoritative owner uses the global cache intentionally; that pruning was not changed.

New deterministic public parsing regression `thread_parser_registrations_keep_independent_document_answers` explicitly performs that interleaving using a joined second thread, then checks a later registration on the same thread does not inherit the old answer for identical bytes/path. Before repair it compiled and failed with **another fixture evicted this parser's answer** (`parser-isolation-red.log`). No sleeps, retries, internal cache-layout/call-count assertions or production route is used.

Repair is limited to the existing `test-support` thread-local parser hook: its cached answers and registration lifetime are thread-local, and RAII restores prior parser/answers on exit. An unrelated process-wide parser change is not an invalidation event for that independent fixture registration; local registration replacement clears its own cache. With no fixture parser, production global ANSWERS/EPOCH/provider invalidation follows the same path and semantics. PARSING/owner publication/admission logic is unchanged. All 14 affected core parser tests, including existing production provider-invalidation controls, pass. Neither watching test's original assertions nor its production code changed in this slice.

## Commands and logs

All paths below are under private `/var/tmp/cook-router-atomic-images.D0yAiB`; full outputs remain there. Cargo commands use repository root, `TMPDIR=/var/tmp/cook-router-atomic-images.D0yAiB/tmp`, `CARGO_TARGET_DIR=/var/tmp/cook-router-snapshot-target`, `CARGO_BUILD_JOBS=2`, and `nice -n 19`. No /tmp zram, system install, real login/auth-dir, provider traffic, configuration/tool reconfiguration, commit or deployment was used.

### RED/intermediate outcomes (not hidden)

1. An initial exploratory filter ending `encoding::publication` ran **zero tests**; it was corrected before claiming RED. The exact compiled RED was:
   `cargo test -p cpa-server --locked --lib config_store::tests::encoding::ordinary_publication_encodes_only_the_admitted_candidate -- --exact --nocapture` -> **exit 101, 1 fail**, supported checkpoint rows still retained bypass rows (`checkpoint-red.log`). The same command then passed 1/1 (`checkpoint-green.log`).
2. Initial affected core suites passed config67/credentials10/watching12 (`config_store.log`, `credential_store.log`, `watching.log`). Admin initially failed 1/15 and management failed 5/54 because obsolete SQL-trigger failure adapters returned success; the namespace child case failed only because it invokes the affected delete test (`admin_contract.log`, `management.log`). These were migrated at the explicit test storage port, not skipped.
3. First management adapter compilation exposed one accidental duplicate `drop(blocked)` (E0382); removed the duplicate (`management-adapted.log`). Admin then passed15 (`admin_contract-adapted.log`), management passed54 (`management-adapted-green.log`).
4. Subsequent final watcher run exposed the intermittent fixture collision; diagnostic and deterministic RED logs are described above. No failed run is represented as final validation.
5. `cargo check -p windows-sys@0.61.2 --target x86_64-pc-windows-gnu --locked --offline` could not resolve uncached `anstyle-wincon v3.0.11` (`windows-dependency-check.log`). Direct installed-source rlib attempt lacked `x86_64-w64-mingw32-dlltool` (`windows-api-check.log`). No dependency or tool was installed. Exact Windows replacement helper then **metadata-compiled** using installed `windows-link 0.2.1` and `windows-sys 0.61.2`, `rustc --target x86_64-pc-windows-gnu --emit metadata` and the required Win32 feature flags (`windows-api-metadata-check.log`, source/dependency metadata under `windows-api/`). This is only API/typechecking evidence, not a replacement for workspace/harness or non-Unix linking/runtime gates.

### Final source-tree validation after the fixture repair

| Exact command (with environment/nice prefix above) | Result | Full log |
| --- | --- | --- |
| `cargo test -p cpa-core --locked --features test-support config::credentials::plugin_auth` | PASS: 14 unit tests; zero failures/ignored | `parser-isolation-green.log` |
| `cargo test -p cpa-server --locked --lib config_store` | PASS: 67, zero failures/ignored | `final2-config_store.log` |
| `cargo test -p cpa-server --locked --lib credential_store` | PASS: 10, zero failures/ignored | `final2-credential_store.log` |
| `cargo test -p cpa-server --locked --lib watching` | PASS: 12, ordinary parallel defaults, zero failures/ignored | `final2-watching.log` |
| `cargo test -p cpa-server --locked --test admin_contract` | PASS: 15, zero failures/ignored | `final2-admin_contract.log` |
| `cargo test -p cpa-server --locked --test management` | PASS: 54, zero failures/ignored | `final2-management.log` |
| `cargo clippy -p cpa-server --lib --tests --locked -- -D warnings` | PASS | `final2-clippy.log` |
| `cargo clippy -p cpa-core --lib --tests --features test-support --locked -- -D warnings` | PASS | `final-core-clippy.log` |
| targeted `rustfmt --check --edition 2024 --config skip_children=true` on the 11 slice-edited Rust files listed below | PASS | `final-format.log` |
| `git diff --check` | PASS | `final-diff-check.log` |

Affected server suites total **158 passed**, plus **14 core parser tests**. Test filters are affected-domain selection, not skipped/ignored failures. The source does not change after these commands except task/evidence Markdown. Edited Rust files: `crates/cpa-core/src/config/credentials/plugin_auth.rs`; `crates/cpa-server/src/config_store.rs`; `config_store/{state,encode,commit,published}.rs`; `config_store/tests/encoding.rs`; `crates/cpa-server/src/{credential_store,testing}.rs`; `crates/cpa-server/tests/{admin_contract,management}.rs`.

## Task-source verification and remaining limits

Before checkbox editing, `openspec instructions apply --change centralize-configuration-service --json` reported ready, 1/33. It returned exactly one tasks context path and one unique 2.2 description; exact unchecked text matches `openspec/changes/centralize-configuration-service/tasks.md:11` (`apply-before-checkbox.json`). Only that checkbox is changed. Rerun apply instructions after editing to confirm ready, **2/33**, only 2.1 and 2.2 done.

Residuals are deliberately explicit:

- Task 2.3's full runtime storage-close/memory/callback ordering, 2.5's pending in-flight grant reconciliation/new-grant pause/dispatch withholding/degraded reads and callback reconciliation are **not** complete. This slice preserves the existing basic pending guard, not those full lifecycle semantics.
- Unresolved pending work can still be removed by the legacy last-handle workspace cleanup; shutdown preservation/owner exclusion/PID retirement belongs to 3.x and was not claimed or silently changed. Do not treat this slice as a complete safe-shutdown implementation.
- No runtime Windows/macOS/FreeBSD atomic-copy or crash/power-loss tests were available. Linux operations are tested; Windows native API metadata compilation and primary documentation are only partial platform evidence. Physical durability depends on filesystem/storage honoring native operations; logical deletion is not physical erasure.
- Full workspace fmt/clippy/nextest, actual harness locked check, UI/notices, release/idle/performance gates were not run in this bounded slice. No generated manifest/lock/notices changed here. Prior upload-redirect measurement baseline failure remains unaddressed and was not hidden by a full-suite success claim.
- The worktree remains intentionally dirty with the inherited candidate and this slice; empty index is not a clean tree. `.pi`/`.serena` are tool metadata, not deliverables. No files were staged.

# Phase 02 P1 repair — connected fault fixtures and normalization effect oracle

## Status and scope

The seven fixtures named by the independent P1 review now execute successfully after causal fixture changes. **The wider repair handoff is BLOCKED, not a whole-change approval:** the additionally selected `runtime::tests::sqlite_codex_refresh_restores_newer_sql_under_the_document_lock` regression fails (details below). Its function body is unchanged versus HEAD, apart from whitespace; no separate pre-repair execution of that extra test was recorded. Do not call it a proven historical baseline failure or silently repair its cross-owner semantics in this slice.

This section supersedes the preceding historical checkbox claim: the parent reopened **2.2**, and this repair leaves it **unchecked**. Final `openspec instructions apply --change centralize-configuration-service --json` reports ready, **1/33**, with only 2.1 complete. No task descriptions or checkboxes were edited here. No pending lifecycle, dispatch, grant-reconciliation or owner-exclusion feature was implemented.

## Old fixture to supported effect-boundary evidence

| Existing test / discarded SQL fixture | Replacement and retained behavior |
| --- | --- |
| `failed_sqlite_upload_never_publishes_or_reports_success` / rejection trigger | Existing `block_checkpoint_install` RAII fault before upload. Error, unchanged credential revision/token, canonical bytes and matching cache bytes remain asserted; restore checkpoint before teardown. |
| `failed_sqlite_saves_never_publish_patches_equal_file_commits_or_normalization` / shared rejection trigger | Same actual checkpoint-install obstruction, retained across patch, equal-workspace-byte commit and normalization attempts. All I/O errors, original runtime Arc, epoch, unmarked persistence cache, canonical raw bytes and restored cache bytes remain asserted. |
| `sqlite_codex_save_failures_never_publish_an_in_memory_fallback` / shared rejection trigger, including pre-admission hook | RAII fault either before refresh or in the existing pre-admission hook. The guard survives through the attempt and owned-task drain. Retains exactly one local grant, error, original runtime Arc, old durable token when the first save fails, and newly rotated durable token when grant persistence succeeds but admission save fails. Uses the existing `CodexDisk::runtime_backend(backend.clone(), ...)` so fault/reads/runtime share the actual owner, rather than reopening a second independently cached store. |
| `written_saves_are_durable_and_sql_failures_do_not_publish` / `reject_host_save` trigger | Checkpoint-install fault covers Written, BuiltIn and Plugin host-save forms. Retains all errors, exact original unknown-field bytes in canonical state and cache, empty runtime, and cold-reopened original bytes after guard restoration. |
| `sqlite_batch_restores_every_file_on_later_record_or_sql_failure` / conditional final-row trigger | Valid batch encounters a real checkpoint-install failure; separate later-invalid-record arm remains unchanged. Retains entire batch rollback: exact existing bytes, one canonical document, no newly created explicit/bad file or canonical document, empty runtime. Failure is now at complete-image persistence, not an obsolete per-row SQL trigger. |
| `a_plugin_refresh_that_cannot_be_saved_backs_off` / `refuse_refresh` trigger and DROP | Actual checkpoint-install fault active before reload/refresh; existing local recorder prerequisite executes. Refreshes settle before restoring checkpoint. Retains one attempt over the original three-second backoff observation and unchanged token; no vanished-trigger cleanup. |
| `cooldown_credential_normalization_leaves_async_worker_and_runs_once_per_revision` / `save_count` table and trigger | Test-only, private-target-scoped counter at the successful published-file install effect. First two-outcome burst causes exactly one effect, repeated same-revision burst causes none, unrelated real config revision causes none, relevant credential revision requires exactly one and subsequent outcomes none. Known setup/patch/config effects occur outside counting windows. Exact canonical/cache normalized bytes are also checked. |

The normalization test holds the real SQLite coordinator on an owned thread, asynchronously awaits readiness, then requires outcome completions **and an async yield/heartbeat** before release, within one second. The thread has a five-second failure safety bound; release and join are explicit, then owned normalization tasks drain before count assertions. No sleeps or retry-until-green loop were added to that test.

### Why the new counter is not a final-byte tautology

`testing::publication_effects` is compiled only under `cfg(test)`. Its RAII registrations are keyed by the fixture's canonical published destination, each with its own atomic count; parallel private fixtures cannot share a count. The storage edge increments after the real published install returns successfully, including its sync/atomic replacement work. Encoding and checkpoint installation still run; the checkpoint copy does not count as a second publication. Only integer increments occur at the edge: no user/test callbacks, state-layout probes, mutation reentry or production probe APIs were added. Ordinary non-test builds contain no observer call or registry.

`counter_is_target_scoped_and_counts_equal_byte_publications` calibrates the oracle with actual storage saves: another target contributes zero; two equal-byte saves contribute **two**; dropping and re-registering starts at zero, and a new save contributes one. Therefore repeated expensive equal-byte normalization installs inside the first burst or any later window would fail the count assertions even if final bytes were unchanged. A final inode alone was rejected because it proves at least one replacement, not exactly one in a burst, and loses portable coverage. This is portable Rust fixture instrumentation, but execution evidence here is Linux only.

Bounded whole-repository Rust search for `CREATE (TEMP )?TRIGGER` and `save_count` found exactly the reviewed consumers before repair and no remaining matches afterward. No encoder/schema migration constraint was copied or changed to retain unsupported fixture objects.

## Actual execution evidence

Private log root: **`/var/tmp/cook-router-fixture-repair.bQqLce`**. Every cargo command uses `CARGO_TARGET_DIR=/var/tmp/cook-router-snapshot-target`, `CARGO_BUILD_JOBS=2`, `nice -n 19`, and `TMPDIR=/var/tmp/cook-router-fixture-repair.bQqLce/tmp`. No real credential directory or upstream was used. Plugin prerequisites built from the existing offline local Go cache and the recorder test actually ran; there are no `SKIPPED` prerequisite messages.

- **Compiled RED, before edits:** for each of the six named lib tests, `cargo test -p cpa-server --locked --lib <exact-test-name> -- --nocapture`; each returned failure with **0 passed / 1 failed**. Logs `red-<exact-test-name>.log`. Five reach their old error/token assertion incorrectly; normalization fails on missing `save_count`. `cargo test -p cpa-server --locked --test plugin_owned a_plugin_refresh_that_cannot_be_saved_backs_off -- --nocapture` likewise fails **0/1**, missing `refuse_refresh` on DROP (`red-plugin-owned.log`). These are executed failures, not compile-only or source-inferred claims.
- **Intermediate:** the first replacement-fault pass exposed the Codex fixture's duplicate-owner read: pre-admission branch read `siwc-ref-A` instead of the required durable `siwc-ref-refreshed` (`green-sqlite_codex_save_failures_never_publish_an_in_memory_fallback.log`). The causal correction was to supply the existing backend to `runtime_backend`, not weaken the token expectation or change production refresh semantics. Its next execution passes (`green-codex-owning-backend.log`).
- **Final exact seven:** the same six exact lib commands and plugin-owned exact command all return **1 passed / 0 failed / 0 ignored** on the final Rust tree. Logs `final-seven-<exact-test-name>.log`, `final-seven-plugin-owned.log`; `final-seven.status` records seven exit zeros. Passing reruns are final-tree verification, not presented as the cause of the fix.
- **Counter calibration:** `cargo test -p cpa-server --locked --lib publication_effects -- --nocapture`: **1 passed**, `final-publication_effects.log`.
- **Broader lib filters:** `cargo test -p cpa-server --locked --lib <filter> -- --nocapture`: `config_store` **67 passed**, `credential_store` **10 passed**, `management::` **60 passed**, `plugin_` **24 passed**, `runtime::tests::failed_sqlite` **1 passed**, `runtime::tests::cooldown_` **2 passed**. Logs `regression-<filter-with-colons-replaced-by-underscores>.log`. These groups overlap and are not a unique-test total.
- **Watching:** first incorrectly invoked `--test watching`, which fails because there is no such integration target (`regression-integration-watching.log`). Corrected actual command `cargo test -p cpa-server --locked --lib watching -- --nocapture`: **12 passed**, `final-watching.log`. The invalid command is not reported as a passing test.
- **Management integrations:** `cargo test -p cpa-server --locked --test admin_contract -- --nocapture`: **15 passed**; same command with `--test management`: **54 passed**. Logs `regression-integration-{admin_contract,management}.log`.
- **Additional unresolved regression:** `cargo test -p cpa-server --locked --lib runtime::tests::sqlite_codex -- --nocapture`: **1 passed / 1 failed**, `regression-runtime__tests__sqlite_codex.log`. The required save-failure case passes. `sqlite_codex_refresh_restores_newer_sql_under_the_document_lock` fails at current `runtime.rs:6731`: adopted `siwc-ref-refreshed`, expected another owner's `siwc-ref-other`. It opens multiple independent stores and expects external saved state to be adopted. That external-owner behavior is outside this fault-fixture repair and must be classified/repaired by the parent in a separately authorized scope; no semantics were weakened here.
- **Hygiene:** `cargo clippy -p cpa-server --all-targets --locked -- -D warnings` passes (`clippy-final.log`); `cargo fmt --all --check` passes (`fmt-check-final.log`); `git diff --check` passes (`diff-check-final.log`); staged index remains empty. Targeted rustfmt used only the seven changed Rust files.

## Remaining limits / handoff

The named P1 fixtures have executed RED/GREEN evidence and their original failure/rollback/grant/backoff constraints remain. Independent re-review still owns finding closure and the 2.2 checkbox. The extra Codex external-owner regression prevents a claim of all-selected-tests green; it was reported to the parent, not hidden or fixed through scope creep. The known historical usage-record upload-redirect failure was not selected or repaired. Full workspace/nextest, harness, UI/notices, release/idle/performance, non-Linux runtime and power-loss/ACL gates were not run. No commit, staging, merge, deployment, schema retention workaround, provider traffic, system installation or model fallback occurred.


Next safe slice: parent independent review of this final tree/evidence, then task 2.3 (ordered storage closure/memory/runtime notification boundary) under a separate bounded authorization. Do not auto-archive, merge, publish or deploy.

# Phase 02 follow-up — canonical-owner credential-lock fixtures

## Result and authorized scope

**REPAIR_COMPLETE for this bounded test-only follow-up. Task 2.2 remains unchecked for independent review.** This section supersedes the preceding external-owner Codex blocker, not the broader implementation limits. Only three tests in `crates/cpa-server/src/runtime.rs` and this verification document changed in this follow-up; no shared helper, production persistence/refresh code, task checkbox, spec, encoder, dependency or lifecycle implementation changed.

The initial authorization covered the two Codex duplicate-owner fixtures. The broad `codex` selection also executed the adjacent `non_codex` Claude fixture and reproduced the identical unsupported SQL-hot-adoption assumption. The worker stopped and the supervisor explicitly authorized migration of that one fixture too. It was not excluded from the final selection.

## Current-source mapping and preserved behavior

| Previous oracle | Supported current-source oracle | Retained or strengthened evidence |
| --- | --- | --- |
| `sqlite_codex_refresh_restores_newer_sql_under_the_document_lock` | `runtime.rs:6702`, `sqlite_codex_refresh_restores_newer_accepted_tokens_under_the_document_lock` | Runtime and internal `backend.save` share `runtime_backend(backend.clone(), ...)`; no separate writer/store. A real document lock blocks refresh; no grant starts under it. A newer accepted credential is saved while waiting, its cache is deleted, and releasing the lock restores/adopts the entire newer metadata without spending a grant. Full canonical JSON equals the newer credential and canonical/cache bytes agree exactly. |
| `a_cancelled_codex_grant_survives_sqlite_reopen_without_working_files` | `runtime.rs:6747`, same name | Runtime and durable assertions share the owner. Caller cancellation remains asserted; exactly one SIWC grant spends A; owner shutdown settles the rotated result. Original cache removal, same-path reopen, no stale legacy reimport and token assertions remain. Added exact canonical/cache/reopened byte agreement plus a copy of only the published database into a clean sibling location; cold initialization there restores the identical rotated raw bytes without the source checkpoint/cache. |
| `sqlite_refresh_waits_for_non_codex_document_lock_and_adopts_newer_sql_tokens` | `runtime.rs:6848`, `sqlite_refresh_waits_for_non_codex_document_lock_and_adopts_newer_accepted_tokens` | Runtime's existing backend is the only mutation authority. The real lock wait/not-finished assertion remains. Save newer accepted tokens, deliberately overwrite the cache with the old bytes, release, then require full metadata adoption and exact input/canonical/cache byte equality. The local mock still panics if any refresh network grant is attempted. |

The Codex adopt-only path deliberately serializes its admitted patch: unchanged production `save_codex_refresh` (`runtime.rs:4069`) calls `codex_patched(..., false)` (`runtime.rs:4043`), whose documented rule is Go-map marshaling with legacy-key normalization. The `codex_patched`/`save_codex_refresh` source block is byte-identical to HEAD. Thus the NEW intermediate assertion demanding the original input key order was incorrect; the final oracle requires full JSON equality and exact canonical/cache byte agreement. No preexisting raw-byte assertion was removed. The cancellation/cold-copy and Claude paths retain exact bytes, and encoder raw-BLOB preservation is untouched.

### Bounded source audit

Graph lookup located the four relevant Codex tests at stale pre-edit offsets; source fallback was used because the graph was metadata-changed/watch-off. Audited current `runtime.rs:6526-7805` for `sqlite_backend`, `config_store`, `CredentialDb::initialize`, `CodexDisk::runtime` and `runtime_backend` constructions. The two Codex mismatches and one adjacent Claude mismatch above were the only same-pattern lock fixtures found in that bounded region. `CodexDisk::other_process` (`6598`) already shares the actual backend; the existing save-failure test (`6802`) already uses `runtime_backend` and was not edited. The constructor (`6603-6607`) is a bootstrap path, and the remaining opens are initial fixture setup or deliberate reopen/cold-copy checks. No unrelated runtime fixture or helper was replaced. This is not a whole-repository duplicate-owner audit or proof of lifecycle/competing-owner enforcement.

## Execution evidence

Private log root: **`/var/tmp/cook-router-codex-followup.nN4I3I`**. Commands use `CARGO_TARGET_DIR=/var/tmp/cook-router-snapshot-target`, `CARGO_BUILD_JOBS=2`, `TMPDIR=/var/tmp/cook-router-codex-followup.nN4I3I/tmp` and `nice -n 19` for cargo test/clippy. All credentials and upstreams are private fixtures/loopback mocks; the credential network guard remains intact.

### RED and intermediate evidence

- Existing actual RED for the original Codex test is `/var/tmp/cook-router-fixture-repair.bQqLce/regression-runtime__tests__sqlite_codex.log`: expected `siwc-ref-other`, observed `siwc-ref-refreshed`. It was read, not replayed or mislabeled as a historical baseline.
- `red-cancelled-reopen.log`: exact cancellation/reopen test compiled and failed **0 passed / 1 failed**, expected rotated token versus stale owner's A, before fixture migration.
- `green-runtime-codex.log`: first broad `--lib codex` run was **33 passed / 2 failed**. Full Codex adoption had succeeded, but the NEW input-order byte assertion failed under the existing normalization rule above. The second failure reproduced the unedited Claude duplicate-owner fixture (mock panic on an unwanted grant, then transport error). Supervisor approval preceded its migration.
- `intermediate-cold-copy-setup.log`: **34 passed / 1 failed** after adding the standalone-copy check. Its first draft placed the copy inside the workspace that the test deliberately deletes, so reopen initialized an empty database. Moving only the fixture copy outside that deleted directory corrected this setup mistake. No production issue was inferred or repaired.

### Final source-tree behavior executions

Every row below ran `cargo test -p cpa-server --locked --lib <filter> -- --nocapture` on the final Rust tree. Overlapping groups are not added into a unique-test count. `final-tests.status` records nine exit-zero results; no test was ignored, skipped or excluded to obtain green.

| Filter | Final result | Log |
| --- | --- | --- |
| `codex` (includes the adjacent `non_codex` fixture) | 35 passed / 0 failed | `final-codex.log` |
| `runtime::tests::a_cancelled_` | 3 / 0 | `final-cancelled.log` |
| `runtime::tests::a_lock_wait_stops_at_shutdown_even_when_the_lock_frees` | 1 / 0 | `final-lock-shutdown.log` |
| `runtime::tests::an_in_flight_refresh_does_not_overwrite_newer_credentials` | 1 / 0 | `final-inflight.log` |
| `runtime::tests::preparation_waiter_observes_deletion_and_refresh_loop_is_replaceable` | 1 / 0 | `final-preparation.log` |
| `credential_store` | 10 / 0 | `final-credential-store.log` |
| `owner_mutations_publish_current_memory_without_reloading` | 1 / 0 | `final-owner-memory.log` |
| `runtime::tests::failed_sqlite` | 1 / 0 | `final-runtime-save-fault.log` |
| `runtime::tests::cooldown_` | 2 / 0 | `final-runtime-normalization.log` |

The full Codex selection preserves rejection/replacement/version-moved fences, adopt-only discard, deletion/empty-document errors, cancellation and shutdown-grant settlement, and both save-failure/no-in-memory-fallback branches. The previous seven P1 tests were not replayed as a group: no shared helper changed. Their previous evidence remains above; this follow-up additionally reran the three runtime P1 cases through the final selections.

Final hygiene commands: `cargo clippy -p cpa-server --all-targets --locked -- -D warnings`, `cargo fmt --all --check`, and `git diff --check` passed (logs `clippy.log`, `fmt.log`, `diff-check.log`). HEAD remains `8a48b742`; the staged index is empty. The entry-state snapshots and `runtime-followup.diff` in the private log root separate these narrow edits from inherited uncommitted work.

## Residuals and handoff

No unresolved selected-test failure remains. Independent review still owns closure and task 2.2; only 2.1 is checked. This follow-up stops here, with no next slice started. Runtime/callback full ordering, pending-grant recovery and lifecycle ownership are not proved by these fixture repairs. No full workspace/nextest, harness, UI/notices, release/idle/performance, non-Linux runtime, power-loss or ACL gate was run. The known usage-record redirect measurement failure was not selected, hidden or repaired. No production code, live provider traffic, system installation, proxy/auth setting, commit, staging, stash, reset, merge, archive, push, deploy or model fallback was performed.

## Parent acceptance after independent P1 re-review

The preceding handoff's unchecked task status is superseded by this acceptance. Original reviewer run `b759c71e-1a3f-404c-b8c3-b0c9e963a64f` returned **APPROVED_FOR_SLICE — P1 closed**, with no remaining material finding in tasks 2.1/2.2 and their bounded fixture repairs. The review checked all seven original fault/normalization consumers, the destination-scoped test-only publication counter, and the three same-owner Codex/Claude fixture adaptations. Its report is `/home/xz/.pi/agent/sessions/--home-xz-Code-ai-cook-router--/subagent-artifacts/outputs/e4ece11a-4802-4f4b-9cb5-c979e7dca5ba/apply/02-atomic-images-review.b759c71e.md`.

The parent independently executed `runtime::tests::sqlite_` (6 passed), the exact normalization behavior (1 passed), host-save failure behavior (1 passed), and cancelled-grant cold recovery (1 passed). All selections exited zero with no failed or ignored tests; logs are `/var/tmp/cook-router-parent-fixture-closure-wths858m/`. The original failed host-save fixture had also been independently reproduced before repair at `/var/tmp/cook-router-parent-missed-fixture-qf3h7ohr/red.log`. These executions and the reviewer finding closure permit restoring task **2.2** to complete; only **2.1 and 2.2** are checked.

Acceptance is bounded to fresh complete-state encoding and checkpoint/published-image installation. It does not approve full storage/memory/runtime/callback ordering, in-flight pending-grant reconciliation, unresolved-pending shutdown retention, exclusive ownership, online CLI authority, removal of polling, final task 8.4, merge or deployment. Windows API/typechecking evidence is not a Windows runtime/ACL/crash-durability result; non-Linux and final workspace/resource gates remain unverified. The worktree still contains uncommitted implementation changes; an empty index does not mean a clean worktree.



## Task 2.3 — pre-edit bounded influence and oracle map

Source audit (current files, not graph): the shared `ConfigStore::writer/accept/persist` gate is reached by configuration `transact`, fixture seeding, credential legacy import/save/compare-patch/delete/adopt, and cooldown `Backend::save`. Pending retry currently installs memory without reconciling runtime. `Management::commit_with/commit_locked/edit_document` separately publish after storage; `reload_config/stored_config/publish/publish_upload` and `watching::reload` can republish configurations. Runtime has its own `publish_config[_and_policy]`, `subscribe_config`, plugin/catalog/policy/cooldown effects and refresh subscription. OAuth, SIWC, plugin save, upload/delete/field/status paths publish credential reconciliation after successful saves. Codex grant persistence precedes fenced runtime admission; it must not become a configuration event.

| Affected family | Entries / boundary classification | Observable oracle / final selection |
| --- | --- | --- |
| Complete-state commit / pending retry | config_store state, commit, published; all candidate domains | storage failure keeps old accepted view; retry dispatches retained configuration once; copied file and current view agree; complete config_store tests |
| Management configuration | admin CRUD/apply/import/restore, API-key toggles, plugin config through commit_with/edit_document | committed response, ETag, restart-required, runtime config/policy and notification agree; admin_contract + management integration and management lib modules |
| Configuration consumers | runtime publish/config subscriptions, plugin/catalog/access/logging/usage effects | service-originated publication, supplied immutable view/version, ordered delivery; runtime module + catalog_sources + subscriber port tests |
| Credential and grants | credential_store; runtime refresh/normalization/Codex admission; OAuth/SIWC/plugin/upload post-save reconciliation | no unrelated config event; preserve exact raw bytes, metadata, stale registration fences and failures; credential_store + runtime + management lib + watching + plugin_owned |
| Cooldown | credential_store Backend::save / cooldown_store Writer and runtime configure | common storage gate, no config event; volatile feedback stays asynchronous; cooldown_store + runtime |
| Watch/adapters | watching reload; Management reload/stored_config/publish_upload; OAuth/Vertex/SIWC/plugin callbacks | reconciliation cannot independently replace committed config; full watching, management lib, plugin_owned prerequisite and integration |
| Startup / fixtures / explicit ports | ConfigStore bootstrap/cold reopen, testing runtime[_with_db], Management registration; standalone Runtime/Home config input | bootstrap initializes without invented change events; atomic subscription initial view; existing fixture parity; full affected modules and catalog/body-limit publication ports |

CLI direct/offline ownership, external poller retirement, full in-flight grant recovery, shutdown retention and general task 6.x consumer migration remain future tasks, not waived completion criteria for this slice. Bootstrap/cold reopen and standalone Home Runtime configuration input are distinct from a bound online Management owner. No subscriber may synchronously mutate the active service; reads and queued owned follow-up are allowed.

Private command/evidence root: `/var/tmp/cook-router-ordered-commit.3brtcpe9`; entry status/diff saved before edits. Task 2.3 remains unchecked until implemented and affected selections pass. Only task 2.1/2.2 were checked at entry.


### Task 2.3 — complete volatile-port classification and initial binding

Full current-source scan classified every `publish_config[_and_policy]` call. Bound callers were `request_logging` (three capture/reload cases), `tests/body_limit_go` (two body-limit reload cases), and `tests/management` (remote-management toggle); these now issue commands to their original fixture authority. Runtime/Home, pprof, safe_mode, model_router, catalog_sources and aistudio_relay ports are unbound and keep their standalone behavior. The production Management caller is replaced by a crate-private service-only install adapter. Supervisor explicitly approved bound public volatile-port refusal: false and no effects, race-safe against binding; no derived Config is serialized into production canonical state.

The initial-view audit also found empty second fixture authorities in request_logging, websocket capture (four sites), realtime capture, management observability, alloc_budget and Claude capture. These non-plugin fixtures now explicitly seed canonical documents rather than bind an empty owner over a nonempty Runtime. The two tests that changed derived API-key fields now also declare the same key in their fixture YAML. Initial typed subscription delivery does not re-register already-bootstrapped credentials; only committed changes run the existing credential reconciliation. This preserves plugin refresh deadlines and runtime-only mock credentials at startup.

RED: `red-behavior.log` compiled and failed the public command test because a direct service import returned fill-first while Runtime remained round-robin (1 failed, no ignored). Initial test-authoring compile errors remain in `red.log`; they are not behavioral RED evidence. `ordered-green2.log` then passed all nine new behavioral tests (zero failed/ignored), covering actual bound runtime publication, domain filtering, invalid/stale/dry-run no effects, all four checkpoint/final-before/after-replacement faults, retained retry once, readers during blocked storage, subscriber errors/read reentry/self-unsubscription/owned follow-up, registration races, bound refusal/unbound retention, binding/publication race, and isolated checkpoint resume initial delivery. The per-destination one-shot storage-effect helpers are cfg(test)-only and exercise actual commands/artifacts.

The complete intermediate library run (`lib-intermediate.log`) was 537 passed/8 failed/0 ignored. Six failures exposed incorrect initial credential reconciliation and were addressed by distinguishing Initial from Committed delivery, not by weakening assertions. The known usage-record redirect baseline failed again. `a_late_refusal_never_blocks_a_reimported_credential` also raced private-directory deletion with its live cooldown writer after selection; its fixture now drops the Runtime owner before cleanup. This is fixture stop-before-delete, not task 3.x lifecycle redesign. Final-tree reruns follow below; no intermediate failure is relabeled as green.


### Production Home authority correction (source-backed, approved)

The earlier shorthand “standalone Home is unbound” omitted an important production sequence: `main.rs:1531` constructs a Management wrapper even for Home, then `home.rs:909` publishes remote Home configuration. Supervisor approved preserving the existing immutable `CredentialAuthority::Home` boundary: BOTH local binding and local initial-view registration now occur only when `!rt.store().is_home()`. This is not a mutable bypass flag and grants no volatile-write exception in local persistent mode. No remote config is projected into SQLite. The long-lived state contract and design now state this existing mutually exclusive remote authority precisely. Added a port example with a Home runtime, disabled Management wrapper and conflicting local store: initial state remains remote, remote publication updates policy/notifies, and later local commands do not publish into Home. Existing mock Home configuration/plugin-finalization/usage/lifetime tests are included in final selection.

The first integration aggregate stopped after admin_contract 14 passed/1 failed: the uninitialized-destination fixture deleted its configured management secret and relied on the old split runtime retaining it. That is no longer a legitimate fixture. Its revision-0 precondition examples now use a separate fixture with the existing explicit environment-secret option, so clearing canonical resources does not remove independent startup authorization; all original 428/412 oracles remain. The original fixture's configured-secret behavior is unchanged.

The first final library run was 551 passed/2 failed/0 ignored. The additional stale-scan failure is **not** DirectoryNotEmpty (initial progress shorthand was corrected by inspecting the full log): its `current()` credential became absent after a scan. Source diagnosis identifies shared process plugin-parser activity causing uncached saved bytes to be Deferred in a built-in-only fixture that passes only credentials/read into reconciliation. A deterministic existing thread-parser port reproduction is being run; any repair remains test-only and preserves stale-write/delete/cache-vs-canonical assertions. No production parser/reconciliation semantic change is authorized or made.


## Task 2.3 PAUSED / BLOCKED — unsafe lock-order candidate, not accepted

**Do not use this candidate as a completed 2.3 implementation.** Final manual lock review found a production cycle; supervisor explicitly stopped new implementation, diagnosis and test launches pending an approved bounded dependency direction. Task `2.3` at `tasks.md:12` remains unchecked. Only 2.1/2.2 are checked (2/33); no task 4.x, 6.1 or other task was checked. All edits remain uncommitted and the staged index is empty.

### Exact blocker

- Config command: `ConfigStore::transact` retains the guard returned by `writer`; `state.rs:159` accept -> persist returns/operation closes -> `install_accepted:179` -> `notifications.rs:144` dispatch (still under the owner writer) -> `Management::accept_configuration:336` -> credential `publish/publish_upload:420` -> `CredentialStore::reconcile_scanned_with`, `runtime.rs:3411/3418`, requests `reload.write()`.
- Opposite order: `CredentialStore::write_unlocked`, `runtime.rs:3074`, takes `reload.read()` or the identity-changing `reload.write()` at 3090/3092 and retains that guard plus the per-ID lock through preparation/save and runtime publication. `save_document:1937` -> `CredentialDb::save_checked:168/170` requests the service writer. `commit_file_backed` also saves inside its prepare closure under the same reload guard. Thus config owner -> reload conflicts with credential reload -> owner.
- Pending retry self-cycle: after failed publication of a configuration candidate, a credential patch enters `write_unlocked` and owns reload; its save obtains `ConfigStore::writer`, which reconciles the pending config at `state.rs:148–153` by synchronously invoking the required adapter, which requests that same reload lock exclusively. No second thread is needed.

This cannot be fixed by omitting immediate config-derived credentials, releasing callbacks outside the serialized logical boundary, blanket reentrant mutexes or weakening admission fences. Parent owns the necessary dependency/scope decision. Candidate callback scaffolding is not sufficient completion.

Affected credential family entry points for a bounded next direction: public `apply_patch` / `apply_refresh -> apply_patch_with` (Management fields/status and request/background/forced/plugin refresh), public `replace_file_backed/commit_file_backed` including identity changes, result normalization `persist_credential:2271/2299`, and Codex `admit_codex_refresh:2852/2867 -> save_codex_refresh:4095`. `restore_refresh_document:1947/2014` uses the same guarded adoption primitive without a save itself. Preserve stable document locks and relevant credential revision/registration/version checks. The external Codex `refresh_locked.await` at 4021 remains outside owner admission; required grant persistence at 4043 remains separate from subsequent fenced runtime admission. Full pending-grant merge/admission and shutdown retention remain 2.5/3.x, not accidentally completed here.

Proposed regression shape for the parent (not implemented/executed after pause): one private same-owner fixture, public config edit and credential patch on owned threads, existing validation/write/storage barriers and bounded completion channels. Hold a config candidate at its public edit/effect port, start a credential patch, coordinate the established pre-save barrier without requiring one lock acquisition order, release both, require both results plus correct current config/token and ordered domain events; no sleeps/serial-test flag. Separately checkpoint a config, fail final publication, restore destination, then issue one public credential patch; require pending configuration reconciliation and patch completion once with no false credential/config event. The current second scenario is a direct self-deadlock by the guard lifetimes above. An isolated RED execution must bound the known-deadlocked worker rather than hang the aggregate suite; after repair join all normal workers.

### Settled final executions (nothing newly launched after supervisor pause)

All Rust commands used `TMPDIR=/var/tmp/cook-router-ordered-commit.3brtcpe9/tmp`, `CARGO_TARGET_DIR=/var/tmp/cook-router-snapshot-target`, `CARGO_BUILD_JOBS=2`, and `nice -n 19`.

| Command selection | Actual result | Log |
| --- | --- | --- |
| `cargo test -p cpa-server --locked --lib` | **553 passed / 2 failed / 0 ignored**; new 11 ordered-service port tests passed, but stale-scan fixture still fails `current().unwrap(None)` and known usage-record redirect baseline fails | `lib-final2.log` |
| `cargo test -p cpa-server --locked --test admin_contract -- --nocapture` | 15 passed / 0 failed / 0 ignored | `integration-admin_contract.log` |
| same command, `--test management` | 54 / 0 / 0 | `integration-management.log` |
| same command, `--test plugin_owned` | **56 / 1 / 0**; `a_host_config_change_reparses_the_auth_files`, line 2055: “the plugin was never asked with the new host config” | `integration-plugin_owned.log` |
| same command, `--test catalog_sources` | 2 / 0 / 0 | `integration-catalog_sources.log` |
| same command, `--test body_limit_go` | 3 / 0 / 0 | `integration-body_limit_go.log` |
| same command, `--test claude_passthrough` | 7 / 0 / 0 | `integration-claude_passthrough.log` |
| same command, `--test alloc_budget` | 1 / 0 / 0; no new savings claim | `integration-alloc_budget.log` |
| `cargo test -p cook-router --locked --bin cook-router home::tests:: -- --nocapture` | 83 / 0 / 0 (98 outside-filter); mock remote config/plugin/usage/lifetime tests executed | `home-final.log` |

No prerequisite skip output was present in the plugin-owned execution. Selections overlap with the library; no aggregate unique count is claimed. Full library is **not green**, and plugin-owned is **not green**.

The deterministic existing thread-parser stale-scan reproduction failed in `stale-scan-parser-red.log`; adding preparse under that isolated parser did **not** fix `lib-final2.log`. This fixture repair remains incomplete and is not a proven closed root cause. No further diagnosis or edits were made after pause. The earlier late-refusal cleanup fixture now drops its owner before deleting the private workspace and passed in final library execution.

`cargo fmt --all` passed in `fmt-apply3.log` before these final executions. Earlier `git diff --check` passed, but no final fmt-check or focused clippy was launched after the blocking lock audit; neither is claimed passed. Full workspace/nextest, harness, UI/notices, release/idle/resource/platform runtime/crash/ACL gates remain unrun. No commit/staging/push/stash/reset/merge/archive/deploy/system install/live provider traffic/proxy/auth/model-fallback operation occurred. Existing native plugin test prerequisites ran, not live provider logins. Parent must resolve the lock-order dependency and residual tests before resuming implementation or acceptance.


## Command protocol dependency repair — pre-edit complete guard audit

Scope: repair owner admission/required-projection success only; task 2.3 and all 4.x/6.x remain unchecked. Using change `centralize-configuration-service`, spec-driven, ready 2/33. The supplied three behavioral examples are the acceptance contract for this bounded repair.

| Entry | Existing guards / effect / relevant fence | Required repair and behavioral coverage |
|---|---|---|
| Public apply_patch / request, forced, background and plugin apply_refresh | refresh currently holds unauthorized, then write_unlocked takes reload shared, per-ID, reads inner, saves through owner; registration and revision checked under reload | Admit owner before unauthorized/reload; reuse explicit credential command for persistence; overlap + pending-recovery + runtime refresh suites |
| replace_file_backed / commit_file_backed | write_unlocked shared or identity-exclusive reload -> per-ID -> conditional backend.save; inner publication after I/O; exact disk hash | Same command context in prepare; preserve exclusive identity, disk hash and revision checks; management patch/status/identity suites |
| coalesced persist_credential | prepare lock -> stable document lock -> backend.restore -> read source -> write_unlocked -> save | Stable document remains outside owner (projection does not acquire document/prepare locks); owner before reload; preserve SHA/revision checks; normalization tests |
| admit_codex_refresh / save_codex_refresh | stable document held, unauthorized -> reload -> backend.save -> owner; partition CanApplyTo and registered credential version | Owner before unauthorized/reload, shared persistence context; Codex owner/refresh tests |
| restore_refresh_document adoption | stable document -> backend.restore(owner), parser outside owner (may host.auth.save), read/hash verification, write_unlocked adoption | Read/hash must be rechecked after owner admission before adoption; no owner held across parser/network; adoption and owner fixtures |
| granted Codex checkpoint | document lock retained across network grant, then source read/save through owner, then conditional runtime admission | Network remains outside owner; required nonrepeatable checkpoint derives current bytes under owner separately from admission/cancellation; owner fixtures and grant counts |
| CredentialDb restore/save_checked/write_files/import/cooldown Backend.save | owner -> immutable accepted candidate -> materialization/persistence; error restore reacquires owner only after prior guard drops | Add explicit reusable command for runtime saves; error cache restoration must use same admission and not recurse |
| Config commit / pending recovery / required Management adapter | owner -> canonical swap -> runtime config/policy -> credential scan (cached plugin answers only) -> reload exclusive -> inner; no Management.disk | Required failure must retain versioned projection retry and withhold ordinary events; failed projection regression |
| Runtime reconcile/replace_config/upsert, policy/cooldown adapters | reload -> inner/scheduler; drop inner before session/cooldown effects; persistence uses nonblocking cooldown Writer queue, backend.load is accepted-memory only | No synchronous owner reacquisition from installer: cooldown Writer.save queues, never waits; retain this separation |
| Management disk adapters / plugin OAuth / auth upload / watching | disk -> owner for writes then publish/reload; preparse runs outside disk/owner; service required adapter never takes disk; plugin cache scan does not invoke parser | Owner-before-reload closes disk interaction; complete management/plugin/watch tests; no callback/state/list lock across I/O |

No second authority, actor, reentrant mutex, ambient SQL reread or weakened fence is planned. Ordinary callbacks remain isolated; required callbacks are a fallible success boundary with retained post-durability recovery, not rollback. Registration must remove an installer when initial installation fails.


## Command protocol dependency repair — final candidate: PARTIAL

A/B implementations and focused checks are present, but affected aggregate validation remains red. No `PROTOCOL_REPAIR_COMPLETE` or task 2.3 acceptance is claimed. Only 2.1/2.2 remain checked (ready 2/33). Parent owns independent review and classification of remaining failures.

## Implemented

### A. One admitted command, before reload and per-ID guards

`CredentialDb::command` now returns an explicit `CredentialCommand` holding the existing `ConfigStore` writer admission. It is not a second owner, cache, actor, scheduler or reentrant mutex. Runtime persistence reuses this context instead of recursively obtaining `ConfigStore::writer`.

The resulting ordering is:

1. Existing stable document/preparation locks or Management `disk`, where the caller already requires them.
2. The same service owner, including completion of retained configuration recovery.
3. Runtime reload shared/exclusive gate, then the per-ID gate.
4. Short-lived inner/provenance/scheduler/unauthorized memory locks for checks or publication, never retained across provider callbacks or filesystem persistence.

Required configuration projections never obtain stable document/preparation locks or Management `disk`. Thus document -> owner and disk -> owner do not create the inverse leg. Their reload request now meets credential commands that have already admitted the owner, not commands holding reload while waiting for it.

Covered families:

| Entry | Admission / effect / relevant fence |
|---|---|
| Public patch, request/background/forced/plugin refresh | `apply_patch_with` / `apply_refresh` -> admitted helper -> reload/per-ID -> candidate from current Runtime credential -> context save -> inner publication. Registration and credential revision are checked after admission. |
| File replacement and identity-changing management save | Same context enters prepare; exclusive reload for identity changes remains. Accepted source-hash CAS and expected runtime revision remain. |
| Coalesced normalization | Stable document try-lock and restoration remain; admitted writer derives the normalization candidate and checks provenance/source before persistence. Publication-count, raw-byte and once-per-revision oracles remain. |
| Codex runtime admission | Owner admission precedes the reload gate. Registration, relevant credential version and partition `CanApplyTo` decisions remain. `save_codex_refresh` uses the admitted context. |
| Refresh-document adoption | Parser work remains outside admission; the source document is checked again inside admission before adoption, in addition to the existing revision/registration checks. |
| Non-repeatable granted Codex checkpoint | Network grant wait remains outside admission. After the grant, the required checkpoint derives bytes from the current admitted document and persists before the separate conditional runtime admission. These are not collapsed into one cancellable conditional save. |
| Other backend commands | `restore`, `write_files`, import and cooldown backend writes still enter the same owner. Runtime projection cooldown persistence queues through the existing nonblocking cooldown Writer; its accepted-memory load does not synchronously acquire the owner. |

The former unauthorized memory lock across refresh I/O was removed. Production rotation comparators are pure candidate comparisons, run without memory locks; the rotation timestamp is recorded with final inner publication so a visible new revision does not precede its rotation marker. No network grant runs inside admission.

Failed credential cache repair uses the same admitted context and accepted state, rather than recursively calling `restore`. Existing exact raw documents, opaque fields, CAS, IDs/order, history and cooldown encoding were not changed.

### B. Required projection is part of success

Required and ordinary callbacks now have different outcomes:

- Required error or panic propagates as command failure. Ordinary callbacks do not run until every required projection completes.
- Post-durability failure is **not rollback**. The retained pending value contains the candidate **and the original versioned configuration event**. Canonical memory may already have advanced. A subsequent writer must finish the retained projection before admitting a new mutation; it cannot recompute no-change from that advanced pointer and discard the event.
- Retry repeats trusted required installation, then delivers the retained ordinary event once. Ordinary subscriber error/panic remains isolated and cannot undo durability or prevent later ordinary subscribers.
- Runtime configuration-watch success notification is also ordinary. Management retains a pending notification flag across required retries, so a later failing required adapter cannot cause a false Runtime success notification or a lost notification on retry.
- Management registers its required installer and ordinary notifier atomically under one admission. The callbacks capture Weak ownership; handles unregister on owner drop. Failed initial registration removes its handle, and an initially unbound Runtime's binding unwinds on failed initial installation.
- A trusted Runtime install returning false now triggers required failure instead of being ignored and acknowledged.

No required callback receives canonical credential BLOBs, history or cooldown state. The existing configuration-only authorized view remains the callback input.

## Tests first and exact REDs

All three requested behavior regressions were added before production changes, using a private same-owner fixture, public service/credential commands, callback observations and destination-scoped storage-effect barriers. No sleep or old-private-lock-order assertion was added.

| New behavior | Actual RED | Frozen final result |
|---|---|---|
| Config commit overlaps public credential patch; bounded completion and coherent config/policy/token/event | Completion receiver timed out; isolated exact test failed | Passed |
| Failed final config publication, destination restored, public credential patch recovers pending config without self-deadlock | Isolated exact process timed out, exit 124 after 20 seconds; process tree terminated and locks released | Passed; once-only config event, no credential-to-config event, cold-copy checks retained |
| Required projection failure cannot acknowledge; ordinary error/panic isolation | Failed the false-ack assertion | Passed for required Err and panic, mutation refusal while unresolved, Runtime notification withholding, cold durable copy before retry, once-only event, and failed initial registration/binding cleanup |

Logs: `red-overlap.log`, `red-pending.log`, `red-required.log`. Passing overlap workers are explicitly joined. The self-deadlock RED ran in a bounded private test process, not a detached background writer.

Two directly protocol-dependent fixtures were migrated without removing their meaningful oracles:

- Runtime stalled-write fixture now expects another durable command to queue at the shared owner, while reads and selection still complete. Reload/same-credential exclusion and final bytes/revisions remain checked.
- Plugin schedule fixture no longer recursively persists or reloads from the rotation comparator. Its explicit source writes run outside the admitted callback; schedule-with-commit, later enabling reload reset, stale-registration refusal and final token assertions remain.

## Frozen final-tree validation

**Authoritative final logs have the `settled-` prefix** in:

`/var/tmp/cook-router-command-protocol.GQwu59`

`settled.status` contains command exit codes. All Cargo commands used `CARGO_TARGET_DIR=/var/tmp/cook-router-snapshot-target`, `CARGO_BUILD_JOBS=2`, `nice -n 19` and private `TMPDIR=/var/tmp/cook-router-command-protocol.GQwu59/tmp`. No serial-test flag, ignored test, raised budget or retry-until-green loop was used. Counts overlap and must not be summed as unique coverage.

| Final command/selection | Result |
|---|---|
| `cargo fmt --all --check` | Passed |
| `cargo clippy -p cpa-server --all-targets --locked -- -D warnings` | Passed |
| `cargo test -p cpa-server --locked --lib -- --nocapture` | **554 passed / 4 failed / 0 ignored** |
| Ordered configuration module | **14 passed / 0 failed / 0 ignored**, including all three new behaviors |
| `--test admin_contract` | 15 / 0 / 0 |
| `--test management` | 54 / 0 / 0 |
| `--test plugin_owned` | **55 / 2 / 0** |
| `--test catalog_sources` | 2 / 0 / 0 |
| `--test body_limit_go` | 3 / 0 / 0 |
| `--test claude_passthrough` | 7 / 0 / 0 |
| `--test alloc_budget` | 1 / 0 / 0; no new performance claim |
| Seven prescribed fault fixtures, each exact selection | Each **1 passed / 0 failed / 0 ignored** |
| Three prescribed same-owner Codex/Claude fixtures, each exact selection | Each **1 passed / 0 failed / 0 ignored** |
| `cargo test -p cook-router --locked --bin cook-router home::tests:: -- --nocapture` | **83 / 0 / 0**, 98 outside filter |
| `git diff --check` | Passed; staged index empty |

The exact seven fault selections were:

1. `management::auth_files::tests::failed_sqlite_upload_never_publishes_or_reports_success`
2. `runtime::tests::failed_sqlite_saves_never_publish_patches_equal_file_commits_or_normalization`
3. `runtime::tests::sqlite_codex_save_failures_never_publish_an_in_memory_fallback`
4. `management::plugin_auth::tests::written_saves_are_durable_and_sql_failures_do_not_publish`
5. `management::plugin_oauth::tests::sqlite_batch_restores_every_file_on_later_record_or_sql_failure`
6. `runtime::tests::cooldown_credential_normalization_leaves_async_worker_and_runs_once_per_revision`
7. Integration `plugin_owned::a_plugin_refresh_that_cannot_be_saved_backs_off`

The three exact owner fixtures were:

- `runtime::tests::sqlite_codex_refresh_restores_newer_accepted_tokens_under_the_document_lock`
- `runtime::tests::a_cancelled_codex_grant_survives_sqlite_reopen_without_working_files`
- `runtime::tests::sqlite_refresh_waits_for_non_codex_document_lock_and_adopts_newer_accepted_tokens`

Each lib exact command used `cargo test -p cpa-server --locked --lib <qualified-name> -- --exact --nocapture`; the integration fault used `--test plugin_owned <name> -- --exact --nocapture`. The plugin fault executed its actual native-recorder path and three-second backoff observation (5.41 seconds total), with no missing-prerequisite skip output. Whole plugin runs also executed real recorder-backed assertions rather than silently skipping the environment.

### Remaining final failures — not approved exceptions

Library (`settled-lib.log`):

- Known `runtime::tests::a_stale_scan_cannot_undo_a_later_write`: `runtime.rs:5558`, missing `synthetic.json` lookup.
- Known historical `usage_record::tests::redirects_start_the_upload_measurements_over`: upload-measurement assertion; not investigated or repaired.
- `runtime::tests::an_invalid_grant_after_a_401_blocks_the_credential_until_its_tokens_change`: `runtime.rs:8561`, None lookup.
- `runtime::tests::a_late_refusal_never_blocks_a_reimported_credential`: `runtime.rs:8721`, DirectoryNotEmpty at teardown.

Plugin integration (`settled-integration-plugin_owned.log`):

- Known `a_host_config_change_reparses_the_auth_files`: `plugin_owned.rs:2055`, plugin never asked with new host config.
- `a_401_from_a_plugin_executor_refreshes_through_its_auth_provider`: `plugin_owned.rs:3538`, model provider unavailable; HTTP 400 instead of 200.

The additional failures are **not proven baselines**, not accepted exclusions and not repaired here. Earlier complete runs also exposed variable missing-credential/selection failures, a concurrent-multiowner revision loss, a mock grant-start timeout and a catalog registration failure. Their full logs remain. Five one-shot exact diagnostics for the earlier additional runtime failures passed individually; that does not erase their aggregate failures or prove their cause. No parser, owner-exclusion, general cleanup or unrelated measurement repair was absorbed into this task.

The first aggregate run was explicitly stopped after confirming two obsolete fixture deadlocks; it is not a completed/passing run. The directly affected fixtures were then corrected as described above. Intermediate compile/clippy errors were fixed; earlier aggregate generations and the integration compile failure that overlapped a source edit are superseded by the frozen `settled-*` execution, not represented as final evidence.

## Changed paths in this worker's delta

- `crates/cpa-server/src/config_store.rs`
- `crates/cpa-server/src/config_store/state.rs`
- `crates/cpa-server/src/config_store/published.rs`
- `crates/cpa-server/src/config_store/notifications.rs`
- `crates/cpa-server/src/credential_store.rs`
- `crates/cpa-server/src/runtime.rs`
- `crates/cpa-server/src/management.rs`
- `crates/cpa-server/src/plugins/refresh.rs` (test fixture only)
- `crates/cpa-server/src/config_store/tests/ordered.rs`
- `docs/STATE-AND-CONCURRENCY.md`
- `openspec/changes/centralize-configuration-service/verification.md`

Do not attribute the full inherited dirty tree to this worker. Entry tracked diff/status are `entry.diff` and `entry.status`; the user's prior snapshot and the current worktree remain intact. Accepted encoder and private fault-fixture foundations were preserved.

## Residual scope and next step

**Return status: PARTIAL.** The concrete A/B repairs and their focused checks are present, but the remaining affected failures are unclassified blockers to attesting the complete bounded repair, not permission to mark 2.3 complete. Parent should independently review the owner-context/guard order and retained required-projection retry, then classify and repair the remaining failures before accepting this candidate.

Unchanged future work includes unresolved pending shutdown retention/cleanup, exclusive owner exclusion, complete pending in-flight-grant merge/new-grant pausing, broader dispatch withholding, CLI migration, poller retirement and remaining callback/lifecycle work. Full workspace/nextest, harness, UI/notices, release/idle/resource, non-Linux runtime/ACL and crash/power-loss evidence remain unverified. No deployment, release or whole-change approval is requested or implied.

All started command wrappers settled; no background test/build writer remains. No system installation, model/tool/auth fallback, live credential/provider traffic or proxy configuration operation was performed.



## Bounded protocol and fixture repair — 2026-11-10 final source

**REPAIR_COMPLETE for the three reviewed protocol findings and the five assigned fixture causes; not task 2.3 or whole-change acceptance.** Only 2.1/2.2 remain checked (ready, 2/33). The final ordinary library run is still **red** on the expressly out-of-scope usage measurement test. Earlier unrelated intermittent failures remain reported below, not declared baselines or fixed by an isolated pass.

### Ownership / destructor / original-event closure

- `config_store/state.rs::Writer` wraps the existing owner mutex, not a new owner or queue. Management's installer and ordinary notifier retain dispatch-upgraded component Arcs through that admission. On every exit, including failed pending recovery and failed initial registration, Writer first extracts its pins under the short pin lock, releases that lock, releases owner admission, and only then destroys pins. A last Management/Runtime/CredentialStore can therefore join a same-owner cooldown worker after admission is available. Both callbacks still capture Weak ownership, so no persistent callback -> Management -> ConfigStore cycle was added. CredentialCommand carries this same Writer. Network grants, document/disk -> owner -> reload/per-ID ordering and source/version/registration fences are unchanged.
- Subscription Drop extracts the removed callback under the list mutex and destroys captures after unlocking. Required/ordinary registrations share this cleanup; initial Err/panic unwinds the handle through it. Dispatch clones outside invocation locks; fresh registration IDs do not replace/destroy prior callbacks under the insertion lock. The destination-scoped effect guard also removes before destroying its captures.
- Management tracks the original event revision/digest, original transition input and completion, independently of Runtime.config equality. It marks completion only after Runtime-derived effects and credential reconciliation return. Incomplete attempts replay; completed adapters are not repeated merely because a later required installer failed. Runtime receives the retained original predecessor so transition-sensitive tail effects do not infer their predecessor from a partly advanced pointer. The existing unchanged-initial access/logging/usage condition is preserved using that original input. Ordinary Runtime watch intent survives retries and is consumed once only after all required installers succeed, alongside the original configuration event. Durability and canonical advancement are not rolled back.

### Permanent regressions and preserved fixture oracles

| Cause / transition | Permanent test seam and behavior |
| --- | --- |
| P1A last callback-owned component | `ordered::last_management_pin_outlives_admission_and_joins_same_owner_cooldown`: the backend signals before saving through the same owner; the required-install hook waits while the last external Management/Runtime references are dropped. Success, later required Err and in-adapter panic variants all finish; worker/backend teardown is observed and the Runtime Weak no longer upgrades. `dispatch_pins_unlock_before_error_panic_and_failed_registration_cleanup` additionally checks owner-unlocked destruction for Err/panic on initial registration and committed dispatch. |
| P1B nested capture destruction | `ordered::destroying_callback_captures_unsubscribes_without_the_list_lock`: B captures A's subscription; B is destroyed outside invocation, then C registers, receives initial state and a later committed version. No sleeps or process-global subscriber were added. |
| P2 interrupted adapter | `ordered::management_retries_an_interrupted_projection_before_success_notifications`: one-shot panic at existing BEFORE_RECONCILE and at the destination-scoped Runtime-derived tail (after pointer swap); no Runtime/config success event on failure, recovery by a public credential save, complete config/policy/config-derived credential projection, original event once and no repeat on a later credential command. The pre-existing later-independent-installer failure test still passes. |
| Stale scan setup | `runtime::a_stale_scan_cannot_undo_a_later_write` now prepares the first built-in scan before list-derived seeding. Original later-patch/no-revision-churn, canonical saved bytes surviving corrupt cache, and deleted-snapshot refusal assertions remain. |
| Initial Claude credential / reload preparation | Runtime built-in source loads and private canonical scans explicitly prepare and consume within a synchronous thread parser scope, never across await/spawn. `testing::builtin_preparation_is_explicit_and_preserves_the_enclosing_parser_context` verifies fresh cache deferral, prepared built-in loading, and restoration of nested enclosing answers. `runtime::a_private_codex_backend_prepares_its_canonical_documents_before_registration` also covers raw canonical documents under an unrelated suppressing parser, including CodexDisk's shared constructor and sibling canonical-scan fixtures. The exact invalid_grant test retains two concurrent 401s -> one grant, all blocking paths, reimport registration and actual token-change unblocking. The real native lib refresh fixture now explicitly drains/shuts down its host. No production global parser/cache invalidation was changed. |
| Late refusal cleanup | The exact late-refusal test calls existing `shutdown_codex_refreshes` before deletion (it also drains Claude normalization). Original gated refusal, same-token reimport, one grant, fresh registration and final successful selection remain. `ordered::explicit_shutdown_drains_normalization_queued_behind_the_owner_before_cleanup` queues a selected lease's normalizer behind an owner-held public subscriber barrier, polls shutdown to prove it cannot complete, releases/joins the command, waits for shutdown, verifies normalized bytes, and verifies no surviving store/directory after deletion. No ignored removal error, test sleep or retry cleanup was added. |
| Native host config reparse | Env retains one Arc<ConfigStore> for CredentialDb, Runtime and all Management consumers. `a_host_config_change_reparses_the_auth_files` commits through that live owner, checks accepted revision/Runtime proxy, increased real auth.parse calls with the new Host.ProxyURL, and unchanged auth bytes. No competing opener or external-file adoption remains in this fixture. |
| Native 401/bootstrap/lifetime | Env performs explicit provisional built-in loading before native startup; intentional pre-bootstrap tests still explicitly request startup reload themselves. Its proxy, plugin worker and watchers have an owned private Tokio executor. Owned tasks are aborted and awaited, refresh preparation/tracked persistence is drained, plugins shut down, and the executor joined before deletion/releasing the existing fixture guard. Drop uses a joined scoped cleanup thread (with block_in_place for a multithread caller), not detached cleanup. The exact 401 test still asserts one auth.refresh, two executor.execute calls, old/new request metadata and omitted-key retention. New multi-thread and current-thread failed-native-fixture tests deliberately panic a first active native fixture, observe closed proxy/deleted workspace/dead Runtime Weak, then require a second initial credential and the same complete 401/refresh/retry/merged-document oracle. |

### Actual RED and intermediate evidence

Raw private evidence: `/var/tmp/cook-router-protocol-fixture-repair`. Entry tracked diff/status are `entry.diff` / `entry.status`; the inherited dirty/untracked candidate was preserved.

- `red-destroying_callback_captures_unsubscribes_without_the_list_lock.log` and `red-last_management_pin_outlives_admission_and_joins_same_owner_cooldown.log`: confirmed deadlocks, bounded test processes ended through the timeout wrapper's SIGALRM path (exit 124); no blocked test process was left alive.
- `red-mid-corrected.log`: after the injected in-Management panic, public credential recovery loses Runtime success notification (exit 101). An initial test-port attempt incorrectly expected repeated API-key YAML import to be a no-op despite newly allocated resource identities; it was corrected to recover through a public credential save before the meaningful notification RED. No production criterion was weakened.
- `red-canonical-preparation.log`: deterministic missing canonical Codex credential under a fresh unrelated scoped parser (exit 101). `green-canonical-preparation-corrected.log`: 1 passed after preparing the shared canonical scan helper. The first GREEN compile needed two ordinary Arc borrows corrected; that failed compile remains in `green-canonical-preparation.log`.
- Initial joined Drop cleanup attempted to await an aborted proxy task on the failing caller executor and deadlocked in the new panic control (`native-a_failed_native_fixture_joins_before_the_next_fixture_bootstraps.log`, exit 124). Giving fixture-owned background work its own joined executor closes that failure; both runtime-flavor controls pass. A diagnostic gdb attachment was denied by existing ptrace policy; no policy/system change was made.
- Intermediate native YAML accessor compile mismatch and unused import/assertion variables were corrected. First Home build exposed a new testing helper referencing cpa-core's dev-only test-support symbol in a non-test library build; the helper is now unit-test-only, and the integration fixture uses its own existing dev-feature scope. No dependency/feature/lock changes were introduced by this repair. Final Home executes all 83 tests.
- First frozen generation (`final-*`, before the canonical-scan closure and preservation of unchanged initial access/logging/usage behavior): lib 560 passed / 4 failed; plugin_owned 59 / 0. The four lib failures were canonical Codex setup (repaired above), usage timing, concurrent_open revision loss (14 vs 16), and model-updater missing expected refresh log. The latter two are **not repaired or proven baselines**: they pass in the final ordinary generation, but their earlier failures remain unresolved intermittent risks. The multi-opener fixture exercises incomplete future owner-exclusion work; no exclusive-owner redesign or unrelated model/usage repair was absorbed.

### Authoritative frozen final validation

**`settled-*` is authoritative**, not `final-*` or earlier focused generations. All 513 Rust source file hashes stayed unchanged through these runs (`settled-source.sha256`, `settled-source-check.log`, all OK). Raw command argv and exits are `settled.commands` and `settled.status`; every command completed. All Cargo commands used:

```sh
TMPDIR=/var/tmp/cook-router-protocol-fixture-repair/tmp \
CARGO_TARGET_DIR=/var/tmp/cook-router-snapshot-target CARGO_BUILD_JOBS=2 \
timeout <bounded-duration> nice -n 19 cargo <arguments below>
```

| Command / selection | Actual result |
| --- | --- |
| `test -p cpa-server --locked --lib -- --nocapture` | **564 passed / 1 failed / 0 ignored**; only `usage_record::tests::redirects_start_the_upload_measurements_over` failed. This is red, not a green library gate. |
| `test -p cpa-server --locked --test plugin_owned -- --nocapture` | **59 / 0 / 0**, ordinary parallel full target, real native recorder assertions, including both sequential failed-fixture controls. |
| `test -p cpa-server --locked --lib config_store::tests::ordered:: -- --nocapture` | **19 / 0 / 0** (original 14 plus five regressions); covers overlap/reload, pending recovery, required failure, registration and Home wrapper. |
| Five original exact failures (three lib + two native integration) | Each **1 / 0 / 0**, same final source and full original behavior assertions. |
| Seven exact fault fixtures (six lib + native plugin save backoff) | Each **1 / 0 / 0**; native backoff prerequisite executed. |
| Three exact owner Codex/Claude fixtures | Each **1 / 0 / 0**. |
| Integration targets `admin_contract`, `management`, `catalog_sources`, `body_limit_go`, `claude_passthrough`, `alloc_budget` | Respectively **15, 54, 2, 3, 7, 1** passed; no failure/ignore. |
| `test -p cpa-server --locked --lib request_logging:: -- --nocapture` | **17 / 0 / 0**. |
| `test -p cook-router --locked --bin cook-router home::tests:: -- --nocapture` | **83 / 0 / 0**, 98 outside filter. |
| `cargo fmt --all --check`; `cargo clippy -p cpa-server --all-targets --locked -- -D warnings`; `git diff --check` | All passed. |

Selections overlap; do not sum them as unique coverage. No serial-test flag, missing-native-prerequisite skip, ignored test, plugin disable, global parser reset, raised budget or retry-until-green loop was used. The only case-insensitive `skipped` text in the final lib log is the existing successful test named `a_skipped_refresh_of_a_disabled_credential_is_logged_once`, not a skipped prerequisite.

Exact fault names (each uses `--lib <qualified-name> -- --exact --nocapture`, except the last uses `--test plugin_owned`):

1. `management::auth_files::tests::failed_sqlite_upload_never_publishes_or_reports_success`
2. `runtime::tests::failed_sqlite_saves_never_publish_patches_equal_file_commits_or_normalization`
3. `runtime::tests::sqlite_codex_save_failures_never_publish_an_in_memory_fallback`
4. `management::plugin_auth::tests::written_saves_are_durable_and_sql_failures_do_not_publish`
5. `management::plugin_oauth::tests::sqlite_batch_restores_every_file_on_later_record_or_sql_failure`
6. `runtime::tests::cooldown_credential_normalization_leaves_async_worker_and_runs_once_per_revision`
7. `a_plugin_refresh_that_cannot_be_saved_backs_off`

Exact owner names:

- `runtime::tests::sqlite_codex_refresh_restores_newer_accepted_tokens_under_the_document_lock`
- `runtime::tests::a_cancelled_codex_grant_survives_sqlite_reopen_without_working_files`
- `runtime::tests::sqlite_refresh_waits_for_non_codex_document_lock_and_adopts_newer_accepted_tokens`

The five original exact names are `runtime::tests::a_stale_scan_cannot_undo_a_later_write`, `runtime::tests::an_invalid_grant_after_a_401_blocks_the_credential_until_its_tokens_change`, `runtime::tests::a_late_refusal_never_blocks_a_reimported_credential`, integration `a_host_config_change_reparses_the_auth_files`, and integration `a_401_from_a_plugin_executor_refreshes_through_its_auth_provider`.

### Limits / parent review

The three protocol findings and all five assigned fixture causes have source fixes plus permanent regression/final combined evidence. Independent parent review still owns acceptance. Task 2.3, 3.x, 4.x, 6.x and every other previously unchecked box stay unchecked. No whole-change, green-master, release or deployment approval follows.

The known usage measurement test is still failing; earlier multi-opener revision loss and missing model-refresh log are not declared fixed by their final passes. Runtime Drop still is not a general normalization drain; fixtures use the explicit shutdown boundary. Full competing-owner enforcement, CLI migration, polling removal, complete pending-grant/shutdown architecture, workspace/nextest/harness/UI/notices/platform/crash/resource/idle evidence remain outside this bounded repair. No real provider traffic, system installation, tool/auth configuration change, model fallback, staging, commit, push, reset, stash, merge, archive or deployment occurred.


## Final narrow native-fixture retained-job ownership repair — 2026-11-10

### Boundary and source delta

The independent `03-protocol-review.dc72c8a7.md` closes all three production protocol findings, but identifies an actual fixture deadlock: a current-thread caller panics while a caller-executor refresh owns the preparation guard; synchronous Env Drop joins cleanup, which waits for that guard on Env's private executor. The caller cannot poll its refresh while joining cleanup. Stopping the auto-refresh loop does not abort its already-started jobs.

This follow-up changes **only** `crates/cpa-server/tests/plugin_owned.rs` and this verification file. No production refresh, cancellation, lifecycle, projection, Writer-pin, parser, snapshot/publication or Home behavior changes. Tasks remain **2/33**, only 2.1/2.2 checked; **2.3 remains unchecked pending parent/original-reviewer acceptance**.

Evidence root: `/var/tmp/cook-router-native-ownership`. Entry hashes and the entry fixture/verification copies are preserved there. The entry fixture SHA-256 is `f2673a6863ea738dfd7bd9a7a670fa7588c01e0bc21c29772b7a3e6830cce5f5`; compiled RED is `2cca2b25403d97aca3a2c0609b64e70e05a11001e35b0843db359d56e136acb2`; final is `64c1d4a2ef9d0c7209d4d6851bbd8161490a980aaf27d3f28cb552a90bf3d12d`. `worker-fixture.diff` is the entry-to-final fixture delta (105 added / 47 removed lines). All **526** Rust files in `final-source-hashes.json` stayed unchanged throughout final validation (`final-source-check.json`: zero mismatches). Rechecking the preceding producer's **513** hashes finds exactly one changed path, this assigned integration fixture (`prior-513-check.json`); production sources are unchanged.

### Complete retained-job ownership map (entry → final line locators)

| Port / entry sites | Final ownership and settlement |
| --- | --- |
| Direct `env.rt.start_auto_refresh()` at entry 2643, 2762, 2839, 3783, 3907, 3965, 4009, 4110, 4147, 4164, 4250, 4280, 4335, 4427, 4485, 4532, 4574 | All 17 now call `Env::start_auto_refresh` (final 182–185), entering the existing private executor before production starts its loop. The loop and jobs it starts therefore run there, not on the caller. Existing loop stopping and preparation-lock drain remain. |
| Retained reload `tokio::spawn` at entry 3103, 3578, 4336 | `env.spawn` at final 3126, 3601, 4359: private executor, existing Tokio `TaskTracker`, typed `JoinHandle` returned to caller. Existing explicit `reload.abort()` behavior and assertions remain; it is not converted into success. |
| Retained explicit refresh `tokio::spawn` at entry 3892, 4399, 4467, 4521, 4662 | `env.spawn` at final 3915, 4422, 4490, 4544, 4685, with the same result/error/registration assertions and control releases. |
| Native host management save at entry 2285 | `env.spawn` at final 2308; this host operation can save canonical credentials, so it is a finite owned job too. |
| Management HTTP server at entry 3279 | `env.own(env.spawn(...))` at final 3302: tracked private service, retained abort/completion ownership. Primary proxy at final 167 follows the same port. |
| Native plugin startup and watcher registration | Startup already runs on the private executor and immediately awaits its handle (final 155–165). `Env::watch` still enters that executor and retains the watcher handle via `own` (final 229–232). No registration/lifetime change is needed. |
| Cleanup / executor destruction | Abort and await owned infinite services; reject unexpected JoinErrors rather than ignore them. Close/wait the finite-job tracker **without aborting finite refresh/reload jobs**, then drain preparation guards, tracked persistence/normalization and native plugins. Drop/join the private executor before workspace deletion and fixture-guard release. Explicit caller aborts remain possible through the returned typed handles. A panic-dropped caller handle does not remove its job from the completion tracker. |
| New first-fixture explicit refresh / native release | `first.spawn` at final 4972; auto variant uses `first.start_auto_refresh`. A joined OS control thread releases the native hold (final 4990), followed by panic without any caller yield. Release does not depend on the synchronously blocked caller queue. |

Other spawn sites were classified, **not blindly migrated**:

- Entry 696, 731, 2025, 4745, 4870 (final 719, 754, 2048, 4768, 4893) are test-runtime local HTTP mocks. They do not retain Env, Runtime, credential storage, native parser or private fixture workspace, and are not needed to release a native hold during fixture cleanup. The test runtime owns their lifetime, not Env.
- Final 4948 deliberately spawns the failing **caller** test task; moving it to Env would remove the current-thread counterexample. Its JoinError is awaited and required to be a panic before the next fixture begins.
- Final 917 is an immediately awaited, read-only `host.affinity.lookup` blocking callback, completed before assertions; final 263 is the explicitly awaited private-executor destruction job. The scoped OS cleanup thread is joined; the native-hold release thread is also joined.
- Direct `reload_plugin_auth_files(&env.rt).await` / direct refresh calls remain **caller-owned public operations**, not Env-owned retained jobs. Their ordinary awaits complete before subsequent assertions. In particular `a_nested_save_on_a_current_thread_runtime_skips_the_parse` must retain the caller-current-thread native-callback path, and `the_startup_reload_lets_a_parse_use_the_runtime_with_one_worker` retains its intended caller execution context. Moving these to Env would change the oracle. Parent explicitly confirmed this bounded classification.
- **Normal completion is not timeout-cancellation safety.** The direct timeout-wrapped reloads (final 2955, 3071, 3562) may leave production blocking work after cancellation; this repair does not claim a general direct-operation cancellation/drain guarantee. Those three cases have no external native hold whose release requires the caller queue. Native-hold controls in the retained-job cases use local RAII release before Env destruction or the new independently joined OS release. No actual additional direct-await cancellation teardown deadlock was demonstrated here, and no production lifecycle redesign was attempted.

### Compiled behavioral RED → GREEN and frozen final commands

The existing sequential-native-fixture helper now starts a **real native `auth.refresh` in its failing first fixture**, waits for exactly one recorder entry, and observes its held preparation guard through the public lock port. It independently releases the native hold and panics without yielding. Both auto-refresh and explicit-refresh current-thread versions deadlock on the old ownership arrangement. The multi-thread caller variant remains.

Each successful control requires first Runtime Weak dead, old proxy closed and old workspace removed before starting the second fixture. The second fixture requires its initial credential and the complete real **401 → one auth.refresh → two executor.execute** exchange, old/new access-token metadata, and canonical merged omitted-key retention (`keep`). No assertion was replaced with internal task-order assumptions or a zero-execution helper count.

Build and Cargo validation use `CARGO_TARGET_DIR=/var/tmp/cook-router-snapshot-target`, `CARGO_BUILD_JOBS=2`, private `TMPDIR=/var/tmp/cook-router-native-ownership/tmp`, `nice -n 19`, and bounded execution. `CPA_TEST_NO_SKIP=1` requires the actual native prerequisite. No serial-suite flag, sleeps added as synchronization, retry-until-green loop, global parser reset, ignored cleanup error or relaxed grant/registration assertion was used.

| Evidence / command | Actual result |
| --- | --- |
| `cargo test -p cpa-server --locked --test plugin_owned --no-run` on RED source | Compiled; `red-build.log`. |
| Private exact binary processes, `--exact a_failed_current_thread_native_fixture_joins_before_the_next_bootstrap --nocapture` and `--exact a_failed_explicit_refresh_fixture_joins_before_the_next_bootstrap --nocapture` | Both reached the deliberate **in-flight-native** panic, then bounded out at 40 s, **exit 124**. `red-*.log` / `red.status.json`. Process groups were killed and reaped before removing only those PIDs' private fixture directories; their private temporary working files were removed before GREEN. No surviving writer was left. |
| Recompile after fixture-only ownership fix | Passed; `green-build.log`. |
| Exact current-thread auto, multi-thread auto and current-thread explicit sequential-native controls | Each **1 passed / 0 failed / 0 ignored** (`green-*.log`, `green.status.json`), no native skip. Counts overlap the full target. |
| `cargo test -p cpa-server --locked --test plugin_owned -- --nocapture` | **60 passed / 0 failed / 0 ignored / 0 filtered**, ordinary parallel full target, **96.74 s**, all three named inflight controls actually executed. No `SKIPPED` prerequisite text. `full-plugin.log`. |
| `cargo fmt --all --check` | Passed; `fmt.log`. |
| `cargo clippy -p cpa-server --all-targets --locked -- -D warnings` | Passed; `clippy.log`. |
| `git diff --check`; entry/final Rust hash checks; staged index | Passed; no staged files. |

Exact final command argv, exits and elapsed times are in `final.status.json`; all owned wrappers/test processes settled. An earlier full native run also passed 60/0, followed only by comment clarification of the caller-owned direct-operation boundary; its logs are retained under `pre-comment-*`. The authoritative table above is the subsequent frozen-final-source run, not a retry of a failing suite. Integration-local Env helpers cannot change the library's ordered tests, and no library/production file changed, so the ordered 19, whole server lib, Home and prior baseline targets were **not rerun** for this fixture-only repair. Their earlier results are historical evidence, not new executions or additive unique test totals.

### Residual mandatory gates / handoff

The assigned retained-job fixture blocker has a source repair plus actual RED/GREEN and full-target evidence. This is a candidate for parent/original-reviewer recheck, **not task 2.3 or whole-change acceptance**. The earlier mandatory server-lib gate remains **RED** on `usage_record::tests::redirects_start_the_upload_measurements_over` (historical 564 passed / 1 failed); it was neither repaired nor rerun. Earlier competing-opener revision loss and missing model-updater log remain unresolved intermittent risks, not proven baselines or causally fixed by this change.

General direct-operation timeout cancellation, Runtime Drop, pending-grant lifecycle, competing-owner enforcement, CLI/poller migration, full workspace/nextest/harness/UI/notices/platform/crash/resource/idle gates remain outside this retained-job repair. No landing, release, archive, deployment or live-provider acceptance is granted. No production edits, task-checkbox edits, children, live accounts/provider traffic, system installation, proxy/auth/tool configuration changes, model fallback, staging, commit, push, stash, reset, merge, archive or deployment occurred.

### Parent acceptance of task 2.3 after final retained-job re-review

The unchecked status in the preceding repair handoffs is superseded here. Original reviewer run `92b0cadb-f7a5-4775-b997-727097dd7399` returned **APPROVED_FOR_SLICE**: the remaining retained-refresh-executor P2 is closed, the three production protocol findings remain closed, and the prior bounded task 2.3 assessment stands. The report is `/home/xz/.pi/agent/sessions/--home-xz-Code-ai-cook-router--/subagent-artifacts/outputs/c195d756-2215-4385-befc-434e49080ef0/apply/03-protocol-review.dc72c8a7.92b0cadb.md`.

The parent independently executed all three exact actual-in-flight native panic controls with `CPA_TEST_NO_SKIP=1`: current-thread auto refresh, multi-thread auto refresh, and current-thread explicit refresh. Each executed one test and passed with no failures/ignores or prerequisite skip; logs are `/var/tmp/cook-router-parent-native-jobs-x9oodlh1/`. Earlier parent checks executed the ordered module (19 tests), normalization teardown and two failed-fixture controls; zero-test helper matches were explicitly excluded, not counted as coverage. All 526 final Rust hashes match the frozen native-repair tree; the preceding 513-file manifest differs only at the assigned integration fixture, so reviewed production sources were unchanged by the final repair.

Task **2.3** can now be marked complete alongside **2.1 and 2.2**. This accepts storage closure, canonical/runtime projection and relevant ordered dispatch before successful command acknowledgement, including fail-closed required-projection recovery and the inspected lifecycle fixes. It does not complete any 3.x/4.x/6.x task, general cancellation/Runtime Drop guarantees, pending in-flight grant reconciliation or shutdown retention, exclusive ownership, CLI authority, poller retirement, task 8.4 or platform qualification.

The mandatory full library gate remains red on the recorded upload-measurement test; earlier multi-opener revision loss and missing model-updater log remain unresolved intermittent risks, not accepted baselines or causally fixed defects. Final workspace/harness/UI/notices/idle/resource/platform checks still must be completed before landing. No commit, push, archive, release or deployment follows from this slice acceptance.

## Task 2.4 — operation-scoped SQLite resources and private files

**SLICE_COMPLETE for task 2.4 only, subject to independent review.** This is a test/evidence-only slice: no production implementation, architecture, API, dependency or lifecycle behavior changed. The inherited implementation already closes operation-local disk connections. The former `database::disk_connections_close_between_operations` pathname-only check has been replaced by five behavior tests in `config_store/tests/operation_resources.rs`, registered by `config_store/tests.rs`. The earlier test could miss coordinator/published handles and old replaced inodes. No other existing test was weakened or removed.

### Resource oracle and positive control

The Linux oracle enumerates `/proc/self/fd`, selects targets **only under this unique private fixture directory**, then uses `pread` on the existing descriptor to identify the `SQLite format 3` header. It never opens/closes another descriptor on an active SQLite inode, changes the descriptor offset, logs SQL bytes, or scans other fixture directories. This includes published images, working/coordinator databases and construction images even when their path has become `(deleted)` after atomic replacement. A non-SQLite ownership-lock descriptor is not classified as a SQLite resource. In these fixtures there are no intentionally held raw backup/image files at the operation-boundary assertions.

`detector_catches_real_sqlite_handles_including_replaced_inodes` is the positive control: it opens an actual read-only SQLite connection to the fixture's published image and performs a SQL read. The oracle finds it. A real successful command then atomically replaces that image, and the oracle still finds exactly the deliberately held SQLite descriptor with the deleted-inode marker. Explicitly closing the control removes it; subsequent reads and store cleanup observe no SQLite descriptor. This is a held real handle/inode control, not a string-matching tautology or a production mutant. No deliberately injected test connection remains open during any normal-operation closure assertion.

### Source audit and behavior map

Line locators are on this final source tree. All SQL connection creation/ownership sites in the server's configuration persistence path were inspected from current files (the stale graph was not used to claim absence).

| Path / source lifetime | Observable evidence |
| --- | --- |
| `config_store.rs:42–61,257–271`; `published.rs:12–32,99–170` — disk owner holds paths, not a connection. Bootstrap's temporary `conn` is taken/dropped before return. `StoreConnection::Disk` owns its local live connection before its local coordinator. Only explicit memory fixtures retain `Mutex<Connection>`. | Immediate post-bootstrap assertion precedes even `load()`. Cold/offline reopen and accepted memory reads are checked. The positive control makes old-inode retention visible. |
| `published.rs:99–170,194–225`; `db.rs:82–95,120–155`; `state.rs:33–98` — successful/failed cold decode, resume, migration and newer-schema paths own stack-local connections. Prepared statements/transactions borrow their connection and drop before it. Legacy source connection at `published.rs:144` ends before the new working connection is returned. All `?` errors unwind these owners. | Four newer-schema/invalid-resource decode cases cover both cold published input and retained live input, with intentional corruption handles explicitly closed before observation. Bootstrap final-publication faults at both before/after replacement release all fixture SQLite descriptors and allow recovery. Existing old-schema, unsupported-kind, retained-WAL, corrupt/empty checkpoint and resume examples passed in the full config suite. |
| `encode.rs:6–16,18–82` — native fresh builder closes explicitly on success. Initialization/insertion errors drop transactions/statements and the local connection; even a failed explicit close maps/drops the returned connection. | Public backup succeeds, refuses an existing destination, and fails inside SQLite encoding when a valid output basename leaves insufficient room for its rollback-journal suffix. The latter asserts an actual `rusqlite::Error`, removes the failed output and leaves no descriptor. |
| `published.rs:54–91,242–277` — operation-local coordinator, newly encoded image File, destination File and directory-sync File do not escape persistence/publication. The encoder closes before sync/replace. Installer cleanup closes files on errors; pending state contains the candidate/event, not SQLite. | All four checkpoint/published before/after-replace fault combinations return errors without retained SQLite descriptors. Cases with an installed checkpoint also fail a recovery retry and remain resource-free before successful retry. A real checkpoint-directory obstruction fails and recovers without retaining a connection. |
| `state.rs:177–232`; `commit.rs:100–205`; `notifications.rs:79–95` — persistence returns before memory replacement/required projection/ordinary dispatch. Validation and dry runs use memory. Observer failure does not retain storage. | Public commit, invalid import, stale precondition and dry run each leave no descriptor; dry run preserves published bytes. An owned ordinary callback sends descriptor observations to the test on initial/committed delivery, then returns an intentional error. Assertions run outside the callback error catcher and verify closure before command success. The full ordered suite additionally covers required projection errors/panics, original-event retry, reader overlap and notification ordering. |
| `credential_store.rs:49–64,103–123,127–140,251–296,307–317` — CredentialCommand retains owner admission, not a disk connection; config/credential/cooldown writes use the same accept/persist path. Authorized reads use canonical memory. | Private empty legacy-auth import, credential save/read and post-write closure assertions pass. All 10 credential tests (including failed batch, failed publication/grant retry and cache reconstruction) also pass. No helper or production credential path changed. |
| `db.rs:71–78`; `state.rs:159–169`; `db.rs:99–116` — explicit memory fixtures and scratch SQL remain supported. Scratch SQL explicitly closes before acceptance. Backup creates a fresh private output, closes it on either outcome and removes failed output. | Existing `empty_and_initialized_memory_states_encode_without_a_disk_source`, lossless export with old storage removed, and dry-run/memory-only read examples pass within the full config suite. This slice does not delete the fixture connection API or in-memory support. |
| `published.rs:320–383`; `db.rs:158–174` — directories are 0700; construction files are 0600 before build; imported database/sidecars are tightened; unsafe ownership/symlink paths fail. Creation of a SQLite coordinator/live file is inside the private directory before chmod. | Unix privacy test walks only the fixture storage tree (directories 0700, every file 0600), checks checkpoint/published files and the still-unpublished temporary images at both BeforeReplace effects, then checks the final artifacts and backup. Existing permission-tightening and rollback-journal privacy test passes. |

The page-cache conclusion is a **connection-lifetime/source conclusion**, not a heap measurement: no disk `Connection` or its connection-local page cache remains owned by an idle disk-backed store. The locked dependency is rusqlite **0.41.1**; its `Connection::close` (`src/lib.rs:820–825`) and `InnerConnection::{close,drop}` (`src/inner_connection.rs:111–135,401–407`) call native `sqlite3_close`. Statement scopes were inspected so no live statements block those closes. No claim is made about allocator RSS, SQLite global allocations, peak image-construction memory or memory-only fixture caches.

### Final-tree commands and evidence

Private raw logs and hash manifests: **`/var/tmp/cook-task24-z3p_v6ci/`** (0700; generated logs/manifests 0600). All cargo commands used `TMPDIR=/var/tmp/cook-task24-z3p_v6ci/tmp`, `CARGO_TARGET_DIR=/var/tmp/cook-router-snapshot-target`, `CARGO_BUILD_JOBS=2`, and `nice -n 19`. No process-global test TMPDIR mutation, real auth import, provider traffic, system install or tool/auth/proxy fallback was used.

| Exact command | Final result | Log |
| --- | --- | --- |
| `cargo fmt --all --check` | PASS | `fmt-final.log` |
| `nice -n 19 cargo test -p cpa-server --lib --locked config_store::` | **90 passed, 0 failed, 0 ignored**; includes all five new resource/privacy tests, all 19 ordered tests, encoding, memory-query, legacy-WAL, privacy, reader and fault/recovery cases | `config-store-final.log` |
| `nice -n 19 cargo test -p cpa-server --lib --locked credential_store::` | **10 passed, 0 failed, 0 ignored** | `credential-store-final.log` |
| `nice -n 19 cargo clippy -p cpa-server --all-targets --locked -- -D warnings` | PASS | `clippy-final.log` |
| `git diff --check` | PASS, repeated after documentation/tracking updates | `diff-final.log`, `diff-handoff.log` |

First exploratory resource run passed 5/5 (`resource-first.log`); the next entire config/credential run passed 90/10 (`config-store.log`, `credential-store.log`), with fmt/clippy/diff also passing. Final runs above follow the last Rust edit and supersede earlier runs. No failing test, ignored case, intentional production mutant, lint suppression or unrelated repair occurred in this slice.

The final Rust manifest covers **527 files**: `final-rust-sha256.json`, SHA256 **`412db395fefc6b6fede3e59edf369d7309d4b3e4bbc41a05f45b8cbd6ac6c9f5`**. Comparing it with `initial-rust-sha256.json` changes exactly the two test registration/oracle files and the new resource module; all inherited production Rust bytes remain unchanged. The new module SHA256 is **`d8bc2f621ab228b1e2c862f1e7b1f8ccabc7d7b9b6edde8d37b81b39966f3158`**. Post-check verification rechecks all hashes before handoff. The index remains empty.

Task 2.4's unique exact description/unchecked checkbox was matched against apply input at `tasks.md:13` before marking it checked. Refreshed apply output confirms **ready, 4/33**, with only 2.1–2.4 complete; no other checkbox changed in this slice. Its output is retained as `apply-final.json`. The post-documentation/tracking `git diff --check` passes (`diff-handoff.log`), all 527 final Rust hashes still match the checked tree, and the index is empty. `handoff-tree-sha256.json` records the final whole-tree file identities separately from the Rust check manifest.

### Limits and residual risks

- Handle observations ran on Linux with procfs. There is no non-Linux runtime descriptor/handle observation here; the Linux checks are cfg-gated rather than replaced by no-op leak assertions. Other Unix targets retain the permission test; Windows ACLs/handle closure and native durability remain unqualified at runtime.
- There is no peak-heap/RSS/latency/resource-budget, idle, crash or power-loss measurement in this test-only slice. No budgets changed and no resource/performance savings are claimed.
- Existing last-owner Drop can still delete an unresolved checkpoint; shutdown retention, general cancellation, pending already-in-flight grant reconciliation, owner exclusion, CLI routing and poller retirement remain future tasks. Tests resolve their injected failures before normal cleanup; they do not attest pending shutdown retention.
- The earlier full server-library gate remains red on `usage_record::tests::redirects_start_the_upload_measurements_over` (564 passed / 1 failed in its recorded run). It was not repaired/rerun. Competing-opener revision loss and missing model-updater log remain unresolved intermittents, not proven baselines or fixed here. These bounded passing checks do not make the PR green.
- No entire Home/native-plugin/full-workspace suites were rerun for this test-only oracle. Final workspace clippy/nextest, actual harness, UI, notices, platform and idle/resource gates remain required before landing. Integration error suites were not rerun because no shared fixture helper, production code or integration seam changed; their inherited evidence is not represented as new execution.
- No child agent, commit, push, stash, reset, merge, archive, release or deployment occurred. Stop after this bounded handoff; no next domain is started.

### Parent verification and acceptance of task 2.4

The parent inspected all five resource/privacy tests, including the borrowed-descriptor `pread` oracle, its real held/deleted-inode SQLite positive control, error/retry/notification observations and private-image construction permissions. The oracle does not acquire extra ownership of SQLite descriptors or treat a future non-SQLite owner-lock file as a connection. Page-cache scope is supported by native connection lifetime/source audit, not claimed allocator/RSS savings.

All 527 frozen Rust hashes match the candidate. Compared with the previous frozen tree, only `config_store/tests.rs`, `config_store/tests/database.rs` and the new `config_store/tests/operation_resources.rs` changed; production Rust is unchanged. The parent independently executed the complete resource module: **5 passed, 0 failed, 0 ignored**, with logs at `/var/tmp/cook-router-parent-resources-mn82xbys/`. The producer's final config-store 90/0 and credential-store 10/0 results, clippy/fmt and whitespace evidence were inspected. Task 2.4 is accepted, with **2.1–2.4 checked (4/33)**.

Linux descriptor observations and Unix permission assertions do not attest Windows handle/ACL or non-Linux runtime behavior. No idle/RSS/export-cost, crash/power-loss or final workspace gate is accepted. The recorded red usage-measurement gate, unresolved intermittent risks and pending-grant/shutdown/owner/CLI/poller tasks remain mandatory work before landing.


## Task 2.5 — partial canonical file-backed refresh recovery (blocked; not accepted complete)

**PARTIAL/BLOCKED.** Task 2.5 at `tasks.md:15` is still unchecked. Refreshed apply is ready, **4/33**, with only 2.1–2.4 complete. No 3.x/4.x/6.x task was checked. This section records a bounded candidate for independent review, not full task or provider-family acceptance.

### Contract boundary requiring user input

The parent confirmed a genuine unresolved boundary: plugin-virtual refreshes can consume non-repeatable token grants, but intentionally never overwrite their shared plugin source document. There is no canonical per-virtual credential record. The pending-grant specification does not explicitly exempt them. The worker did not invent a new schema, secret queue or per-virtual document, nor enable a virtual-result recovery bypass. The parent is obtaining an explicit user decision. Virtual refresh results remain on ordinary admission; their established no-local-durability semantics are **not** represented as satisfying the pending-grant requirement.

The wider sink audit also found unconverted, file-backed initial-login paths: `management/oauth.rs:save_if_pending`/`LoginSave` -> `write_files`, `management/plugin_oauth.rs:save_records` -> `write_files`, `management/siwc.rs:write_binding` -> `auth_files::save_bytes`, and plugin host `management/plugin_auth.rs:SaveManager::save` -> `write_files`. These need explicit consumed-result and new-start contexts, with their cancellation/session/source/account fences intact. Upload/Vertex/raw editing must not be blanket-converted into grant commands. Those transitions remain unclosed; no claim is made that every new grant start or consumed grant sink is covered.

### Implemented canonical refresh candidate and caller/status map

- `config_store/state.rs:177–233`: ordinary `writer` first republishes/reconciles retained recovery before admitting work. Narrow internal `grant_writer` accepts only already-consumed result contexts without that prerequisite. `accept_grant` retains the complete candidate **before** checkpoint I/O, carries forward the pending candidate's original configuration event, and withholds success on every error. Ordinary `accept` retains its prior checkpoint-installed-only rule.
- `credential_store.rs:174–198,277–330`: `command` is ordinary admission; `granted_command` is preservation admission. Command reads and derivation use the latest pending complete state when present, not old accepted memory, a runtime projection or SQL. Grant retention precedes cache materialization, so a materialization/storage error cannot silently drop the consumed bytes. The same owner context still covers saves and repair; no recursive owner acquisition was added.
- `runtime.rs:684`: local preparation settles ordinary recovery before starting external grant work; networking remains outside owner admission. Home still has remote-only authority and does not bind this local owner.
- `runtime.rs:2936`: generic file-backed builtin/plugin refresh results that change token identity enter preservation admission. Non-token normalization and plugin-virtual results retain ordinary admission. Existing registration, credential-version, revision, source and rebase checks still determine whether a result may apply. Generic providers routed through this method are Claude, Kimi, Meta, xAI, Devin, Antigravity, and non-file-specialized/plugin refreshes. Actual grant/normalization discrimination is the existing token-identity comparison, not a newly added provider protocol flag; only the mocked Claude generic family was newly exercised under pending publication.
- `runtime.rs:4172`: Codex file grants keep their document lock, use preservation admission for `RefreshPatch::granted`, patch against the latest pending raw document with existing partition baselines, then separately attempt ordinary runtime admission. Adopt-only Codex remains ordinary admission. A persistence error cannot reach runtime publication.
- `config_store.rs:47`, `state.rs:197,270`, `credential_store.rs:191`, `runtime.rs:2008`: an owner-derived source-digest view fences dispatch of known-obsolete affected credentials without SQL or an owner-I/O lock. Selection, plugin candidates, retry eligibility and rejection views consult it. The view tracks required source digests (including a deletion tombstone), not independently writable scheduler authority. Runtime provenance and revision must match before the affected view is usable. Unaffected documents remain selectable. Recovery preparation adopts canonical bytes before issuing another grant. Ordinary metadata and nested file-backed edits refuse an obsolete source rather than writing R0 back after R1 recovery.
- `published.rs:10–27,116–118,471–522`: shared in-process workspace lifetime records unresolved recovery, not a SQLite handle. Last-owner Drop removes its ref marker but reports incomplete cleanup and retains unresolved work. A settled owner removes its own workspace. Opportunistic cross-namespace sweeping was removed because another namespace can contain required grants. A competing bootstrap does **not** clear an active owner's unresolved flag. This is not implementation or acceptance of exclusive ownership, PID redesign, general stop-and-wait shutdown, or task 3.x.

The source audit used actual Rust source. The previously indexed graph is stale and was not used to infer missing callers or completeness.

### Behavioral tests and fixture oracle changes

New tests:

1. `runtime::tests::pending_publication_preserves_two_inflight_codex_grants`: two distinct refresh tokens reach an actual loopback HTTP grant mock behind deterministic permits. After first checkpoint/final-publication failure, unrelated config mutation fails; the second already-in-flight result retains both latest raw documents and opaque fields. A third new refresh causes zero extra mock grants. Real selection refuses affected old tokens while an unaffected document remains selectable. After repair, stale metadata/nested file edits cannot overwrite recovered R1; preparation adopts R1 without another grant. A standalone published-file cold copy retains both documents/configuration. Deleting a recovered document fences a retained stale runtime view.
2. `runtime::tests::pending_publication_preserves_generic_oauth_grants_without_admitting_old_tokens`: two actual loopback Claude OAuth grants exercise the generic commit path, pending merge, blocked ordinary mutation/new start, no premature runtime update, canonical re-adoption, and opaque-field retention.
3. `credential_store::tests::consumed_grant_survives_a_checkpoint_error_and_merges_the_next_result`: explicit credential command/effect ports inject failure **before checkpoint replacement**. The consumed grant remains owner-private; a second consumed result merges with it while final publication remains blocked. Repair retains both and does not revive the refused ordinary configuration mutation. Settled Drop removes its own workspace.
4. `credential_store::tests::unresolved_grant_checkpoint_survives_drop_and_another_database_initialization`: unresolved last-owner Drop retains the real checkpoint; initializing another namespace cannot sweep it; resume publishes R1 and retains configuration history; final settled Drop removes the workspace.
5. `config_store::tests::ordered::grant_merge_preserves_the_original_incomplete_configuration_event_once`: a required projection fails after canonical configuration advances. A grant merge retains the original revision/digest/configuration event; ordinary/runtime success notifications remain withheld, then repair delivers that event once. Credential-only changes cause no configuration event.

Existing fixture adaptations, not weaker pass criteria:

- `resume_republishes_a_live_commit_whose_publication_failed` now drops the unresolved original owner and verifies its actual checkpoint survives **before** opening the resumed owner. It preserves failed-publication/old-published-revision/new-live-state/republication/settled-cleanup assertions. The old concurrent-opener-as-resume oracle did not prove last-owner recovery retention. Other concurrent-opener tests remain unchanged and unaccepted as ownership guarantees.
- The cross-namespace sweep fixture now asserts that initialization leaves another namespace's bytes intact, including its active-live protection and successful own publication. The test explicitly cleans only the fabricated namespace it owns. This is the approved data-retention dependency, not a recovery catalog or daemon.

New grant-arrival gates use Notify/semaphore barriers, not sleeps. New grant jobs are joined and critical Codex jobs are drained. Existing unrelated fixture polling/cancellation limitations were not rewritten or claimed solved.

### RED, diagnostics and failures (retained, not hidden)

Private evidence root: `/var/tmp/cook-router-task25/`; `TMPDIR=/var/tmp/cook-router-task25/tmp`, `CARGO_TARGET_DIR=/var/tmp/cook-router-snapshot-target`, `CARGO_BUILD_JOBS=2`, `nice -n 19` for Cargo test/clippy. No real auth directory, provider account or external upstream was used.

- `red.log`, `red2.log`, `red3.log`: initial mock fixture attempts failed awaiting two grants. Diagnosis: using the **same** refresh token coalesced requests upstream. Those are fixture failures, not accepted behavioral RED evidence.
- `red4.log`: after assigning distinct refresh tokens, `cargo test -p cpa-server --lib pending_publication_preserves_two_inflight_codex_grants -- --nocapture` exited **101**, with one checkpoint document still holding its old refresh token instead of the actual returned grant. This is the real RED for admission losing the second consumed result. Initial RED source bytes were not separately frozen; do not treat its log as a frozen-tree attestation.
- `green1.log`: same actual grant scenario passed after implementation.
- `grants.log`: 10 passed / 1 failed because the publication permission fault also blocked creating another database in the same parent directory. The fixture was repaired by precreating a separate owned child directory, not weakening retention assertions; `grants2.log` passed 11/0.
- `config_store1.log`: 89 passed / 2 failed. One lifecycle failure exposed clearing/retaining shared recovery state incorrectly in the legacy concurrent-opener resume fixture; the final candidate instead keeps an active owner's flag and tests actual drop/resume. The other failure was concurrent-opener revision loss, **14 vs16**.
- `final-config_store__.log`: 90 passed / 1 failed on the same concurrent-opener revision-loss test, **12 vs16**. This intermittent is neither fixed nor proved baseline here. Later final-tree passing runs do not erase those failures. Each broad rerun followed actual production/fixture changes; no retry-until-green loop, serial flag, weakened limit or ignored error was used.
- Historical whole-server `usage_record::tests::redirects_start_the_upload_measurements_over` failure (previously 564 passed / 1 failed) was not rerun or fixed. The earlier model-updater missing-URL-log intermittent also remains unresolved. No full-server-green claim is made.

### Final frozen-source validation

Final manifest `/var/tmp/cook-router-task25/final-rust-sha256.json`: **527 Rust files**, SHA256 **`72c5ad113ceac44ead4f94b608c9c8aeba5c2e6094e196840e664068065429c3`**. It was frozen after the final Rust edit; source hashes are checked again at handoff. Comparison with accepted task-2.4's manifest changes exactly eight Rust files: `config_store.rs`, `config_store/db.rs`, `config_store/published.rs`, `config_store/state.rs`, `config_store/tests/database.rs`, `config_store/tests/ordered.rs`, `credential_store.rs`, `runtime.rs`. No dependency/generated manifest changes were made.

All commands below ran on that final frozen Rust source. Logs have prefix `/var/tmp/cook-router-task25/`:

| Actual command (environment above) | Result | Log |
| --- | --- | --- |
| `nice -n 19 cargo test -p cpa-server --lib runtime::tests` | 84 passed, 0 failed, 0 ignored; exit 0 | `verified-runtime__tests.log` |
| `nice -n 19 cargo test -p cpa-server --lib config_store::` | 91 passed, 0 failed, 0 ignored; exit 0; includes complete ordered/resource suites | `verified-config_store__.log` |
| `nice -n 19 cargo test -p cpa-server --lib credential_store::` | 12 passed, 0 failed, 0 ignored; exit 0 | `verified-credential_store__.log` |
| `nice -n 19 cargo test -p cpa-server --lib management::` | 60 passed, 0 failed, 0 ignored; exit 0 | `verified-management__.log` |
| `nice -n 19 cargo test -p cpa-server --lib plugins::refresh` | 2 passed, 0 failed, 0 ignored; exit 0 | `verified-plugins__refresh.log` |
| `nice -n 19 cargo test -p cpa-server --lib refresh::tests` | 4 passed, 0 failed, 0 ignored; exit 0 | `verified-refresh__tests.log` |
| `nice -n 19 cargo test -p cpa-server --test admin_contract` | 15 passed, 0 failed, 0 ignored; exit 0 | `verified-admin_contract.log` |
| `nice -n 19 cargo test -p cpa-server --test management` | 54 passed, 0 failed, 0 ignored; exit 0 | `verified-management.log` |
| `CPA_TEST_NO_SKIP=1 nice -n 19 cargo test -p cpa-server --test plugin_owned` | 60 passed, 0 failed, 0 ignored; exit 0; actual native prerequisites present | `verified-plugin_owned.log` |
| `nice -n 19 cargo test -p cpa-home --lib` | 120 passed, 0 failed, 0 ignored; exit 0 | `verified-home.log` |
| `nice -n 19 cargo clippy -p cpa-server --all-targets --locked -- -D warnings` | pass, exit 0 | `verified-clippy.log` |
| `cargo fmt --all --check` | pass, exit 0 | `verified-fmt.log` |
| `git diff --check` | pass, exit 0; rerun after documentation | `verified-diffcheck.log`, `handoff-final-diffcheck.log` |

Tests were not run with `--locked`; strict server all-target clippy was. These selected runs are not the repository's complete locked workspace/nextest, harness, notices, UI, release or idle gates.

### Residual boundaries and next action

- Do not check 2.5 or describe all provider/grant families as covered. Resolve the virtual-grant contract with the user; then implement and verify the remaining initial OAuth/SIWC/plugin-host start/result paths through explicit contexts. Parent independent review precedes any next writer.
- The granted-command exception preserves bytes in memory on checkpoint write failure, but cannot promise power-loss durability without storage. If tmpfs/workspace vanishes, cold recovery is from the **published acknowledged image**, not the unacknowledged token. No pending-backup API was invented.
- Last-owner Drop retention is qualified at the tested effect ports. Full shutdown admission stop, process crashes, cancellation ownership, cross-process exclusion and active competing-openers remain 3.x work. Removing cross-namespace sweep intentionally leaves unowned namespaces for explicit recovery/cleanup by their own owner.
- Owner-derived fences are memory-only digest/tombstone entries scoped to documents that produced preservation commands; they do not claim bounded-memory/export/idle performance measurements. No performance or resource-budget savings are asserted.
- Linux/Unix fault/privacy/resource observations do not attest Windows handle/ACL/metadata durability, macOS behavior, reboot/power-loss survival or general platform support. No full workspace, harness/UI/notices/release/idle/RSS/export-cost gate was run in this partial slice.
- Existing dirty work was preserved, the index remains empty, no task checkbox changed, and no child agent, commit, push, stash/reset, merge, OpenSpec archive, installation, live account traffic, proxy/auth/model-tool fallback change or deployment occurred.

Final integrity note: all 527 frozen Rust hashes match, task 2.5 remains unchecked (ready 4/33), and the index is empty. Whole-tree comparison also detected ambient Hindsight extension changes to `.pi/hindsight/retain-cursors.json` and `.pi/hindsight/retain-receipts.json`; the worker did not manually edit or revert these files. Deliberate changes are the eight Rust paths above and this verification addendum.

## Task 2.5 recovery continuation (worker ff9eadd8; in-progress)

Recovered the interrupted writer from actual source and its session tail. Initial locked `cargo check -p cpa-server -p cpa-plugin --tests` passes (`/var/tmp/cook-router-task25b/initial-check.log`). The dirty tree and empty index are preserved. Existing unverified edits already include job-scoped host-save wiring and native tests; these require repair and validation rather than assuming the prior tail was complete. Next: verify capability/target/session fences, native opaque refresh + callback behavior, then freeze Rust hashes and run the required locked affected suites. Task 2.5 remains unchecked. Evidence/logs for this continuation are under `/var/tmp/cook-router-task25b/`; private TMPDIR is its mode-0700 `tmp` child.

Continuation checkpoint: repaired the interrupted native login fixture (missing management capability/plugin and missing `auth.parse` answer), and added a native refresh host-save scenario covering an opaque token, exact refresh target refusal, pending old-source dispatch fencing, ordinary-callback refusal, recovery without another refresh, and expired callback refusal. The recovered native virtual opaque-return scenario passes; the new refresh scenario passes (`native-refresh-6.log`). The login batch + opaque scoped callback now passes and is extended with live session cancellation; next validate that extension, inspect final fences and run frozen-source suites. Earlier native failures are retained (`recovered-native.log`, `native-login-2/3/4.log`, `native-5.log`); they exposed incomplete fixtures, not accepted success. No task checkbox changed.

Continuation implementation checkpoint before frozen validation: native opaque virtual-return, initial batch/scoped opaque callback, exact refresh-target/save-lifetime, ordinary-save refusal and live OAuth-session cancellation now pass in `/var/tmp/cook-router-task25b/native-7.log` (5/0; includes two deliberate failing-fixture cleanup tests whose caught panic text is expected). Added a further expired-cloned-scope check. Rendered plugin callback and returned OAuth-batch bytes now enter owner retention **before cache-file I/O**; `rendered_grant_batch_is_durable_before_cache_materialization` proves a complete batch remains in the actual published cold-copy database when the cache directory is replaced by a file (`rendered-batch.log`). The pure `PluginAuth::save_payload` seam preserves validation and opaque fields; no dependency changes.

Known remaining boundary found in recovery audit: builtin initial-login `LoginSave` is still an effectful provider merge/write closure. Its publication-pending result is preserved after that closure produces complete files, but a failure **inside** that closure before complete output reaches `CredentialCommand::write_files` cannot retain the original consumed provider result. SIWC also still restores/checks the cache file before deriving its completed binding. These early-cache/pre-encoding failure cases are not covered by the new publication tests; no claim that the strict no-consumed-result-loss rule is closed at those boundaries. A complete follow-up needs a render-before-effects provider login port and an explicit SIWC source-check port, not a generic ambient bypass. Task 2.5 must remain unchecked and this continuation must report PARTIAL unless these residuals are closed.

Frozen validation pass 1 found two real SIWC failures (not the unrelated known intermittents): the completed binding called ordinary `resolve`/`restore` before its grant context and lost the pending result; successful SIWC saves were later falsely fenced because normal result normalization removed hash-only provenance. Fixed the commit-side precheck to read/check the working identity without ordinary recovery admission (the granted command still re-reads canonical pending bytes and checks account/path), and retain the updated source digest after canonical normalization even when no exact Go document exists. Repaired four strict-clippy findings in recovered code. Logs/manifests from pass 1 are preserved under `/var/tmp/cook-router-task25b/pass1/`; no failure is erased. Before final re-freeze, run the affected public SIWC flows once; then repeat the required locked suite on the repaired frozen source. The early pre-encoding LoginSave/cache failure limitation remains explicitly unclosed.

### Recovery continuation final result — PARTIAL, not SLICE_COMPLETE

The approved volatile plugin-virtual decision and job-scope callback implementation are present and verified at native/public effect seams. A successful opaque-only returned virtual refresh is retained in owner memory while publication is pending, invalidates old dispatch, re-admits after recovery without a second grant, and never rewrites the shared source document. Its registration/version/source fences are covered by `runtime::tests::held_virtual_grants_recheck_registration_version_and_source_at_recovery`.

The native initial-login scenario verifies a complete returned batch plus an in-job opaque `host.auth.save` are preserved together; wrong-plugin/provider, ordinary parse/manual and post-job callbacks cannot borrow its authority; an in-flight cancelled OAuth session admits neither its callback save nor its returned result. The native refresh callback scenario additionally checks exact refresh target refusal, old-source dispatch fencing, zero additional refresh calls, recovery, and a **cloned expired service-issued scope in a freshly authenticated callback context**. No client grant flag or plugin wire-format change was added. A virtual callback whose arbitrary raw document does not parse to the job's child is conservatively retained in owner memory and withheld, not written to the shared source; its upgrade path is documented in code.

Returned plugin batches now render/validate against the latest pending canonical bytes (including sequential duplicate-path metadata merges) before owner acceptance, and only then materialize files. Scoped file-backed callback saves likewise retain rendered bytes before cache I/O. The new batch effect-port test proves cache materialization failure still leaves the complete batch in an ordinary standalone published-file cold copy. Two public SIWC failures discovered in pass 1 were repaired without weakening assertions: a completed binding no longer calls ordinary recovery admission in its precheck, and later ordinary normalization retains hash-only source provenance instead of falsely rejecting already-adopted SIWC bytes.

**Still not closed:** the strict no-consumed-result-loss contract for builtin initial-login failures *inside* the effectful provider `LoginSave` writer before complete files are available, and SIWC cache-restore/identity-I/O failure before binding bytes are derived. These are explicit `ponytail:` ceilings in `management/oauth.rs` and `management/siwc.rs`. No new test proves retention for those cases; do not infer closure from the passing publication-pending scenarios. A follow-up must provide pure rendering/source-identity effect ports and test those failures, while retaining the existing source/account/session/cancellation fences. Task 2.5 stays unchecked (OpenSpec ready, 4/33); no 3.x/4.x/5.x work was started.

### Final repaired frozen-source validation

Environment for Cargo tests/clippy: `CARGO_TARGET_DIR=/var/tmp/cook-router-snapshot-target CARGO_BUILD_JOBS=2 TMPDIR=/var/tmp/cook-router-task25b/tmp`, `nice -n 19`. Every Cargo validation below uses `--locked`. Native server tests additionally use `CPA_TEST_NO_SKIP=1`. All test databases/auth directories are private fixtures; only loopback mock traffic was used.

Final manifest: `/var/tmp/cook-router-task25b/final-rust-sha256.json`, **527 Rust files**, SHA256 **`0466065b5b98f535209b2d55122b02b769059c88ef70cd82130c45dca61ce635`**. All hashes were rechecked after every required validation and still match. `final-results.tsv`, `final-summary.log`, and `validate.sh` identify the exact final commands. Logs are rooted at `/var/tmp/cook-router-task25b/`:

| Command | Result | Log |
| --- | --- | --- |
| `nice -n 19 cargo test -p cpa-server --lib --locked config_store::` | ok. 91 passed; 0 failed; 0 ignored; 0 measured; 488 filtered out; finished in 6.41s | `final-config_store__.log` |
| `nice -n 19 cargo test -p cpa-server --lib --locked credential_store::` | ok. 13 passed; 0 failed; 0 ignored; 0 measured; 566 filtered out; finished in 0.68s | `final-credential_store__.log` |
| `nice -n 19 cargo test -p cpa-server --lib --locked runtime::tests` | ok. 86 passed; 0 failed; 0 ignored; 0 measured; 493 filtered out; finished in 20.78s | `final-runtime__tests.log` |
| `nice -n 19 cargo test -p cpa-server --lib --locked management::` | ok. 62 passed; 0 failed; 0 ignored; 0 measured; 517 filtered out; finished in 5.29s | `final-management__.log` |
| `nice -n 19 cargo test -p cpa-server --lib --locked plugins::refresh` | ok. 2 passed; 0 failed; 0 ignored; 0 measured; 577 filtered out; finished in 0.17s | `final-plugins__refresh.log` |
| `nice -n 19 cargo test -p cpa-server --lib --locked refresh::tests` | ok. 4 passed; 0 failed; 0 ignored; 0 measured; 575 filtered out; finished in 0.16s | `final-refresh__tests.log` |
| `nice -n 19 cargo test -p cpa-server --test admin_contract --locked` | ok. 15 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.54s | `final-admin_contract.log` |
| `nice -n 19 cargo test -p cpa-server --test management --locked` | ok. 56 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 9.28s | `final-management.log` |
| `env CPA_TEST_NO_SKIP=1 nice -n 19 cargo test -p cpa-server --test plugin_owned --locked` | ok. 63 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 99.73s | `final-plugin_owned.log` |
| `nice -n 19 cargo test -p cpa-plugin --lib --locked` | ok. 95 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.07s | `final-plugin.log` |
| `nice -n 19 cargo test -p cpa-home --lib --locked` | ok. 120 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.90s | `final-home.log` |
| `nice -n 19 cargo clippy -p cpa-server -p cpa-plugin --all-targets --locked -- -D warnings` | pass, exit 0 | `final-clippy.log` |
| `cargo fmt --all --check` | pass, exit 0 | `final-fmt.log` |
| `git diff --check` | pass, exit 0 | `final-diffcheck.log` |

These are the requested affected suites, not full workspace/nextest, harness, UI, notices, release/idle, Windows/macOS, reboot/power-loss, general shutdown or cross-process exclusion gates. No performance or memory-budget claim is made. The historical unrelated usage-record redirect failure and multi-opener/model-updater intermittents were not chased or represented as fixed; none appeared in these final selected runs.

Earlier failures remain available: `recovered-native.log`, `native-login-2.log` through `native-login-4.log` found missing recorder capabilities/plugin/parser answers; `native-5.log` exposed a missing initial opaque parse value; `native-login-cancel.log` exposed reuse of an already-failed OAuth session ID. They were repaired in the fixtures without weakening retention/denial assertions. `pass1/final-management.log` records both real SIWC failures (54 passed / 2 failed), and `pass1/final-clippy.log` records four recovered-code lint failures. `repaired-siwc.log` then passes all three public SIWC flows; the full final management suite passes 56/0. The two native failing-fixture cleanup tests intentionally catch panics and still pass; their panic text is expected, not a hidden test failure.

This worker changed eight Rust files relative to its recovery checkpoint: `cpa-plugin/src/auth.rs`; `cpa-server/src/credential_store.rs`; `cpa-server/src/management/{oauth,plugin_auth,plugin_oauth,siwc}.rs`; `cpa-server/src/runtime.rs`; `cpa-server/tests/plugin_owned.rs` (all paths under `crates/`). It also appended this verification section. The recovered initial-login/native/virtual implementation and design/spec/state documentation edits remain in place; the broader dirty tree was not reverted. The index is still empty; no task checkbox changed. No child, commit, push, stash/reset, merge/archive, installation, live login/provider traffic, model/auth fallback, deployment or external release action occurred.

### Task 2.5 review repair — in progress

Read all four independent findings and prior handoff. Preserve the inherited dirty tree and unchecked task. Repairing lock-safe consumed-grant publication, returned-login provenance, same-job final refresh retention, and builtin/SIWC pre-retention effects. Evidence root: `/var/tmp/cook-router-task25c/`; private TMPDIR and local mocks only. No completion claim yet.

Repair compile checkpoint: split consumed-grant retention from lock-safe projection resolution; threaded returned-login authority and same-job source provenance; introduced owner-held builtin results and canonical SIWC rendering before cache effects. Beginning locked affected-server compilation; tests/evidence still pending.

Repair validation checkpoint: locked server tests compile after adding owned repeatable builtin values. Builtin render now uses a private scratch directory (canonical inputs, original result retained before any scratch/cache effects); SIWC derives canonical binding bytes first. Running focused existing owner/management regressions and the native callback-final-result regression next.

Focused pass 1/2 exposed and retained three genuine regressions in the repair: scratch-only rendering required a test upload path to use its supplied directory, scoped-login test needed an actual scripted provider identifier, and SIWC lock-busy retries needed to release the committing claim. Fixes preserve the original assertions. Added the Management-attached returning-grant signal-gated regression; running it plus focused management/native tests.

Regression checkpoint: Management-attached returning-grant recovery passed with signal gates and original-event-once assertions; existing 62 management tests passed; native callback plus distinct final R2 passed without another refresh. Added gated native deleted/replaced returned-login batches (with/without pending publication), and builtin/SIWC real pre-retention effect failures. Starting focused validation.

All new focused regressions are GREEN, including native deleted/replaced destinations across four gated orderings and both pre-retention paths. Next capture isolated RED defect-toggle checks (each temporary edit is restored in a finally block; not baseline-tree claims), then format/clippy and final frozen affected suites.

Isolated RED evidence captured: lock-safe boundary disabled -> bounded completion signal failed at 5s; returned-login provenance disabled -> deleted target incorrectly reported `ok`; builtin requeue disabled -> recovery kept R0; SIWC old cache restore reintroduced -> no retained/adoptable binding. The first R2 RED toggle unexpectedly passed because a canned parser supplied R2 to the callback; corrected fixture to one-time R1 parsing plus final returned R2. Corrected RED recovers only R1; GREEN recovers R2 and retains callback-only fields, with one upstream refresh. Logs retained in `/var/tmp/cook-router-task25c/red-*.log`. Formatting and strict lint preflight begin now.

Final-source preparation: strict server/plugin all-target clippy passed. Tightened held builtin recovery by capturing canonical source hashes before scratch creation/hydration, so even a pre-writer failure cannot later reinterpret a deleted/replaced destination as new. All four findings have implementation and effect-level regressions. Beginning the required frozen-source affected suites, private TMPDIR, `--locked`, nice 19, jobs 2, native no-skip. This note precedes the long run; task 2.5 remains unchecked.

Frozen pass 1 completed: all requested suites/lints passed except three Claude management integration cases (53/56). Root cause: Claude supplies optional absent legacy candidate paths; the private renderer incorrectly required every candidate to exist instead of retaining explicit absence like the original writer. Repairing optional document rendering, keeping all public assertions unchanged. First frozen logs and manifest remain retained; a new freeze and all requested commands will follow.

Claude optional-absence rendering repaired; both dedicated public Claude login/legacy-cleanup tests are GREEN (no assertion changes). Preparing freeze 2 and rerunning every required affected command; pass-1 failures retained under `pass1/`.

### Task 2.5 review repair — final handoff (SLICE_COMPLETE; task unchecked)

All four review findings have targeted implementations and effect-level regression evidence. The previous builtin/SIWC pre-retention ceilings above are superseded by this repair, not accepted waivers. Required publication/projection recovery occurs after runtime reload/per-ID guards are released; original configuration-event delivery is asserted once. Returned login batches share their callback job authority. Final refresh R2 is authorized from the same job's advanced R1 source and rendered over the latest candidate. Builtin completed values remain owner-held across private rendering/hydration failures; SIWC derives and retains complete canonical bytes before cache/lock effects.

Final Rust manifest: `/var/tmp/cook-router-task25c/final-rust-sha256.json`, 527 files, SHA256 `145f7524a4ea5ac2b9beb1dd0282951a20516d1ce2d830ef1c7018e538f95c8c`; all hashes rechecked unchanged. Exact commands/statuses: `final-results.tsv`; runner: `validate.py`; summaries: `final-summary.log`. All Cargo commands used `--locked`, jobs 2, nice 19 and private TMPDIR; native tests used `CPA_TEST_NO_SKIP=1`.

| Final command | Result | Log under evidence root |
| --- | --- | --- |
| cpa-server lib `config_store::` | 91 passed | final-config_store__.log |
| cpa-server lib `credential_store::` | 13 passed | final-credential_store__.log |
| cpa-server lib `runtime::tests` | 87 passed | final-runtime__tests.log |
| cpa-server lib `management::` | 64 passed | final-management__.log |
| cpa-server lib `plugins::refresh` | 2 passed | final-plugins__refresh.log |
| cpa-server lib `refresh::tests` | 4 passed | final-refresh__tests.log |
| cpa-server test `admin_contract` | 15 passed | final-admin_contract.log |
| cpa-server test `management` | 56 passed | final-management.log |
| cpa-server test `plugin_owned`, native no-skip | 64 passed | final-plugin_owned.log |
| cpa-plugin lib | 95 passed | final-cpa-plugin.log |
| cpa-home lib | 120 passed | final-cpa-home.log |
| server/plugin all-target strict clippy | exit 0 | final-clippy.log |
| cargo fmt --all --check | exit 0 | final-fmt.log |
| git diff --check | exit 0 | final-diffcheck.log |

New/extended regressions: `returning_grant_recovers_management_projection_after_releasing_credential_guards`; `returned_login_batches_refuse_deleted_and_replaced_job_destinations`; `native_refresh_host_save_is_scoped_to_its_target_and_expires_with_the_job` (one-time parsed R1 plus distinct returned R2); `completed_builtin_login_survives_failures_before_complete_bytes_exist`; `completed_siwc_binding_is_retained_before_cache_identity_or_hydration_effects`. The existing provider lock-order, session cancellation, complete initial batch, SIWC concurrent outer rotation, Claude legacy cleanup and native authority assertions remain intact.

RED checks are isolated defect toggles, not claims of running the untouched predecessor: `red-lock.log` fails by bounded completion signal; `red-login-fence.log` incorrectly returns success for a deleted target; `red-final-r2-real.log` recovers R1 instead of R2; `red-builtin-hold.log` recovers R0; `red-siwc-cache.log` exposes the lost pre-cache binding. Every temporary edit was restored in `finally`. `red-final-r2.log` is intentionally retained as an ineffective first fixture: its parser inadvertently supplied R2 during the callback. The corrected one-time R1 fixture demonstrates RED/GREEN in `red-final-r2-real.log` and `green-final-r2-real.log`.

Failures retained honestly: `management-first.log` and `management-second.log` exposed scratch upload path setup, missing scripted provider identity and SIWC lock-busy claim retry issues; all repaired without removing assertions. `pass1/final-management.log` has 53/56 passing because optional absent Claude legacy candidates were incorrectly required to be files; corrected to retain explicit absence, with both dedicated public Claude tests passing in `repaired-claude.log` and the final full suite 56/0. No known unrelated usage-record/multi-opener/model-updater failure appeared in the final selected runs, and none was chased or represented as fixed.

Limits: unrendered builtin and virtual results remain owner-lifetime memory until bytes can enter the checkpoint; no process-exit/power-loss promise is added for unacknowledged work. Before the builtin legacy renderer identifies its exact destination, existing files for that provider are conservatively withheld. Private scratch rendering is specific to builtin LoginSave, not a new external persistence authority. Full workspace/nextest, harness, UI, notices, idle/release, other platforms, cross-process exclusion and shutdown gates are not claimed. Source includes 17 changed Rust paths relative to the frozen predecessor (listed in `changed-rust-paths.json`) plus this verification section and state-contract documentation. Index remains empty and task 2.5 remains unchecked. No child, commit, push, stash/reset, merge/archive, system install, deployment, provider traffic or real credentials were used. Parent independent review is the next step; stop after handoff.


### Task 2.5 second repair — progress

- Beginning RED runs for intermediate callback publication/adoption and held builtin UI expiry. The new tests use channel/semaphore gates and direct expiry; task 2.5 stays unchecked. Logs: `/var/tmp/cook-router-task25d/`.

- RED confirmed on the unrepaired implementation: both native intermediate-admission orderings return R1 instead of R2 (`red-refresh.log`, 0/2); direct UI expiry drops the held result and leaves R0 (`red-builtin.log`, 0/1). Starting focused GREEN verification after carrying the exact callback source/admission and detaching consumed authorization from UI lifetime.

- Focused builtin GREEN passed, including direct UI expiry and a fence assertion inside recovery rendering. The first refresh implementation passed recovery/adoption but still rejected immediate upsert because upsert does not install load provenance (`green-refresh.log`, 1/2); corrected the extra provenance assumption while retaining exact registration/version and owner-checked source hashes. Running the corrected refresh GREEN.

- Corrected refresh GREEN: both intermediate-admission orderings passed (`green-refresh-admission.log`, 2/0), canonical R2 and callback-only fields retained, exactly one refresh and only R2 dispatched. Freezing Rust source for all requested final suites; the final runner appends a progress note before each command. Provider-wide builtin withholding is not time-bounded: it lasts until a later owner admission successfully renders the held queue, independently of UI expiry.

- Final frozen-source validation starting `cargo test -p cpa-server --lib --locked config_store::`; log `/var/tmp/cook-router-task25d/final-config_store__.log`. No task checkbox changes.

- Final frozen-source validation starting `cargo test -p cpa-server --lib --locked credential_store::`; log `/var/tmp/cook-router-task25d/final-credential_store__.log`. No task checkbox changes.

- Final frozen-source validation starting `cargo test -p cpa-server --lib --locked runtime::tests`; log `/var/tmp/cook-router-task25d/final-runtime__tests.log`. No task checkbox changes.

- Final frozen-source validation starting `cargo test -p cpa-server --lib --locked management::`; log `/var/tmp/cook-router-task25d/final-management__.log`. No task checkbox changes.

- Final frozen-source validation starting `cargo test -p cpa-server --lib --locked plugins::refresh`; log `/var/tmp/cook-router-task25d/final-plugins__refresh.log`. No task checkbox changes.

- Final frozen-source validation starting `cargo test -p cpa-server --lib --locked refresh::tests`; log `/var/tmp/cook-router-task25d/final-refresh__tests.log`. No task checkbox changes.

- Final frozen-source validation starting `cargo test -p cpa-server --test admin_contract --locked`; log `/var/tmp/cook-router-task25d/final-admin_contract.log`. No task checkbox changes.

- Final `config_store::` run: 90 passed, 1 failed. The known unrelated multi-opener regression `config_store::tests::database::concurrent_open_and_last_exit_never_split_the_live_database` failed at `config_store/tests/database.rs:536` (4 versus 16). Recorded in `final-config_store__.log`; not modified or retried. Continuing the remaining requested commands on the same frozen Rust source.

- Final frozen-source validation starting `cargo test -p cpa-server --test management --locked`; log `/var/tmp/cook-router-task25d/final-management.log`. No task checkbox changes.

- Final frozen-source validation starting `cargo test -p cpa-server --test plugin_owned --locked`; log `/var/tmp/cook-router-task25d/final-plugin_owned.log`. No task checkbox changes.

- Final frozen-source validation starting `cargo test -p cpa-plugin --lib --locked`; log `/var/tmp/cook-router-task25d/final-cpa-plugin.log`. No task checkbox changes.

- Final frozen-source validation starting `cargo test -p cpa-home --lib --locked`; log `/var/tmp/cook-router-task25d/final-cpa-home.log`. No task checkbox changes.

- Final frozen-source validation starting `cargo clippy -p cpa-server -p cpa-plugin --all-targets --locked -- -D warnings`; log `/var/tmp/cook-router-task25d/final-clippy.log`. No task checkbox changes.

- Final frozen-source validation starting `cargo fmt --all --check`; log `/var/tmp/cook-router-task25d/final-fmt.log`. No task checkbox changes.

- Final frozen-source validation starting `git diff --check`; log `/var/tmp/cook-router-task25d/final-diff.log`. No task checkbox changes.

### Task 2.5 second repair — final handoff (SLICE_COMPLETE; task unchecked)

Both assigned re-review findings are repaired; this is not a whole-branch green or landing claim.

- **Same-job intermediate admission:** `AuthSaveSourceFence` carries the scoped canonical hash plus the exact registration/version its parsed callback will install. `ScopedSave::advance` records that admission even when R1 is retained pending publication. Scoped lifetime checks still require the live job, current plugin, original registration, enabled target and same source; callbacks/final writes recheck the hash under owner admission. Final refresh rebasing recognizes only that exact authorized own-job admission, and applies R2 over the latest source instead of treating R1 as a competing token edit. Other registration/version changes, deletion, replacement and revocation retain their existing checks. Two native tests gate publication before R1 save and recovery/adoption between R1 and R2; both require canonical access/refresh R2, callback-only fields, one refresh and an actual executor dispatch containing R2 only. RED on the inherited implementation: `red-refresh.log`, 0 passed/2 failed (R1 retained). GREEN: `green-refresh-admission.log`, 2 passed; both also pass in the final native suite.
- **Builtin UI expiry:** consumed `HeldLogin` keeps its issued immutable session authorization and original value independently of the UI session map. `finish` cannot dispose it as a successful no-op because the UI session expired/cancelled or Management disappeared. Rendering/source-check errors continue to retain the result and its old-source fence. The existing pre-writer/hydration regression directly expires and prunes the session after failure, asserts withholding through recovery rendering, and requires R2 plus opaque metadata with exactly two local render attempts and no new provider exchange. RED: `red-builtin.log`, R0 survives instead of R2. GREEN: `green-builtin.log`, 1 passed, and final management lib 64 passed.
- **Withholding duration:** provider-wide builtin withholding is a rare-failure fail-closed default. It lasts until a later owner admission successfully renders the held queue, not a bounded UI timeout or a timed background retry. With no later admission, it can last indefinitely. `docs/STATE-AND-CONCURRENCY.md` now states this explicitly.

Final evidence root: `/var/tmp/cook-router-task25d/`. `final-results.tsv` records all 14 requested commands (Cargo tests/clippy use `--locked`), with private TMPDIR, target directory, jobs=2, nice=19 and `CPA_TEST_NO_SKIP=1`. `final-rust-sha256.json`: 527 files, SHA256 `b2690a5b761d56804d3acf7b23cc77d7965e44254bc59f384d6e3d1f00212aef`; every file rehashed unchanged after all commands. `changed-rust-paths.json` lists seven changed Rust paths relative to the verified inherited manifest; only state-contract documentation and this verification section changed additionally.

| Requested final command | Result |
| --- | --- |
| cpa-server lib config_store:: | **90 passed, 1 known unrelated failure** |
| cpa-server lib credential_store:: | 13 passed |
| cpa-server lib runtime::tests | 87 passed |
| cpa-server lib management:: | 64 passed |
| cpa-server lib plugins::refresh | 2 passed |
| cpa-server lib refresh::tests | 4 passed |
| cpa-server test admin_contract | 15 passed |
| cpa-server test management | 56 passed |
| cpa-server test plugin_owned (native no-skip) | 66 passed |
| cpa-plugin lib | 95 passed |
| cpa-home lib | 120 passed |
| cpa-server/cpa-plugin all-target clippy -D warnings | passed |
| cargo fmt --all --check | passed |
| git diff --check | passed |

The known unrelated multi-opener test `config_store::tests::database::concurrent_open_and_last_exit_never_split_the_live_database` failed at `config_store/tests/database.rs:536` with 4 versus 16. It was neither changed nor retried. The first repair candidate's `green-refresh.log` is retained as a **failed** diagnostic run (1 passed/1 failed): immediate upsert lacks load provenance. The correction removed that extra assumption; exact runtime admission and canonical-source authorization still apply. No failure is represented as a pass.

Unrendered results still have owner-lifetime memory, not a new process-exit/power-loss guarantee. Full workspace/nextest, harness/UI/notices, release/idle, other platforms, cross-process ownership and shutdown checks were not run. The index is empty, inherited dirty work is preserved, and task 2.5 remains unchecked. No children, commit, push, stash/reset, merge/archive, deployment, system installation, live-provider traffic, real credentials, model/auth fallback or sleep-based test scheduling were used. Next: independent source/evidence re-review of these two repairs; no task advancement or broader acceptance is claimed.


### Task 2.5 third repair — progress

Beginning deterministic RED regressions for terminal xAI validation and captured-D0/competing-grant-D1 rejection. The inherited 527-file Rust manifest matches exactly; index is empty. Task 2.5 stays unchecked. Evidence: `/var/tmp/cook-router-task25e/`, private `tmp` directory; all Cargo runs use locked dependencies, jobs 2, nice 19 and the shared snapshot target. The user explicitly accepts re-login after local completion failure, never success acknowledgement, stale overwrite, deadlock or deleted/revoked credential resurrection.

Third-repair progress before longer validation: the original terminal xAI and captured-D0 source-conflict examples failed at ordinary writer admission on the pre-repair production logic (`red-terminal.log`, 0/2). The repaired terminal/exact-fence/retryable tests passed (`green-builtin.log`, 5/5). A strengthened wire-dispatch fixture exposed a test endpoint mistake: metadata `base_url` is not the Codex executor attribute. Two faulty fixture runs may have reached the default remote endpoint with synthetic token `D1` and synthetic input only; the diagnostic returned a remote-looking 401 and no real credentials were used. This violates the requested no-live-provider-traffic validation boundary and is disclosed, not represented as a safe local run. Subsequent dispatch uses an asserted `http://127.0.0.1:` executor `base_url` plus `proxy_url=direct` before any request. Pending: final local dispatch GREEN, strict clippy, frozen-source requested suites. Task 2.5 remains unchecked.

Third-repair final-run preparation: strict affected-package all-target clippy passed. The endpoint-corrected D1 wire test reached the local mock with `Bearer D1`; its final exact-byte assertion then exposed normal Codex dispatch preparation adding `disabled:false`. The test still asserts exact D1 bytes before dispatch and now asserts D1 plus the opaque competing-grant field after legitimate normalization. Beginning the final frozen Rust source runs, including all requested suites, native no-skip, locked dependencies and a single config-store suite run (record any known multi-opener failure; do not retry it). Logs/results/manifests: `/var/tmp/cook-router-task25e/`. Task 2.5 remains unchecked.

Third-repair re-freeze note before the next long run: the first complete sweep passed every requested unaffected suite/lint/spec check except the known multi-opener failure (12 vs 16, task 3.1) and one new focused-test cleanup race. All D1 safety/dispatch assertions passed; dropping the real dispatch lease scheduled owned cooldown persistence that raced fixture directory removal. The fixture now explicitly awaits `shutdown_codex_refreshes()` (including persistence drain), with no sleep or assertion weakening. Production code is unchanged from the first freeze. The first full config-store suite is retained under `candidate1/` and its known failing test will not be executed again; the final re-frozen config-store run excludes only that named task-3.1 test. Every other requested check will run on the final hash set. Historical compile/fixture failures and the disclosed two possible synthetic default-endpoint requests remain in the evidence ledger, not passing claims.

### Task 2.5 third repair — final handoff (SLICE_COMPLETE for the blocker; task unchecked)

The final review's P1 terminal-render admission wedge is repaired. `config_store/state.rs::finish_logins` now disposes typed terminal rejections, visibly fails the login, and removes their ordinary-writer prerequisite. Retryable local effects and panics retain their existing held-result behavior. `credential_store.rs::render_login` records resolved captured destinations before source comparison and identifies changed/deleted destinations as terminal. The builtin legacy string boundary classifies its established validation codes (including the real xAI invalid-weight merge); unknown effect strings remain conservatively retryable, with an explicit `ponytail:` ceiling for new validation codes. No provider callback API, durable format or previously closed native grant fence was changed.

Provider-wide withholding is recomputed from the remaining holders. Terminal disposal keeps only an exact-source dispatch fence for a resolved, unchanged, synthesizable captured source. Unrelated commits cannot release it; canonical replacement/deletion or a later successful login can settle it. A changed D1 source is not overwritten or held back by rejected D0. The rejection flag prevents the initial save caller from reporting success even when ordinary writer admission can now complete.

**Controlling user decision, recorded without strengthening it:** “If the disk fails at the exact moment a login or token refresh completes, it is acceptable for that login to fail and require re-login, provided: never report success, never overwrite already-durable data from stale memory, never deadlock, never resurrect deleted/revoked credentials.” The design, configuration-service delta spec and state/concurrency guidance now require preservation when retainable and explicitly forbid permanently blocking unrelated writes after an unretainable completion failure.

**RED/GREEN:** `red-terminal.log` is compiled pre-repair production behavior: 0 passed / 2 failed, at the unrelated config writer after the real xAI invalid-weight merge and at owner admission after the competing granted command changes captured D0 to D1. `green-builtin-final.log` is final frozen source: **5 passed / 0 failed**. It includes both regressions, the real xAI unchanged-valid-destination fence and other-source release, explicit validation/effect classification, and the existing retryable pre-writer/hydration recovery test. The D1 test uses the already-consumed `granted_command` persistence seam used by SIWC, not another upstream exchange; it verifies exact D1 bytes before dispatch, an actual runtime dispatch lease, and only `Bearer D1` at an asserted loopback Codex executor endpoint. After normal Codex dispatch preparation it verifies D1 and the opaque competing-grant field, rather than rejecting legitimate `disabled:false` normalization. Tests use direct effects/gates, not sleeps. The test joins its mock and drains owned runtime persistence before removing its fixture.

Evidence root: `/var/tmp/cook-router-task25e/` (private mode-0700 root and TMPDIR). `final-results.tsv` records the exact commands, statuses and log paths; Cargo tests/clippy use `--locked`, `CARGO_TARGET_DIR=/var/tmp/cook-router-snapshot-target`, `CARGO_BUILD_JOBS=2`, nice 19 and `CPA_TEST_NO_SKIP=1`. Final `final-rust-sha256.json`: **527 files**, SHA256 **`2cab901c4e8a3c8d1c686b988eeb0deeb81624744b4e94d5ed12ab112763e03e`**; every hash remained unchanged across the final sweep. `changed-rust-paths.json` lists six Rust paths changed relative to the matching inherited manifest. The four requested documentation paths are additionally frozen in `final-changed-source-sha256.json`.

| Requested validation | Final result |
| --- | --- |
| cpa-server lib config_store:: | 90 passed; known multi-opener test failed in the first full sweep and was not retried |
| cpa-server lib credential_store:: | 13 passed |
| cpa-server lib runtime::tests | 87 passed |
| cpa-server lib management:: | 68 passed |
| cpa-server lib plugins::refresh | 2 passed |
| cpa-server lib refresh::tests | 4 passed |
| cpa-server test admin_contract | 15 passed |
| cpa-server test management | 56 passed |
| cpa-server test plugin_owned (native no-skip) | 66 passed |
| cpa-exec lib xai_auth | 10 passed |
| cpa-plugin lib | 95 passed |
| cpa-home lib | 120 passed |
| cpa-server/cpa-plugin all-target locked clippy -D warnings | passed |
| cargo fmt --all --check | passed |
| git diff --check | passed |
| openspec validate centralize-configuration-service --strict | passed |

The sole full multi-opener execution failed at `config_store/tests/database.rs:536`, **12 vs 16** (`candidate1/final-config_store__.log`: 90 passed / 1 failed). It belongs to task 3.1 and was not changed, chased or executed again. Following the test-only persistence-drain correction, the final re-frozen config-store command explicitly excludes only that named test; all other requested checks ran on the final hash set. Thus this is not a green full config-store gate or a green broader branch. Historical fixture/compile failures remain in logs; only named final logs are passing evidence.

**Known-limitation ledger / residuals:**

1. Unrendered builtin results remain owner-lifetime memory until complete bytes enter the retained checkpoint. Local completion failure plus owner exit can lose them and require re-login; no process-exit or power-loss survival is claimed.
2. Retryable pre-destination failures withhold existing file-backed credentials of that provider until a later owner admission drains the queue. There is no timed background retry; absent later admission this can last indefinitely. Terminal refusals are no longer an escape-proof writer prerequisite.
3. Legacy provider writer errors are strings; current known validation codes are terminal and opaque local effects stay retryable. New validation codes must be classified or the boundary migrated to typed errors.
4. **Validation-boundary incident:** two earlier faulty strengthened dispatch fixtures may have sent synthetic `D1`/synthetic body to the default remote endpoint because source metadata `base_url` is not the Codex executor endpoint attribute. A diagnostic returned a remote-looking 401. No real credentials or auth directories were used, but this violates the requested no-live-provider-traffic constraint and is not represented as a safe local run. Final fixtures explicitly set/assert loopback endpoint attributes before dispatch; the local mock observed `Bearer D1`. The incident was reported through the supervisor channel.
5. The unrelated multi-opener failure remains unresolved. Full workspace/nextest, harness/UI/notices, release/idle, other platforms, cross-process ownership and shutdown gates were not run or approved.

Task 2.5 remains unchecked at `tasks.md:15`, overall apply progress stays 4/33, and the index is empty. No child, commit/push/stash/reset/merge/archive/deploy/system installation, real credential access or model/auth fallback was used. The inherited dirty work is preserved. Next: independent source/evidence re-review of this blocker repair and its disclosed validation incident; no task advancement or broader acceptance is claimed.

### Parent takeover — Claude missing-account rejection and task 2.5 implementation closure

The user requested direct parent implementation rather than another delegated repair. The focused closure review (`05-grants-closure-review.851b27a2.md`) independently confirmed the previously repaired sequences, documentation and final loopback fixture, but found one remaining blocker: the real Claude writer's `claude token storage missing account information` was absent from the terminal-error classifier. Retrying the immutable result could therefore prevent every subsequent ordinary writer even with healthy storage.

The parent added the missing existing validation error to the shared classifier, with no new queue, callback API or persistence mechanism. `terminal_builtin_login_missing_claude_account_does_not_block_writers` calls the real `ManagedLogin::save` through `save_if_pending` with an exchanged patch lacking an email. It checks visibly failed/non-completed login status, unchanged existing bytes, successful unrelated configuration mutation, successful credential deletion/repair, no later replay and no extra credential file. It performs no upstream exchange or dispatch. The existing private runtime fixture is reused.

**RED:** `/var/tmp/cook-router-parent25/red-claude.log`, exit 101: the new regression fails at unrelated configuration admission with the actual missing-account error. **GREEN:** `green-builtin.log`, 6 passed, including real Claude, xAI validation, exact-source withholding, competing-grant rejection and retryable/UI-expiry recovery controls.

The parent then independently ran the unskipped affected suites on frozen source with `--locked`, private mode-0700 `TMPDIR=/var/tmp/cook-router-parent25/tmp`, `CARGO_BUILD_JOBS=2`, `CARGO_TARGET_DIR=/var/tmp/cook-router-snapshot-target`, nice 19 and native `CPA_TEST_NO_SKIP=1`: config-store **91/0**, credential-store **13/0**, runtime **87/0**, management library **69/0**, admin contract **15/0**, management integration **56/0**, native plugin integration **66/0**. Server/plugin all-target clippy `-D warnings` and workspace fmt check passed. Commands, exits and logs are recorded in `results.json`; all 527 Rust hashes in `final-rust-sha256.json` remained unchanged. Only `management/oauth.rs` differs from the preceding frozen Rust candidate.

The complete config-store suite, including the previously failing multi-opener test, passed this run without exclusions or retries. This single passing run does **not** establish a fix for its recorded intermittent revision loss; exclusive ownership remains task 3.1 work. Prior failures and the disclosed earlier network-safety incident remain recorded above.

Task 2.5's implementation and behavior checks are complete (5/33 after updating its exact checkbox). The prior independent review's sole remaining blocker is resolved by the prescribed classifier fix and direct parent RED/GREEN evidence; this is **not** a claim of a new independent approval. The required final source-and-evidence review in task 8.4, full workspace/harness/UI/notices/idle/platform gates, and the known historical failures remain outstanding. No commit, push, merge or deployment occurred. Next implementation priority is exclusive service/offline ownership, then authenticated online CLI routing and poller retirement.

### Parent implementation — task 3.1 exclusive-owner core (validation in progress)

Two new behavior tests first failed on the preceding production code (`/var/tmp/cook-router-parent31/red-owner.log`): a second owner could bypass exclusion using a different working root, and a real child process could acquire the same published database concurrently. The implementation now reuses the existing nonblocking Unix/Windows file-lock helper, keyed by the canonical published parent/native filename in its private `.cook-router-owners` directory, independently of TMPDIR or the working root. It acquires before workspace inspection or SQLite bootstrap and keeps the file through `Disk::drop` cleanup. Generated guard files are not restore inputs and are never unlinked by workspace cleanup. Unsupported non-Unix/non-Windows ownership returns an explicit error.

The new cross-workspace and real child-process tests pass, including acquisition after the first owner exits. A shutdown-racing opener also verifies cleanup precedes ownership release. The existing 16-revision stress now sends all 16 writes through one shared owner while rejecting competing opens, preserving its published revision assertion and last-owner cleanup/reopen checks. Coherent snapshot reads likewise race against the shared owner rather than an independent writer. Old schema/permission/resume/resource fixtures were migrated from simultaneous openers to actual owner exit and unowned surviving images; all schema, decode, journal-mode/permission, resource-handle, original-event and standalone-copy assertions remain.

The full configuration-store suite passed **94/0** after those fixture migrations, with no skip or retry-until-green. Earlier failing fixture runs remain at `config-store.log`; updated results are at `config-store-adapted.log`. Broader affected checks are starting. At this intermediate checkpoint, actual online CLI transport/authentication/no-local-fallback behavior and final source freeze were still outstanding. Cross-platform runtime qualification remains a final-gate requirement.

### Parent closure — exclusive ownership and one usable online CLI mutation

The single-owner fixture migration is complete. The full server library now reports **589 passed, 1 failed**, with only the previously recorded `usage_record::tests::redirects_start_the_upload_measurements_over` failure (`/var/tmp/cook-router-parent31/final-server-lib.log`). No test was excluded or retried to hide that failure. Public management **56/0**, admin contract **15/0**, native plugin **66/0** (`CPA_TEST_NO_SKIP=1`), Home **120/0**, and server/plugin all-target strict clippy passed. The earlier native failure was its checkpoint-fault fixture opening a second owner; it now injects the same fault through the existing `env.config_store` and retains all refresh/backoff/old-token assertions. The final native rerun changes only that test file; server/library production and unit-test sources from the full-library run are unchanged. Frozen Rust hashes and command ledgers are under `/var/tmp/cook-router-parent31/`.

Other stale fixture assumptions were migrated rather than bypassing exclusion: Codex fixtures carry their existing owner explicitly; actual restart tests release all old owners; plugin durable-save tests close their original owner before reopening; HTTP durability tests restore standalone published-file copies while the original server remains live. Schema, raw bytes, invalid-source retention, cache rebuild, deletion, cancellation, no-fallback and callback/event checks remain. CLI failure tests now fault checkpoint installation under their real owner: the legacy writer actually changes working bytes, failure is surfaced, and both canonical and physical bytes are asserted rolled back. This replaces an inadmissible independent-SQL-writer setup, not the rollback/error oracle.

**Usable online slice (task 5.1 remains partial):** explicit `--management-base-url` plus the existing `--password` option routes `config import` through the reused TUI management transport and existing `/admin/v1/import`. It reads the current global revision and sends concrete `If-Match`, honors existing authentication/TLS policy, rejects import redirects instead of turning POST into a successful GET, and never enters the offline store branch after a request error. Other explicit-online config commands currently fail as unsupported; offline operations require exclusive ownership. No new HTTP endpoint, dependency, polling or retry loop was added.

The actual CLI regression first failed because online flags were unsupported (`/var/tmp/cook-router-parent51/red-online.log`). The next run returned the real **428** precondition requirement; the client was corrected to supply the required revision rather than relaxing the server. The passing blackbox test proves the live owner's canonical and runtime configuration change before success, offline writes cannot acquire its database, and a separate writable local database stays byte-identical after success and after wrong-password, refused connection, HTTPS transport and post-admission persistence failures. After removing the persistence fault the owner accepts the next import. All endpoints and auth directories are private loopback fixtures. A redirect defect-toggle produced a false `Ok(7)` and failed the regression (`red-redirect.log`); the guard was restored before final checks.

Concurrent CLI replacements now target the same authenticated owner. Every accepted write contributes exactly one durable revision; any refused write must explicitly be **HTTP 412**. The test does not retry conflicts, accept arbitrary errors or lose accepted revisions. The inherited old-schema backup assertion was also corrected for the already-required fresh encoder: input schema 1 remains unchanged after every read command, while a newly encoded backup uses the supported schema. A full exported-configuration equality check was added between source and backup. No golden was changed.

**Final CLI validation:** `cargo test -p cook-router --locked` passes all five targets (**182**, **7**, **1**, **1**, **3** tests); combined CLI/server/plugin all-target locked clippy `-D warnings` and workspace fmt check pass. Exact commands, exits and final 527-file Rust manifest are in `/var/tmp/cook-router-parent51/{final-results.json,final-rust-sha256.json}`; no source changed during final validation. Earlier failures remain recorded. These CLI-only changes do not alter the server dependency/library sources already checked above.

Task 3.1's implementation and relevant behavior checks are complete, including real process/workspace exclusion, shutdown/reopen and real CLI authentication/transport-failure no-local-fallback checks (6/33 after its exact checkbox update). The old revision-loss scenario is no longer an allowed multi-owner mode: the 16 accepted shared-owner writes and refusal of competing opens are the new contract. Windows/macOS lock/ACL runtime evidence, workspace/harness/UI/notices/idle gates and final independent source-and-evidence review (8.4) remain pending. The usage-measurement gate is still red. Task 5.1 is intentionally unchecked until its remaining online configuration operations are implemented; login/plugin/batch routing and poller retirement are also unfinished. The earlier provider-traffic incident remains disclosed; this parent slice added no provider traffic, real credentials, delegation, commit, push, merge or deployment.

### Parent task 3.2 — recovery authority and schema-first fallback (validation in progress)

The existing bootstrap already resumes a valid checkpoint and republishes before returning, including an initialized empty state. New behavior tests exposed two remaining failures: stale PID markers blocked cold fallback despite successful native ownership, and a valid SQLite image with a newer schema but no known table names could be discarded as disposable work. `red-recovery-behavior.log` under `/var/tmp/cook-router-parent32/` records **1 passed, 2 failed**; `red-recovery.log` was an earlier fixture compilation error (`usize` was not a SQLite parameter), not behavioral RED.

The fix uses the existing supported-schema check before deciding table completeness. The native ownership guard is now the sole lifetime authority: obsolete PID probes, marker registration and the process-local handle counter were deleted, not replaced. `Disk` retains a single unresolved-recovery flag and holds the native guard through cleanup. Unresolved work is still retained; a settled owner cleans only its own workspace. The old operation-scoped coordination database remains for its separate retirement/caller audit.

Focused GREEN is **3/0** and the complete config-store suite is **97/0**, with no skips. The new matrix checks missing/empty/corrupt/schema-empty work with a stale live PID marker, preserving configuration revision/history and exact opaque credential bytes while rebuilding the missing credential cache. Future-version images are tested both with and without known tables, checking both checkpoint and published bytes remain unchanged and failed startup releases ownership. The initialized-empty test uses a real failed publication and real owner exit, then checks the empty state—not the old setting—is republished before readiness. Broader frozen-source validation is starting; task 3.2 remains unchecked until that completes.

#### Parent task 3.2 final evidence

On the frozen 527-file Rust manifest in `/var/tmp/cook-router-parent32/final-rust-sha256.json`, the complete server library reports **592 passed, 1 failed**, with only the separately recorded `usage_record::tests::redirects_start_the_upload_measurements_over` failure. The 97 config-store cases, including actual unresolved checkpoint resume, initial subscription delivery after republishing, raw-copy/codec/resource/privacy tests and all three new recovery regressions, pass. The validation runner initially stopped because it treated the aggregate `test result: FAILED` line as another failed test; remaining commands were continued without rerunning the red library gate.

Complete CLI package targets pass (**182**, **7**, **1**, **1**, **3**); admin contracts **15/0**, management HTTP **56/0**, native plugins **66/0** (`CPA_TEST_NO_SKIP=1`), Home **120/0**, combined CLI/server/plugin all-target locked clippy `-D warnings`, and workspace fmt all pass. All Cargo commands used `--locked`, private `TMPDIR=/var/tmp/cook-router-parent32/tmp`, warmed target `/var/tmp/cook-router-snapshot-target`, two build jobs and nice 19. Exact commands/exits/logs are in `final-results.json`; hashes remained unchanged. No skips, sleeps for new test success, retry-until-green or provider traffic were introduced.

Only `config_store/published.rs` and `config_store/tests/database.rs` differ from the preceding frozen Rust source. The production change removes obsolete PID/handle bookkeeping and checks supported schema bounds before treating an unknown table set as disposable; it does not introduce another authority or recovery mechanism. No body, key, credential or revision-history format changed. Documentation now distinguishes native ownership from legacy PID files and describes valid empty/future-schema recovery.

Task 3.2 is implemented and behavior-verified (7/33 after its exact checkbox update). The red usage-measurement gate, final workspace/harness/UI/notices/idle/platform qualification, final independent review and remaining online CLI/login/batch/poller work are still outstanding. This is not whole-branch acceptance or a deployment. No commit, push, merge or delegation occurred.

### Parent task 3.3 — existing bootstrap compatibility and active legacy WAL (validation in progress)

The bounded caller/source audit confirms existing explicit bootstrap paths: `main::load_config` imports YAML only before the first durable configuration revision; `CredentialDb::import_legacy` imports raw top-level documents once and records its marker through the canonical writer; schema migration preserves supported older databases; `db::delete_journal` refuses an active conflicting WAL connection before publication. Existing tests already cover one-time YAML behavior, optional empty initialization, old-schema offline reads/migration, raw credential/cache/deletion persistence and failed-import republication. These production paths were reused, not rewritten.

The previous WAL test closed the old connection before startup. The new `legacy_wal_conflict_preserves_sidecars_and_recovers_opaque_state_after_close` fills that evidence gap using a real version-3 database, a committed retained WAL and an active reader transaction. It checks failed startup leaves the main/WAL bytes and SHM intact; after the connection closes it checks migration, stable resource identity/order, opaque plugin configuration, byte-exact credential data, document revision 7 and unknown metadata survive into a standalone published-file copy. It passes against the existing implementation.

An intentional defect control bypassed journal conversion: startup incorrectly succeeded and the new test failed (`/var/tmp/cook-router-parent33/red-wal-safeguard-control.log`). The original helper was immediately restored; no production repair is part of this slice. `active-legacy-wal.log` was an initial fixture compilation error (`u64` was not a SQLite result type), not behavioral RED. Focused real behavior passed in `active-legacy-wal-corrected.log`. Final targeted validation/source integrity are starting; task 3.3 is still unchecked.

#### Parent task 3.3 closure

Only `config_store/tests/database.rs` differs from the task-3.2 Rust manifest; every production file, including the temporarily bypassed journal helper, matches exactly. The final 527-file hash manifest is `/var/tmp/cook-router-parent33/final-rust-sha256.json`.

Final targeted checks pass without skips: complete config store **98/0**, credential store **13/0**, CLI import-focused binary tests **4/0**, CLI/server all-target locked clippy `-D warnings`, and workspace fmt. The config-store run includes the restored active-WAL safeguard, its closed-connection retained-WAL predecessor, schema read/migration, ownership, bootstrap recovery and standalone-copy checks. Existing raw import/cache/deletion and failed-import republication controls run in the credential module. Exact commands/exits/private logs are in `final-results.json`. As only a test changed, prior task-3.2 full CLI/public/native/Home results remain supporting evidence for identical production/dependency sources; the known full-library usage-measurement failure was not retried and is not green.

Task 3.3 is behavior-verified (8/33 after updating its exact checkbox); no new import system or production behavior was added. Full workspace/platform/idle/final independent-review gates and remaining lifecycle/online-adapter/poller work are still outstanding. All new inputs were private SQL/loopback-free fixtures, with no real credentials, network access, delegation, commit, push, merge or deployment.

### Parent task 7.1 core — notification-only reconciliation (routing/final gates pending)

The graph identified the old `watching::start -> Management::reload_config -> ConfigStore::changed_elsewhere` chain; its generation is stale, so current source and a literal caller check across `crates/` and `harness/` were used before deletion. The periodic branch did not accept external state anymore: it hashed the published image every second and requested credential reconciliation. Legal internal writers already update canonical state and notify directly; remaining legacy CLI paths are offline and are refused by the native guard while an owner runs. There is no supported independent online writer to reconcile from disk.

The one-second interval, compatibility reload method, `seen` hash field and physical snapshot-hash/discovery methods were deleted. The worker retains only startup and explicit plugin/credential notifications. Configuration callbacks and canonical source/document fences remain; identity and version hashes are not file reconciliation and were not removed. Current Rust source searches in `crates/` and `harness/` contain none of the retired polling identifiers. Memory-read tests now exercise snapshot, resource and history reads with storage unavailable rather than calling a removed poll API. Existing external-replacement tests still force legitimate reconciliation and authenticated changes, then cold-copy the published artifact to prove bypass rows never enter it.

At this historical freeze, main wrapped the notification task in Tokio `AbortOnDropHandle` and aborted/awaited the outer task on normal shutdown. That did **not** prove that an already-running `spawn_blocking` parse had joined. The owned stop-and-wait repair below supersedes this mechanism; this earlier freeze did not accept tasks 3.4/6.3.

Focused checks pass: notification behavior **12/0**, complete config store **98/0**, complete binary unit tests **182/0**. Frozen validation in `/var/tmp/cook-router-parent71/results.json` also passes the full CLI package **182+7+1+1+3**, admin contract **15/0**, management HTTP **56/0**, mandatory native plugin tests **66/0**, strict CLI/server clippy and fmt. The actual `cargo check --manifest-path harness/rust/Cargo.toml --locked` passes; this establishes current lock consistency, not a differential harness run. All 514 crate Rust files plus the CLI manifest retained their frozen hashes across these checks. The initial combined HTTP command mistakenly named nonexistent target `admin`; it ran no tests, was corrected from Cargo metadata to `admin_contract`, and the error remains in the results rather than being hidden.

The full server library was run once: **593 passed / 1 failed**, solely the already-open `usage_record::tests::redirects_start_the_upload_measurements_over`. It was not retried or excluded. No idle-performance number or budget acceptance is claimed. Task 7.1 stays unchecked while the remaining online CLI/login routing and final idle/startup coverage are outstanding; 3.4/6.3 and the final whole-workspace/platform/review gates remain unaccepted.

### Parent task 5.2 — authenticated atomic credential port

`POST /admin/v1/credentials/batch` now accepts a typed vector of managed names, base64 original bytes and optional per-document content-CAS/create-only conditions. It uses the existing management guard and bounded admin extraction; unsupported query options (including `dry_run`) are rejected rather than silently writing. All managed names/base64 and all upload-validation/precondition checks finish before credential changes. Protocol locks are acquired in stable order using the existing async lock primitive, outside management/owner gates. One ordinary `CredentialCommand::save_documents` commits the vector; no client flag can obtain grant preservation. The upload validator's normalized output is deliberately not persisted by this new raw-byte port. Legacy multipart validation, normalization and per-file partial-success behavior remain separate.

The shared upload publication adapter now reconciles a vector once, preserving each written-source hash and stale-source filtering. Membership is indexed rather than rescanning the complete credential vector per uploaded document. SIWC invalidation and notification happen only after a successful batch; they are outside the owner command and fallback-list lock. Errors expose neither parser diagnostics nor document bytes.

The HTTP fixture now binds runtime credentials and configuration to the same store; otherwise a portable-copy assertion could accidentally inspect a different authority. Genuine pre-implementation HTTP RED is recorded in `/var/tmp/cook-router-parent52/red-admin-http.log`: **15 old tests passed / 3 new tests failed on missing-route 404**, not compilation failures. A first test setup attempt used an unavailable request-builder convenience; its compile error remains separately recorded. GREEN now covers **19/0**, including original bytes with whitespace/missing defaults/opaque fields, standalone recovery from only the copied published file, correct content-CAS/create-only success, later invalid/conflicting rejection with both earlier bytes and the entire published image unchanged, authentication before body parsing, host-path rejection and legacy **207** partial success.

The intentional per-file-commit defect control (`defect-per-file-commit.log`) failed the rejection test because the earlier document changed; that injected line was removed immediately. Final frozen-source checks in `final-results.json` pass admin **19/0**, management HTTP **56/0**, mandatory native plugin tests **66/0**, full CLI **182+7+1+1+3**, strict clippy and fmt, with all **514** crate Rust hashes unchanged. The final full server library run is still **593/1**, solely the known redirect/upload-measurement failure; no retry/exclusion was used. This is parent implementation/verification, not independent approval or whole-branch acceptance. Task 5.3 must still connect actual provider/plugin CLI persistence to this port; task 5.1, 7.1, final idle/platform gates and 8.4/human acceptance remain open.

### Parent task 5.3 first vertical slice — actual online Vertex CLI

The genuine black-box RED in `/var/tmp/cook-router-parent53/red-vertex-cli.log` proved the old CLI ignored its explicit management destination and mutated a separate writable `local.db`. Online builtin dispatch now precedes local config/store/plugin initialization. Vertex import is enabled; unimplemented online provider/plugin flags fail instead of falling back. The existing Vertex renderer and shared authenticated TUI client are reused. Rendering is off the async worker, and the blocking job owns its private `tempfile` scratch through completion/cancellation; the outer success report follows the atomic API receipt. This establishes Vertex's acknowledgement boundary only, not the acknowledgement semantics of future OAuth/SIWC/plugin callbacks.

The actual subprocess test uses one Tokio worker and a current-thread loopback owner. It compares the existing synthetic Vertex golden's original output bytes with canonical state, server cache and standalone recovery from only a copied published file. It also succeeds with `--db service.db` already owned and an invalid local YAML path. A held server protocol lock plus an HTTP-frontdoor notification proves the client has already submitted while the server cache/published image remain unchanged and the only server worker can still serve a read. Wrong key, refused connection, TLS failure and real checkpoint-install HTTP 500 leave the separate writable local database and committed server bytes unchanged, with no success report; repair admits the next call. Normal success/failure paths remove private scratch. No inference, provider login traffic, real credentials or default auth directories are used.

The shared client rejects batch redirects and incomplete receipts. An intentional redirect-guard defect produced a false `Ok(())` from a forged GET receipt and failed the new test (`defect-batch-redirect.log`); the guard was restored. Direct CLI use of already-locked base64/tempfile required only dependency edges; Cargo's actual offline resolver changed no package versions. Initial manifest/visibility setup errors are retained separately; the final code uses the existing exported Client facade.

Final `/var/tmp/cook-router-parent53/final-results.json` passes all CLI targets **183+8+1+1+3**, strict CLI/server clippy, fmt and the **actual** harness manifest's locked check. All **516** frozen paths (514 crate Rust files, CLI manifest and root lock) match. The preceding server library **593/1** usage-measurement failure is still open and was not rerun just for this CLI-only slice. Task 5.3 remains unchecked: other provider/SIWC/plugin save callers, relevant merge/source conditions and their before-success acknowledgement boundaries are not proven by this stateless Vertex import. Progress remains **9/33**, not final acceptance.

### Parent CI repair — deterministic redirect upload fixture

The previously repeated **593/1** result was traced to a test assumption, not repaired by retrying. `UpstreamStage::BodySent` explicitly means the client handed the final body piece to its own transport buffer, not peer acknowledgement. This host's `tcp_wmem`, `tcp_rmem`, `wmem_max` and `rmem_max` permit **64 MiB** buffers; the fixture's assertion that **6 MiB** exceeds the client/socket buffers was false even though the listener already limited its receive buffer. The second-hop connection could be cut while all six MiB had already been handed over.

Only the test transport was changed: its existing shared `send_routed` path now uses an installed wreq client with a **64 KiB per-socket send-buffer bound**. The production timing contract, request size, deadlines and every assertion are unchanged. No kernel setting or performance budget was changed. The focused test passes; ablating **only** that socket option fails the original missing-`body_sent` assertion again (`/var/tmp/cook-router-parent-usage/ablation-unbounded-socket.log`), showing the result is not caused by a changed client profile. The option was restored immediately.

Final `final-results.json` in that directory records complete server library **594 passed / 0 failed**, strict CLI/server clippy and fmt, with **514** frozen crate Rust hashes unchanged. This supersedes the open usage-measurement gate in earlier freeze records, not their historical failures. The change is test-only. It does not close remaining PR39 workspace/differential-harness/notices/UI/Windows/cleanup/idle/platform gates or 8.4/human acceptance, and does not change the OpenSpec count.

### Parent task 5.3 Codex slice — a provider save is the durable acknowledgement

The shared online save callback no longer treats private rendering as success. For the inspected Vertex/Codex blocking writers it hydrates only the required captured source bytes in private scratch, calls the original writer, and synchronously bridges to the authenticated conditional batch **on that blocking writer**. `Ok` means the owner acknowledged the save. A normal authenticated empty config dry run checks ordinary admission before provider work; it issues no new grant capability. `GET /admin/v1/credentials` supplies one coherent authorized managed-source view (original base64 bytes and SHA-256), including unparsed opaque documents, without consulting runtime caches or SQLite. The HTTP RED for the missing query was 404; its GREEN test corrupts the cache and excludes SQLite readers while preserving original managed bytes and excluding external host paths. This explicit plaintext source interface is no-store/capture-excluded, not a secret-masked resource response.

The existing Codex browser/device writers were source-checked: both perform their final `write_login` on a blocking worker. The device implementation now accepts the existing explicit-endpoint OAuth client through `device_login_with`, while its normal wrapper still selects the unchanged provider defaults. The new current-thread test runs that **real device OAuth implementation** entirely against loopback token/usercode/device endpoints and the real owner API, reusing a synthetic Go identity fixture. It withholds the HTTP receipt after server persistence and verifies the provider has not returned; success preserves existing opaque metadata and survives an ordinary standalone backup copy. Storage HTTP 500, a replaced source and a deleted source each make the provider save fail without overwriting/resurrecting canonical state. Exactly one mocked grant occurs per invocation. This is real local OAuth/save-port evidence, not an end-to-end real-provider/browser CLI run.

A concrete dispatch correction was also made: supported online **selection** now shares Go's single pure priority selector with actual command execution. Previously merely adding a Codex flag could admit a higher-priority unsupported SIWC/Antigravity command. A pure mixed-flags test catches the old presence guard without invoking those flows. Two defect controls failed meaningfully and were restored: the old presence guard admits `--codex-login --siwc-bind`, and swallowing a batch error lets the actual provider falsely return success after HTTP 500.

The first broader freeze exposed an over-wide redirect-policy change against the existing generic TUI setting-client contract. That failure remains in `first-freeze-results.json`. Redirect refusal is now scoped to import, credential batches and the explicit admission dry run; its new check verifies no redirect is followed. Generic Go-style setting redirects were not silently redefined or their assertions weakened. Their potential false-ack semantics are tracked separately in todo 36 for 4.x/5.1; this slice does not claim all owner-client writes are already hardened.

Final `/var/tmp/cook-router-parent53-codex/final-results.json` passes CLI **185+8+1+1+3**, admin **20/0**, management HTTP **56/0**, Codex OAuth executor **15/0**, full server library **594/0**, mandatory native plugins **66/0**, Home **120/0**, strict clippy and fmt. All **514** crate Rust hashes match the final freeze. No live provider traffic, real credentials, delegation, commit, push, merge or deployment occurred. Codex browser/device and Vertex are enabled; SIWC, other providers, plugin callbacks, explicit-path semantics and multi-document deletion handling still need migration. Task 5.3 remains unchecked and overall progress at this source freeze is **9/33**.

### Parent task 1.3 — audit of the completed memory-query boundary

No new implementation or probe framework was added for this checkpoint. The stale graph identified query candidates but omitted the new `current` accessor; coverage reported changed/untracked sources, so all seven material paths were read directly. `ConfigStore::current` only clones the immutable `Arc<State>` under its read lock. Snapshot/config/resource queries derive from that captured memory; revision/history queries read its revision/change maps; `CredentialDb::read/documents` capture one state and clone its raw document bytes. The authorized source HTTP view uses that memory result, not cache files or a parser/RPC. No on-demand SQLite fallback exists in these inspected query paths.

`/var/tmp/cook-router-parent53-codex/task13-query-audit.json` binds this audit to the unchanged tested source and five already-passing behavior tests: configuration reads with SQLite readers excluded, resource/history reads preserving identities and ETags under the same exclusion, original authorized credential bytes with a corrupt cache and SQLite excluded, ordinary query results with working or published storage unavailable, and a slow public edit whose concurrent HTTP reader plus retained earlier snapshot keep the old complete revision until the writer is released. The preceding frozen admin **20/0** and full library **594/0** runs contain those exact results; they were not redundantly rerun.

Task 1.3 is complete on that evidence. This is current implementation verification, not a claim that retrospective tests were pre-implementation RED, and does not close task 1.1 or establish 1.2/1.4 without their own audit. Overall progress becomes **10/33**; provider/plugin migration and final acceptance remain incomplete.

### Parent task 5.3 — SIWC existing-input adapter (partial task)

Caller inventory before extending the proven save seam:

| Input/effect | Adapter boundary |
| --- | --- |
| SIWC identifier and provider/network options | Authenticated plaintext resource export, compiled by the existing SQL-free resource importer/compiler; no local store or config fallback. |
| Existing target and explicit destination | The source view now includes the owner's managed-directory descriptor. A bare managed name or direct absolute native owner target maps to that same logical source; outside/nested/missing/unsupported aliases fail before granting, with no client-side filesystem resolution. |
| File validation and `device_id`, needed before the grant | Captured original bytes are hydrated in private scratch before SIWC resolve/device-ID/upstream effects. The existing resolver runs on an awaited blocking worker. |
| Legacy SIWC replacement and acknowledgement | Reuse the same blocking callback, captured-source conditions and one atomic HTTP batch. It preserves outer Codex tokens/opaque fields, replaces the SIWC partition, and returns success only after owner acknowledgement. Private scratch stays owned through the writer. |

`/var/tmp/cook-router-parent53-siwc/` retains the missing-descriptor RED (`Null` versus the managed directory), GREEN API/path tests, actual one-worker loopback flow, and a deliberate device-ID regeneration defect. The latter fails the authorization URL assertion before the SIWC token exchange and was restored. The shared flow performs exactly four prior Codex grants and three SIWC grants against explicit local token endpoints: SIWC succeeds with the captured device ID and configured identifier; checkpoint failure yields HTTP 500 without changing canonical bytes; deletion after source capture yields HTTP 412 without resurrection. It also checks plaintext proxy options survive authorized config compilation. The newly sensitive snapshot GETs refuse redirects while the existing generic Go-style redirect test remains unchanged. These are mocked provider/actual owner-port tests, not a live account or browser CLI end-to-end claim.

The restored source freeze passes CLI **186 + 8 + 1 + 1 + 3**, admin **20**, SIWC executor/Go-port tests **10**, strict CLI/server/executor clippy, fmt, OpenSpec validation and diff checks. All **514** frozen crate Rust files remain unchanged; `results.json` records the commands. Task 5.3 stays unchecked at **10/33**: the remaining provider/plugin writers, multi-document/deletion effects and final lifecycle/acceptance work are not implied by this slice.

### Parent task 5.3 — compatible single-document writer group

Current-source caller inventory groups effects, rather than assuming every provider is a new persistence design. Kimi/Kimi.ai create one timestamp-named document; xAI, Meta and Devin render/merge one declared target on an owned, awaited blocking worker. They reuse the existing captured-source/conditional batch callback unchanged. Antigravity was the exception: its async login invoked the synchronous save directly. That save is now moved to an owned, awaited blocking worker, and its callback server is aborted and joined before returning. Those built-in modes are enabled; Claude's multi-document legacy deletion and plugin host writes remain disabled online pending their adapters. `login_paths` for Claude also enumerates case-folded legacy aliases before its callback, an input effect not satisfied by save-time hydration alone.

`/var/tmp/cook-router-parent53-kimi/flow.log` records both actual Kimi domain flows. `/var/tmp/cook-router-parent53-single/` records the combined one-worker owner fixture: four Kimi/Kimi.ai exchanges preserve exact rendered bytes and propagate checkpoint failure; three xAI exchanges replay the unchanged Go `subject_only_merges_existing_file` script through an explicit loopback issuer, preserve disabled/prefix/opaque metadata, and reject storage failure or source replacement. The pre-existing Codex/SIWC cases remain in the same fixture. Meta/Devin/Antigravity are source-verified save-effect migrations backed by their existing provider ports, not newly claimed full browser/device-flow end-to-end tests.

The meaningful group freeze passes CLI **186 + 8 + 1 + 1 + 3**, executor library **549 passed / 1 pre-existing ignored**, strict CLI/server/executor clippy, fmt, spec and diff. The ignored case is `claude::go_unit::unverified_go_cancellation_cases` (`unverified: Go cancels the request context mid-call (see UNVERIFIED)`); it was not added, enabled or weakened here. `results.json` binds the unchanged **514** Rust hashes; no broad workspace/platform/idle acceptance is implied. Vertex/Codex no longer fetch unused configuration secrets. Task 6.2's remaining plaintext-option/source input-scope concern is recorded separately; privileged export access alone does not prove minimal required inputs. Overall progress remains **10/33**.

### Parent task 5.3 — atomic removals and Claude alias migration

The existing authenticated credential batch now accepts required-hash `deletions` alongside raw documents, or deletion-only input. Every name, overlap and condition is validated before cache effects; the existing owner command applies `Some(bytes)`/`None` in one candidate, preserving removals in pending/full-state images and restoring old cache content on failure. Reconciliation removes deleted runtime credentials before the receipt. The client requires an exact deletion count, and treats only `NotFound` after a successful renderer on a declared **captured** destination as removal; other read failures visibly fail. Duplicate exact declared paths are consolidated. No new grant authority or local fallback was introduced.

Claude is enabled using the same port. Its captured `claude-` filename namespace is hydrated before `login_paths` recursively enumerates case-folded aliases; the source API still limits authorized inputs to direct managed basenames, not arbitrary host paths. Nested source/foreign filesystem aliases are not newly authorized. The actual loopback Claude flow migrates a capitalized legacy filename, preserves opaque/proxy metadata, and atomically saves canonical bytes plus deletion. Storage failure and replacement of the captured legacy source produce HTTP 500/412 with neither effect partially committed. A directory/read-error control refuses rather than deleting a credential. This does not establish nested legacy-path or cross-platform alias acceptance.

`/var/tmp/cook-router-parent53-delete/` retains HTTP RED400-versus412, mixed success, later conflict, missing/overlapping targets, storage rollback, deletion-only CAS, runtime revocation and standalone-copy restore evidence. Deliberately dropping the tombstone makes the HTTP test fail (download200 versus404); deliberately omitting pre-enumeration hydration makes the real Claude flow lose `note`; both defects are restored. `final-results.json` records **594/0** server library and **21/0** admin HTTP, strict clippy/fmt/spec/diff and unchanged **514** Rust hashes. The preceding CLI run is **186 + 8 + 1 + 1 + 3**; its source was unchanged afterward except the server test-only log repair below. Plugin CLI persistence is still open and task 5.3 remains unchecked.

### Parent PR39 — causal model-updater log-capture repair

The first mixed freeze failed **593/1** in `model_updater::tests::failed_reads_log_no_url`; `server.log` and failed `results.json` remain historical evidence. Two bounded subscriber-only diagnostic groups (20 and30 runs) did not reproduce it. The cause was a **subscriber-less** sibling first registering the production WARN callsite while only one capture dispatcher lived, not refresh completion or missing redaction. This matches tracing-core0.1.36's single-dispatcher interest-cache fast path ([upstream #3611](https://github.com/tokio-rs/tracing/issues/3611)).

The existing test now deliberately executes that real refresh path first on an unsubscribed joined thread. It reproduces the exact missing-WARN/two-DEBUG symptom deterministically in0.01s, without network. Keeping a second inert `Dispatch` alive after installing the capture repairs the global interest-cache calculation; no production log level, dependency, wait budget or assertion was changed. `/var/tmp/cook-router-parent-model-log/{red,green}-first-caller.log` and the restored full594/0 run bind the fix. The original positive logging and no-SECRET checks remain. Overall checklist progress is still **10/33**.

### Parent task 5.3 — native plugin owner adapter and private effect ownership

Explicit online plugin flags now bootstrap from authorized remote configuration before any local database/YAML initialization. The host gets its persistence manager before plugin initialization, and both typed/raw auth-directory views point to private client scratch. Native `host.auth.save` uses the same conditional owner port as final command AuthData. The latter's callback is now owned and awaited on a blocking worker (including offline callers), not synchronously invoked on the async executor. Host shutdown uses its unbounded join before manager detachment and scratch cleanup. Returned save paths are logical names, not temporary files.

A plugin can save more than once. The captured source cursor now advances only after a successful receipt to **its own exact rendered bytes**; a second read of current remote state never grants overwrite permission. A repeated-save RED failed with HTTP412 on its second own save; the corrected test permits both acknowledgements but still rejects an independent third replacement. The cursor mutex is held only while copying relevant inputs or updating acknowledged results.

CAS alone was insufficient for shared scratch concurrency: the bounded, no-sleep two-writer control made A successfully acknowledge B's bytes. A separate nonblocking operation permit now owns the whole hydrate/render/read/HTTP interval and refuses overlap or reentry; no cursor/state/list lock is held in callbacks or network waits. The same control passes and both blocking workers settle before assertions. No global blocking-pool limit was added.

`/var/tmp/cook-router-parent53-plugin/` retains those RED/GREENs and an actual native recorder subprocess on a one-worker runtime. It blocks the real owner protocol lock, verifies no server cache/image/local DB changes before admission, then withholds the first persisted receipt and observes the **host-save** bytes before returned AuthData can replace them. It proves opaque returned data, standalone copy/restore, HTTP500/auth failure without fallback, joined scratch cleanup, disabled/absent no-op behavior, and rejection of an explicit server-cache path. Bypassing host persistence while retaining the final AuthData write makes this test fail (`returned` versus `host` before the first receipt); that defect is restored.

Setup failures remain evidence, not claimed behavior REDs: a missing workspace SHA-256 declaration was corrected to the same existing direct0.10 dependency as server/executor, one enum test constructor and shutdown argument were fixed, the native fixture uses the existing public file lock rather than a private runtime method, unknown plugin flags must survive both rewrite and built-in clap parsing, and host.auth.save uses RawMessage JSON rather than the StorageJSON base64 shape. The real offline Cargo lock update adds/removes **no package versions**.

The restored freeze (`results.json`, **514** unchanged Rust hashes) passes CLI **186 + 9 + 1 + 1 + 3**, plugin library/contracts **95 + 1 + 7 + 3 + 10 + 2 + 1 + 1**, strict four-crate clippy, fmt, spec and diff. The one pre-existing ignored target is a `gojson::go_struct` documentation example, not a skipped native acceptance test; `CPA_TEST_NO_SKIP=1` was set. This does not close directory/foreign alias ceilings, task6.2 secret-bearing input scope, whole-caller retirement audit or lifecycle/final acceptance. Task5.3 remains unchecked pending that reconciliation, at **10/33**.

### Parent tasks 3.4/6.3 — intermediate shutdown boundary

`/var/tmp/cook-router-parent-lifecycle/` records the following production changes:

- Notification stop cancels further scheduling and joins the current blocking reload, rather than aborting its async waiter. Main, management tests, native fixtures and the harness use that owned handle. A no-sleep barrier test writes inside the actual disposable SQLite workspace and verifies removal after join over **20** cycles. The credential cache beside the published image is not that workspace; an initially incorrect assertion against the cache was corrected using the actual owner path.
- Background refresh loops/jobs and blocking admission, document preparation and completed-grant commits use the existing trackers. Scheduling timeout does not cancel or detach an exchanged grant. Management owns HTTP operations, login/SIWC workers, native scope lifetimes, callback forwarders/connections and its blocking helpers. New ordinary plugin saves and new scope issuance refuse admission during shutdown; already-issued fenced saves can complete.
- Main stops management/credential-preparation admission and notification scheduling before the Home/pprof/discovery drain. Dropping the listener now cancels its established HTTP/RESP connections too. It then joins management and notification work, settles runtime persistence and joins native children. Strict runtime settlement joins the cooldown thread outside its registry lock, attempts retained owner publication and waits for normalization queued by recovery. Unresolved publication reaches main as an incomplete-shutdown error; the checkpoint survives owner release.

The actual `serve` driver test holds an admitted configuration writer while stopping, observes closure of an already-established **inference** keep-alive connection, then releases the writer and verifies workspace removal and standalone snapshot restore. Its failed-publication variant creates a newer checkpoint through the authenticated owner port, keeps the published target unavailable through stop, requires an error and a retained workspace, restores storage and verifies the newer value resumes under a new exclusive owner. A native recorder/loopback-grant test holds an issued refresh/save scope across admission stop, then releases it, joins shutdown and verifies the opaque host/final result survives without a Management/runtime/native wait cycle.

Controls use the unchanged acceptance-test schedules. Restored abort-and-detach fails actual workspace cleanup; an untracked refresh fails the committed-token assertion, including after strict final settlement was added. Detached established connections time out the real driver EOF assertion; a detached management login fails the completed-save assertion. Swallowing the final persistence error falsely returns `Ok` and fails the real driver's error assertion. Skipping the Management join fails the native-scope test. All controls are restored.

The initial final ownership sweep is retained as `ownership-final-results.json`: server **598/1** failed the request-log cancelled-close test. Its UUID-private file later contained the correct status, distinguishing a partial-file read from lost HTTP metadata or a directory collision. The test's **50ms sleep was not a completion barrier**. It now receives the existing `RequestLog` handle and awaits `finished()` after dropping the cancelled HTTP future; file-count, status and single-finalization assertions remain. Production logging, resource budgets and dependencies are unchanged. Focused **1/0** and full server **599/0** pass in `log-completion-*.log`.

The restored final evidence is `completion-final-results.json`, with **527** unchanged Rust hashes: server **599**, native **67**, CLI **188 + 9 + 1 + 1 + 3**, management **56**, admin **21**, strict affected clippy, workspace/harness fmt and locked harness check all pass. This is a harness **build**, not an executed Go/Rust differential run. No task is accepted from the earlier failed freeze.

At this intermediate freeze, tasks **3.4/6.3 remained unchecked** at **10/33**. The bounded completion decision below supersedes that interim inventory placeholder. No further worker delegation, commit, push, merge or deployment was performed.

### Tasks 3.4/6.3 — criterion decision on the final local tree

The bounded pass found two concrete remaining producers, not a need for another general architecture audit. `management_shutdown_joins_response_log_finalization` first failed with **zero files** after shutdown: response-drop logging used an unowned finalizer. The existing HTTP/TLS upgrade test then failed because aborting the listener left an upgraded socket alive.

Admitted log records now retain the existing owner token through bounded spooling and final delivery; their async/spool/blocking finalizers use that same tracker. Responses, realtime and relay upgrades receive an explicit listener cancellation/tracker context. Their ownership begins before the handshake hands off the socket. Realtime relay children use the existing tracker and abort-on-drop handle, so cancelling the parent does not detach its socket task. The final combined HTTP/TLS case requires socket closure, a completed **Status101** log and actual configuration-workspace removal. Removing upgrade cancellation fails that case at the shutdown wait; the repair is restored. `red-unowned-response-log.log`, `red-upgraded-transport-stop.log`, `owned-websocket-log-workspace.log`, `owned-request-log-contracts.log` and `control-uncancelled-upgraded-owner.log` retain these observations.

| Task | Exact criterion | Source and observed evidence | Decision |
|---|---|---|---|
| 3.4 | Stop new admission | `Management::begin_shutdown/enter`, runtime preparation admission and scoped plugin issuance stop before final drain. The management test rejects a new owner-port command without changing its revision while an earlier completed login saves. | Satisfied |
| 3.4 | Settle critical writers/grants | `Runtime::finish_shutdown`, owned blocking commit jobs and already-issued grant scopes preserve completion ownership. Real `serve` holds an admitted writer across stop; builtin and native tests require persisted results before shutdown completes. | Satisfied |
| 3.4 | Join tasks, threads and processes | Notification reconciliation, management/logging/transport work and runtime persistence are awaited; the cooldown thread is taken and joined outside its registry lock; native `shutdown_all(None)` is awaited. The held-native-scope case completes without a wait cycle. | Satisfied |
| 3.4 | Remove disposable work only afterward | Real `serve` success/standalone restore and the HTTP/TLS upgrade-plus-log case verify actual workspace removal after owned work finishes. | Satisfied |
| 3.4 | Retain/report unresolved publication | The real driver's failed-publication case requires `Err`, retains the newer checkpoint, restores storage, reopens with exclusive ownership and resumes the newer value. Swallowing that error fails the test. | Satisfied |
| 3.4 | Repeated DirectoryNotEmpty regression coverage | The relevant late-normalizer regression `explicit_shutdown_drains_normalization_queued_behind_the_owner_before_cleanup` passes in `boundary-server.log`, `log-completion-server.log` and `closure-server.log`. The held reload writes inside the actual workspace over20 strict-delete cycles. Native fixture cleanup, including `a_failed_explicit_refresh_fixture_joins_before_the_next_bootstrap`, joins retained work before strict removal. Restored detach fails cleanup. These exercise the original late-writer ordering, not merely unrelated test counts or a demand that the kernel emit the same errno on each run. No new sleeps or ignored removal failures mask it. | Satisfied |
| 6.3 | Existing owned execution primitives | Tokio cancellation, tracker tokens, owned blocking jobs, joined cooldown thread and existing native host joins cover this component's async/blocking/process work. Request logs and upgraded relay children are now included. | Satisfied |
| 6.3 | Existing admission bounds | The single commit authority, configured refresh semaphore and one reservation per credential remain in force; normalization coalesces by identity/revision, cooldown work has one in-flight/one pending snapshot, and streaming log channels and existing protocol/body limits remain bounded. Worker-bound/coalescing behavior tests pass. No new global queue policy or reduced blocking-pool limit was introduced. | Satisfied |
| 6.3 | Stop-and-wait; no workspace use afterward | Real-driver, held reload, queued normalization, issued native scope and logged HTTP/TLS upgrade cases observe settled outputs and strict removal. Their restored defects fail the same behavior assertions. | Satisfied |

The previously labelled “singleflight watcher” is actually `Completing`'s Home remote-lease watcher, with its own handle and weak stream reference; it is not a detached local configuration writer. General caller retirement belongs to4.x/5.x/7.x, authorized input views to6.2, and isolated computation to6.4. Those remain open, but are not substitutes for a concrete failing lifecycle criterion.

**Decision:** check **3.4 and6.3**; progress is **12/33**. Final `closure-results.json` and `closure-rust-hashes.json` record **527** unchanged Rust paths: server **600**, native **67**, CLI **188 + 9 + 1 + 1 + 3**, management **56**, admin **21**, strict affected clippy, locked harness build and both format checks pass. The earlier request-log test-only50ms repair and its failed freeze remain distinct from these later production ownership repairs. Whole-workspace/actual differential execution, platform/performance gates, independent8.4 review and human acceptance are still pending. This decision is not that final approval.

### Parent todo36 — direct owner setting/key acknowledgements

The Rust TUI client previously let `/admin/v1/apply` redirect into a read, then treated the read's HTTP200 as a successful setting write. The real-owner test first failed on **301** while the canonical setting/revision were unchanged (`/var/tmp/cook-router-parent36/red-setting-owner-ack.log`). The earlier UUID compile failure is fixture setup evidence, not that behavior RED; no dependency was added.

The shared request boundary now refuses all3xx owner-mutation responses under `/admin/v1/`, whether or not `Location` exists. The common apply acknowledgement requires HTTP200 and a numeric committed revision, covering setting writes and client-key add/edit/delete without changing their operation bodies or resource preconditions. Generic reads/non-owner transport keep Go's redirect rules. The old redirect test now explicitly exercises that generic PUT transport, retaining its method downgrade, dropped-body, Bearer and Referer assertions; it no longer treats an atomic owner write as a generic redirect success. The existing key-patch fixture now returns a real revision receipt instead of `{}`, with all identity/body/`if_rev` assertions intact.

The private current-thread real-owner test covers301/302/303/307/308 with and without `Location`, direct HTTP200 with no revision, and HTTP202 with a purported revision. Every refusal leaves the canonical value/revision unchanged and makes no request to the redirect target. A direct authenticated owner request then succeeds and changes the committed value/revision, ruling out an always-reject implementation. Removing only redirect refusal makes the forbidden target-hop assertion fail; removing only receipt validation falsely acknowledges the HTTP200 empty receipt. Both controls are restored.

`/var/tmp/cook-router-parent36/results.json` records CLI **189 + 9 + 1 + 1 + 3**, strict affected clippy and fmt passing, with **527** unchanged Rust hashes. Client-specific contracts pass **13/0**. The unchanged server/native sweep was not repeated. Todo36 is complete; broader4.1/5.1 adapter/CLI acceptance remains open, and overall OpenSpec progress remains **12/33**. No commit, push, delegation or deployment was performed.

### Parent4.1 — server configuration adapter acceptance

The exact4.1 criteria are now met, for **13/33** overall. The bounded source/evidence map is `/var/tmp/cook-router-parent4-1/README.md`. This is parent acceptance, not independent8.4 approval or closure of neighboring credential, CLI, callback and execution tasks.

Admin resource PUT/PATCH/DELETE and apply share `management/admin.rs::write` -> `Management::commit_with` -> `ConfigStore::commit_if`; import and history restore use `replace_if`. Config API-key toggles use `auth_files::toggle_config_key` -> `Management::edit_document` -> `ConfigStore::edit`. Plugin config/enable/delete and installed-plugin configuration use `plugins::save` through the same edit command. These configuration paths share owner admission in `config_store/commit.rs::transact`; the management wrapper computes restart status without a second runtime publication. Physical plugin install/unload remains distinct from configuration persistence.

| Criterion | Actual behavior evidence |
| --- | --- |
| ETag/resource and collection preconditions | Real HTTP strong-resource/wildcard/absence tests; collection replacement requires a current concrete global condition, including dry-run; hash-matched management `config_writes_honour_per_resource_if_match` covers PUT/PATCH/DELETE rejection and unrelated-resource independence. |
| Dry-run | `query_dry_runs_do_not_write_publish_or_contact_an_upstream`; new startup-port candidate reports restart without advancing the current revision/port or supplying a candidate ETag. |
| Redaction | `ordinary_http_reads_and_write_responses_mask_every_secret` covers resource/history/effective/export reads and write receipts, plus explicit authorized secret export. |
| Destination protection | `errors_never_echo_parser_or_database_messages_and_keep_safe_locations` writes a provider, changes its endpoint using the masked receipt and requires422 `secret_destination_changed`, safe pointers and no secret disclosure. Existing store tests additionally cover masked import and history restore to a different endpoint. |
| Config API-key toggles | Hash-matched `config_key_toggle_edits_only_the_target_key_in_the_current_store`, `config_key_field_patch_is_not_found` and `auth_files::config_key_toggles_are_stored_and_published`. |
| Plugin configuration edits | Actual `plugin_routes_match_go` HTTP/native port passes, including configuration snapshot comparisons and intercepted store requests. The fixture records6fecc6e, not later v8.0.35 parity. |
| Restart and configuration-only successful restore | New `successful_config_restore_reports_restart_without_restoring_revoked_credentials`: routing-only change reports false; hypothetical/committed port changes report true; restoring the startup port reports false. An authenticated saved credential is observed in runtime and downloaded, then conditionally deleted. Configuration restoration neither restores its bytes nor re-admits it; a standalone published-image copy reopens with the restored configuration and the credential still absent. |

The new test passed on its first run: this is additive acceptance coverage for existing behavior, not a retrospective RED/GREEN repair. An artificial restart inversion was restored before any test ran and provides no control evidence. No production Rust change remains in this slice.

Affected gates: admin **22/0**, plugin port **1/0**, strict server all-target clippy and fmt pass. **527** Rust hashes were stable; **155** unchanged server paths match the lifecycle closure, permitting reuse of its library600/management56 evidence rather than another full sweep. The first combined plugin/clippy/fmt execution hit its600s tool deadline after the plugin test had already passed in19.73s; unfinished buffered lint output was lost and fmt was not reached. One identical locked clippy diagnostic with direct logs passed in532.2s under the same600s ceiling, without source/flag/priority changes or further attempts. The original timeout is retained, and its specific performance cause is not proved.

Graph generation2026-11-12T02:08:41Z and exact source support the entry-point map; graph async call edges are incomplete, so live handler bodies—not absent graph callers—establish delegation. Changed admin-test ranges were inspected directly. The existing generic fixture's weak Drop cleanup is recorded, not presented as new lifecycle proof. No commit, push, delegation or deployment occurred.

### Parent CI scout and repairs — allocation, Home oracle, cooldown reporting, Go replay port, owned snapshot reads

Evidence root: `/var/tmp/cook-router-parent-batch/`. An early whole-workspace scout (`workspace-scout.log`, `cargo test --workspace --locked --no-fail-fast`, 823 s) ran **2147 passed / 2 failed / 2 ignored**. Both ignored tests are pre-existing (`claude::go_unit::unverified_go_cancellation_cases`, one gjson doc example). The two failures were real CI breakers:

- **`alloc_budget` codex.306k allocations 1746 > 1733** (dated baseline 1683 + 3%). The excess was a fixed +63 per request at both Codex sizes. A temporary allocation-backtrace probe (`alloc-probe.log`; the probe file was deleted) attributed a per-candidate cost to `grant_blocks -> CredentialDb::required_source`, which built a canonical document name for every file-backed candidate on every dispatch. `ConfigStore::any_grant_source` now returns early when no source is fenced; the later lookups are unchanged point-in-time reads, so fencing semantics are the same. `alloc-after-fastpath.log`: codex.306k **1722/1733**, codex.1900k 4043/4124, and every other route is also lower. `bench/budgets.txt` is untouched. Residual: codex.306k remains about +39 over its dated baseline with **11** allocations of headroom; later request-path additions must be measured.
- **`home_plugin_finalization_waits_for_the_applied_config`** saw 4 RPUSH where 2 were expected. `FakeHome::count("rpush")` also counted `app-log` pushes, and the Home app-log forwarder is a process-wide logging hook that sibling tests activate with `logging::init()`. Causal control: injecting `logging::init()` plus one warning in the window made the old oracle fail **5 vs 2** (`control-home-applog-old-oracle.log`) while a plugin-status oracle passed with the same injection (`control-home-applog-status-oracle.log`). The final oracle counts only `plugin-status`, requires the first finalization to have pushed (`> 0`) and eventually requires a second finalization after release, so it cannot pass vacuously. Home suite 83/0 (`green-home.log`). Limitation: the narrowed counter no longer surfaces unrelated warning lines; the scout showed no new shutdown/cooldown error lines.

Task 4.5 background-failure reporting: `a_failed_final_cooldown_checkpoint_makes_shutdown_incomplete` first failed because shutdown reported success after the final coalesced cooldown checkpoint could not be installed (`red-cooldown-report.log`), while live scheduling had already used the cooldown. `cooldown_store::Writer` records the latest attempt's error (a later success clears it), and `Writer::stop` joins and returns it; `finish_shutdown` folds it into `configuration shutdown incomplete`. Running failures remain warnings. GREEN cooldown selection 21/0 (`green-cooldown.log`); swallowing only the joined result fails the new test (`control-cooldown-swallowed.log`), and the control is restored. The shutdown message no longer claims a retained recovery workspace for a cooldown-only failure. This deliberate difference is in `DIFFERENCES-FROM-GO.md`.

The second CI-mirror pass (`ci2/`) also failed `manage_go::creds::go_credential_management_replay` (passed in the scout): a proxied `Content-Length` of 250 vs Go's 251. The echo upstream reports the raw Referer URL, this host's `ip_local_port_range` is `1024 65535`, and the Go recording used a five-digit ephemeral port. The test-only echo listener now rebinds until its port is at least 10000. This root cause is an inference from the one-byte difference plus the port range; afterwards `manage_go` passed in `gate3/manage-go.log`. CI runners' default range is unaffected.

Task 5.4 snapshot reads: `a_live_owner_allows_snapshot_reads_and_refuses_offline_logins` first failed because `config export` under a live owner was refused as `already owned` (`red-owned-reads.log`). Ownership failure is now the typed `config_store::AlreadyOwned` error; only on that error do read-only `config export/validate/backup/listener` open the published file read-only (`ConfigStore::open_published`) without ownership, workspace or write-back. The new test covers redacted and secret export, stored and file validation, a backup that later restores alone, unchanged published bytes, refusal of offline `--vertex-import` and `config import` while owned, and a successful persisted offline Vertex import after the owner stops. config_cli 10/0 (`green-owned-reads.log`). `CONFIGURATION.md` documents that such reads see the latest completed publication.

Final local CI mirror (`ci3/`, Rust tree frozen; all 546 hashed `.rs/.toml/.lock` paths in `ci3/start-hashes.json` unchanged at the end): fmt, `cargo test --workspace --locked --no-fail-fast` **2151 passed / 0 failed / 2 ignored** across 77 result blocks (the same two pre-existing ignores), workspace all-target `clippy -D warnings`, the default-build profiler exclusion, the harness check, `cpa-server --features media-relay,pprof --lib`, vendored gjson, `alloc_budget` and the changelog check all exit 0. Limits: `cargo-nextest` is not installed and there is no network namespace here, so CI's sharded nextest lane under `unshare --net` is approximated by the workspace `cargo test` run; the `--features` lane needed a prior `cargo fetch --locked` (Cargo.lock unchanged).

#### Parent closure — task 4.5

| Criterion | Evidence |
| --- | --- |
| Coalesced persistence behind the owned command path | `CredentialDb`'s cooldown `Backend::save` takes `ConfigStore::writer()` and installs a candidate with only `cooldowns` changed through `accept`, the same owner commit as other credential commands. `cooldown_store::writer_coalesces_ordered_snapshots_and_drains_on_drop`: snapshots queued while a save is gated collapse to the latest. |
| Volatile scheduling feedback is not delayed by disk | `Runtime::persist_cooldowns` only hands the snapshot to the dedicated writer thread. `a_failed_final_cooldown_checkpoint_makes_shutdown_incomplete` asserts the cooldown is visible to scheduling while checkpoint installation is blocked; the writer test shows `save` returning while the backend is gated. |
| Flush/shutdown | `cooldown_sqlite_constructor_ignores_workspace_cds_files_and_flushes_on_shutdown` (the shutdown path persists the last cooldown); the writer drains on drop; `cooldowns_persist_restore_and_reset_through_sqlite`. |
| Background failure reporting | Running failures log `failed to persist cooldown state`; a failed final checkpoint makes `finish_shutdown` return `configuration shutdown incomplete` (RED/GREEN/control above). |
| No unrelated configuration callbacks | `rejected_dry_run_and_other_domain_commands_do_not_notify_configuration` now saves a non-empty cooldown record, proves it is durable (`Backend::load` returns it and the published bytes change after the preceding credential save), and still sees no configuration callback, no revision change and no management publication. The strengthened assertion passed on its first run (`green-cooldown-callbacks.log`, ordered + cooldown selection 40/0): additive coverage, not RED/GREEN. |

#### Parent closure — task 5.4

| Criterion | Evidence |
| --- | --- |
| Offline mutations use the same service/commit implementation, only with exclusive ownership | `config import` opens `ConfigStore::open` and commits with `replace` -> `transact`; offline logins use `login_save` -> `CredentialDb::write_files` -> `ConfigStore::writer`. Ownership is the never-unlinked native lock in `published::ownership`, now returned as typed `AlreadyOwned`. |
| Stopped-service import/login works | `a_live_owner_allows_snapshot_reads_and_refuses_offline_logins`: after the owner stops, an offline `--vertex-import` succeeds and a fresh store reads the Go-fixture bytes. The fixture database itself is created by an offline `config import`. |
| A live owner refuses offline writes even when its API is unreachable | The same test first holds ownership with a bare store and **no** management listener: offline `--vertex-import` and `config import` fail with `already owned` and the published bytes are unchanged; they are refused again under a full API-serving owner. |
| Read-only backup/export are not competing mutations | Under both owners `config export` works; under the API owner redacted/secret export, stored and file `validate`, and `backup` succeed with unchanged published bytes, and the backup later exports the same secrets on its own. RED `red-owned-reads.log`; GREEN `green-owned-reads-2.log` (config_cli 10/0); `cook-router` all-target clippy passes. |

Remaining limits: reads under an owner see the latest completed publication, not an in-flight write; Windows lock semantics remain unproved locally.

#### Parent closure — task 1.2

| Criterion | Evidence |
| --- | --- |
| Complete service-owned canonical state, derived immutable views, existing representations | `ConfigStore` holds `RwLock<Arc<State>>`; commands install a new `Arc<State>` and subscribers receive immutable `ConfigurationView`s. Resources, credential documents/metadata, history and cooldown rows keep the existing resource/credential/history representations (`resources::Resource`, `cooldown_store::Record`). |
| Fixture loading preserves IDs/order, opaque plugin fields, raw credential bytes, revision/change history and cooldowns | `encoding::complete_state_exports_without_any_previous_database_or_credential_cache`: plugin resources with custom `ord`/descriptions and opaque `!!binary`, padded and unknown values; raw nested and external credential bytes; a revoked legacy document; a cooldown record; opaque `credential_meta`. After the source, live file and materialized auth files are deleted, the artifact is encoded from memory and reloaded: resources, revision, digest, text, every `revision(rev)` and `state_at(rev)`, raw bytes, tombstoned/late legacy files and cooldowns are equal. `empty_and_initialized_memory_states_encode_without_a_disk_source` covers both empty states. |
| No second mutable authority | `CredentialDb` and the cooldown backend read `store.current()`. `management::authorized_credential_reads_and_cooldown_views_need_no_storage` holds `BEGIN EXCLUSIVE` on storage while the credential download, document list, cooldown load and canonical read all answer from memory. Runtime scheduling state is volatile admission data, not a configuration or credential authority (tasks 4.3/4.4 cover refresh). |

#### Parent closure — task 1.4

| Criterion | Evidence |
| --- | --- |
| Serialized admission | Every command enters the single `ConfigStore::writer` mutex: config `transact`, `CredentialCommand` and the cooldown backend; synchronous reentry is refused by `check_reentry`. `admin_contract::concurrent_write_responses_keep_the_committed_resource_and_revision_snapshot` (24 concurrent writers, 24 distinct revisions, each response carrying its own committed resource); `config_cli::concurrent_cli_writers_publish_one_complete_latest_snapshot`. |
| Typed commands with existing preconditions | `Op` is a closed, `deny_unknown_fields` enum with per-resource `if_rev`, `if_absent` and `Check`; collection `Precondition`s are checked inside the write (`preconditions_are_per_resource`, `collection_and_resource_preconditions_are_checked_inside_the_write`). Credential batches use source-hash `if_match` and `if_none_match`. |
| Candidate validation | `a_commit_is_one_revision_and_an_invalid_one_changes_nothing` (422, neither op applied); `validation_faults_locate_fields_and_reject_partial_plugin_placeholders`. |
| Invalid input, stale preconditions and dry runs have no persistence, memory publication or callbacks | Configuration: `ordered::rejected_dry_run_and_other_domain_commands_do_not_notify_configuration` now covers malformed YAML, a well-formed 422 candidate, a stale revision and a dry run, then checks unchanged published bytes, store revision, management publication and no configuration callback. Credentials: `credential_batch_rejects_a_later_invalid_or_conflicting_document_without_partial_writes` covers invalid JSON (400), stale `if_match` and `if_none_match` (412), and now also checks unchanged runtime credential tokens, configuration revision and runtime config watch; a final admitted batch changes both bytes and runtime tokens, so these checks are not vacuous. `credential_batch_requires_authentication_and_refuses_host_paths` refuses an unsupported credential dry run without writing; `query_dry_runs_do_not_write_publish_or_contact_an_upstream` covers admin dry runs. The batch handler returns before `publish_uploads` and `credential_changes.notify_one()`. The strengthened assertions passed on first run (config_store 98/0 `green-admission.log`, admin 22/0 `green-batch-rejection.log`): additive coverage, not RED/GREEN. |

#### Parent closure — task 4.2

Production credential writers in `management/` (test modules excluded), from live source:

| Entry point | Owner path |
| --- | --- |
| upload / restore | `auth_files::upload` -> `write_source` -> `CredentialDb::save` (+ `credential_changes`); `restore` through the backend |
| delete (single and batch) | `CredentialDb::delete`; batch `CredentialDb::write_files` |
| status / fields | config-backed: `replace_config_backed` (config command); file-backed: `apply_patch(id, revision)` -> `Runtime::credential_command`/`commit_file_backed_admitted`; plugin-virtual source status: `write_source` |
| admin credential batch | `CredentialDb::command()` + `apply_documents` |
| built-in OAuth logins (incl. xAI/Meta/Kimi/Claude/Codex) | `save_if_pending` -> owner `render_login`/`retain_login`, or `save_login(Some(&save), ...)` into the owner render |
| Vertex import | `oauth::import` -> `CredentialDb::write_files` |
| SIWC bind | `siwc` completion -> `granted_command` |
| plugin host save | `plugin_auth` -> `command()`/`granted_command()` -> `save` / `write_files` |
| plugin OAuth callback | completion -> `command()`/`granted_command()`; `write_callback_file` only publishes Go's `.oauth-<provider>-<state>.oauth` relay file, not a credential document |

The only other direct filesystem writer, `auth_files::write_file`, is called from `save_xai_login` inside `save_login`'s owner callback and from no request handler. Evidence by clause, with private loopback/mock fixtures only:

| Clause | Tests |
| --- | --- |
| Raw document retention | `credential_batch_preserves_bytes_and_is_in_the_portable_snapshot`; `a_plugin_save_applies_the_files_settings_and_persists_as_go_does`; `completed_siwc_binding_is_retained_before_cache_identity_or_hydration_effects`; `management::vertex_service_account_import`; `patch_persists_atomically_preserves_unknown_fields_and_rejects_stale` |
| Atomicity | `credential_batch_saves_and_deletes_atomically_with_raw_source_conditions`; `credential_batch_rejects_a_later_invalid_or_conflicting_document_without_partial_writes` |
| Stale-edit protection | `sqlite_external_downloads_use_source_bytes_and_stale_edits_cannot_resurrect_deleted_auths`; `patch_persists_atomically_preserves_unknown_fields_and_rejects_stale`; `terminal_builtin_login_withholds_only_its_unchanged_valid_destination`; `a_use_siwc_edit_go_cannot_parse_leaves_a_refresh_in_flight_alone` |
| Notification behavior | `watching::credential_notification_reloads_same_connection_saves` (credential notification reloads without config publication); `management::watcher_keeps_last_good_auth_and_reconciles_disabled_deleted_and_self_writes`; `ordered::rejected_dry_run_and_other_domain_commands_do_not_notify_configuration` (credential and cooldown commands do not notify configuration) |

#### Parent closure — task 4.3

| Refresh source | Owner path with registration/version checks |
| --- | --- |
| request (401) | `dispatch` -> `Runtime::refresh_after_unauthorized` -> `commit_refresh` with a `RefreshFence` (registration, version) |
| background | 401 background refresh and plugin `refresh_schedules` -> the same `commit_refresh` |
| forced (management) | `auth_files::refresh` -> `Runtime::refresh_credential` -> `commit_refresh` / `apply_refresh` |
| plugin | `plugins::refresh::refresh_once` returns a patch tagged with registration and credential version (`AuthSaveJob::Refresh`); the runtime commits it through `commit_refresh` |
| Codex | `refresh_codex_file` -> `granted_command` -> `save_codex_refresh` |
| normalization | `commit_file_backed_admitted`; `cooldown_credential_normalization_leaves_async_worker_and_runs_once_per_revision`; `failed_sqlite_saves_never_publish_patches_equal_file_commits_or_normalization` |

| Clause | Tests |
| --- | --- |
| Replaced credentials are not overwritten by stale results | `stale_result_does_not_overwrite_a_refreshed_credential`; `a_refresh_meeting_an_edit_then_a_new_registration_fails_as_stale`; `a_codex_refresh_is_discarded_when_the_credential_was_replaced_meanwhile`; `a_codex_refresh_is_discarded_when_the_credential_version_moved_meanwhile`; the plugin refresh test refusing a replaced credential (`plugins/refresh.rs`) |
| Cancellation keeps a grant already responsible for persistence | `a_cancelled_refresh_holds_the_preparation_lock_through_its_commit`; `a_cancelled_codex_grant_survives_sqlite_reopen_without_working_files` (durable bytes, reopen and cold backup); `a_cancelled_codex_refresh_writes_its_tokens_before_another_process_reads_the_file`; `shutdown_stops_codex_lock_waits_and_drains_started_grants`; `shutdown_waits_for_owned_background_refresh_before_cleanup`; `plugin_owned::shutdown_waits_for_an_issued_native_scope_without_cancelling_its_save` |

#### Parent closure — task 4.4

| Clause | Evidence |
| --- | --- |
| Grant checkpoint vs runtime admission as explicit transitions | `CredentialDb::granted_command` (consumed-grant writer that may enter during a pending publication), `defer_grant_publication` / `resolve_grant_publication`, and `ConfigStore` grant-source fences (`block_grant_source`, `required_source`) separate durable grant persistence from runtime admission. |
| Granted-but-discarded results are durable where required | `pending_publication_preserves_two_inflight_codex_grants`: both grants retain their rotated refresh tokens and opaque fields across recovery and in a cold copy; `a_cancelled_codex_grant_survives_sqlite_reopen_without_working_files`. |
| No false runtime-credential publication | The same pending-publication test refuses `prepare_credential` and a stale edit until recovery; the discard tests keep the replacement's or editor's revision and tokens in runtime and file; `a_discarded_adopt_only_codex_refresh_changes_nothing`; `pending_publication_preserves_generic_oauth_grants_without_admitting_old_tokens`; `pending_virtual_grant_is_held_without_rewriting_its_source_and_admitted_once`. |

All named tests passed in the final `ci3` workspace run. Limits: no live provider traffic; the Go comparison of discard rules rests on the existing Go-derived refresh tests.

#### Parent closure — task 5.1

| Clause | Evidence |
| --- | --- |
| Reuse the existing authenticated client and an explicit online context | `config_cli::run` treats a non-empty `--management-base-url` as the explicit online context before opening any database, refuses online config commands other than `import`, and submits through the existing `tui::Client` (`import_config`: revision read, conditional `POST /admin/v1/import`). The client is `cpa_exec::proxy::default_client()` with no certificate-verification bypass. |
| Valid import reaches the running owner | `config_cli::online_import_uses_the_owner_without_local_fallback`: the owner's store and runtime both report the imported port, and the selected local database is byte-identical. |
| TLS/auth/destination checks stay effective | The same test: wrong key, unreachable listener and an `https://` URL against the plain listener all fail without echoing the key. `tui::client::config_import_preserves_its_condition_and_never_turns_a_redirect_into_success`: the import keeps its `If-Match` and a 3xx is an error that is never followed. |
| Unauthorized/unreachable requests leave the local database unchanged | Each failure, and an owner storage failure (HTTP 500), leaves both the local database and the owner's published file and runtime unchanged; the owner accepts the next import after storage is repaired. |

Online export/validate/backup are not offered; they read the published file locally (task 5.4).

#### Parent closure — task 7.1

| Clause | Evidence |
| --- | --- |
| Interval, hash/metadata/data-version polling and external-snapshot adoption removed | Production sources contain no configuration interval, `data_version`, content-hash or metadata polling; `watching::start` waits only on owner credential notifications, plugin-auth notifications and cancellation. Measured: the unchanged Linux idle gate (release build, netns isolation) reports **0 wakeups / 0 CPU ticks / 4 threads** for 1 and 2,000 credentials, where master and the previous PR39 head measured 152–157 wakeups on CI (`/var/tmp/cook-router-parent-batch/perf/`, `master-ci/`, `pr39-ci/`). |
| Out-of-band replacement is not hot-adopted | `watching::database_watcher_keeps_owner_state_after_external_snapshot_replacement` (an independent artifact copied over the published path changes neither runtime nor a later legitimate command's portable copy); `watching::a_replaced_snapshot_does_not_publish_on_reload`. |
| Internal notifications still work | `watching::credential_notification_reloads_same_connection_saves`; the replacement test's authenticated command still updates the owner. |
| No startup/read path starts another watcher | `watching::start` callers: `cook-router` main once (not in Home mode), the actual harness and the login harness. Read-only CLI commands open the published file read-only and start nothing; the idle gate's thread count is 4. |

Online writers routed before this closure: every built-in login flag, Vertex import, SIWC bind, native plugin commands and `config import` (task 5.3 slices). The remaining 5.3 question, nested Claude legacy aliases, is a parity gap, not a writer that relied on polling adoption.

### Parent CI repair pass — ci-ok lanes against PR39 and master

Failed-job logs for the stale PR39 head (`8a48b742`, merge `af2e8369`) and for master runs `42747534699` (`5b0c02df`) and `43068570103` (`4ed271f7`, CI-title docs only) are in `/var/tmp/cook-router-parent-batch/{pr39-ci,master-ci}/`. Local evidence is in `perf/`, `rss-ab/`, `ui-check.log`, `notices-check.log`.

| ci-ok lane | Remote failure | Local state of this tree |
| --- | --- | --- |
| Linux idle gates (1 / 2,000) | wakeups 152–157 on master and PR39 | **0 wakeups, 0 CPU ticks, 4 threads** for both (release build, netns). 2,000-file RSS 81,428 ≤ 85,241. |
| Linux idle RSS, 1 file | master 28,592 (fail) and 27,988 (pass) with identical code; PR39 28,576 | Same-machine paired A/B, three alternating rounds: master 16,784 / 17,128 / 17,144 KB, this tree 16,968 / 17,484 / 17,428 KB (mean +274 KB, about +1.6%). A separate first run on this host measured 29,240 KB for the same branch bytes, so absolute local RSS is not comparable with the runner; only the paired delta is. The ceiling is marginal on master itself. `bench/budgets.txt` is unchanged. |
| Size | — | binary 47,548,224 / text 32,081,146 / rodata 9,238,297 / archive 21,030,266 bytes, 5 duplicate crates: all within budget. |
| fmt, clippy, harness, media relay (Linux) | `harness/rust/Cargo.lock` stale under `--locked` (master too) | lock updated; `ci3` harness check, fmt, workspace clippy and `--features media-relay,pprof` pass. |
| Windows clippy | `unused_mut` in `published.rs` | fixed earlier; a second Windows-only `unused_mut` in `management/oauth.rs` `PrivateLoginRender` now uses the same shadowing pattern. **Not compiled for Windows locally** (no Windows SDK). |
| dashboard | `check:i18n` 7 violations (master too) | two computed `t()` keys rewritten as literal calls, which also uses the copied/copy-failed strings; `keys.add.duplicate`, orphaned when #33 removed the dashboard's duplicate-key check, removed from all three locales; the two new admin credential routes allowlisted for `check:api` with reasons. `npm run check` passes; `npm run build` regenerated `ui/dist`. |
| third-party notices | stale (master too) | regenerated with the pinned cargo-about 0.9.3 (installed task-scoped under `/var/tmp/cook-router-tools`); `--check` passes; local `node_modules` matches `package-lock.json` for every non-optional package. |
| fragments | no fragment | `changes/sqlite-snapshots.md` rewritten for the current design (it still described per-second polling); `tools/changelog.py check` and tool unit tests pass. |
| tests (Linux shards) | watching-test teardown races in the old code | `ci3` workspace `cargo test` 2151/0/2; nextest sharding under `unshare --net` not reproduced locally. |
| macOS / Windows idle-gate jobs (they run server tests first) | watching tests: directory not empty / sharing violation (Windows) | **Unproved locally.** |

Only a CI run on a pushed head can settle Windows, macOS, sharded nextest and runner RSS.

#### Parent closure — task 5.3

Whole-caller inventory (live `crates/cook-router/src`): every credential-persisting CLI flag is a `BuiltinCommand` selected by `selected_command` (Vertex import, SIWC bind, Antigravity, Codex browser/device, Claude, Kimi/Kimi.ai, xAI, Devin, Meta). With `--management-base-url` all of them go through `online_command` -> `online_login_save` before any local store opens; unknown plugin flags go through `online_plugin_command`; `config import` goes through `tui::Client::import_config`. Without it, each is an offline writer that requires exclusive ownership (task 5.4). No other CLI path writes credentials.

| Clause | Evidence |
| --- | --- |
| Private client scratch and the common save/acknowledgement boundary | `online_login_save`: the provider renders into a private `cook-router-login-*` scratch directory, the callback runs on an owned, awaited blocking worker and returns only after the owner's batch receipt; the plugin host uses the same conditional port with a nonblocking operation permit (slices above). |
| No writes reach server caches or SQLite directly | `config_cli::online_vertex_import_stages_privately_and_never_falls_back_on_one_worker` and `online_native_plugin_host_save_and_returned_auths_share_the_owner` (local database byte-identical, no local credential cache, explicit server-cache paths refused); `main.rs::online_builtin_flows_wait_for_durable_save_and_preserve_source_fences` (Codex device, Kimi, Claude, xAI against the real management router); `online_siwc_destinations_keep_owner_identity_without_client_filesystem_access`. |
| Single-worker async runtime | The `config_cli` online tests run the real binary with `TOKIO_WORKER_THREADS=1`; the plugin test is `current_thread`. |
| HTTP failure | Storage failure (HTTP 500), source replacement or deletion (412), authentication and transport failures, and redirects/incomplete receipts all fail without local fallback (`storage`/`replaced`/`deleted` cases, `tui::client::credential_batches_reject_redirects_and_incomplete_acknowledgements`). |

Accepted limits: Meta, Devin and Antigravity are source-verified migrations of their save effect onto the same port, without new full browser/device-flow end-to-end tests. Nested Claude legacy aliases are not migrated by online or dashboard logins; the user accepted recording this as a limitation (documented in `CONFIGURATION.md` and `DIFFERENCES-FROM-GO.md`). Minimal secret-bearing inputs remain task 6.2.

#### Parent closure — task 7.2

Evidence root: `/var/tmp/cook-router-parent-batch/task72/` and `gate4/`; the change is `task72.patch` relative to the staged first commit.

| Clause | Evidence |
| --- | --- |
| Retire the online multiwriter coordinator | `published.rs` no longer creates `coordination.db` or takes a cross-database `BEGIN IMMEDIATE` lock at startup, publication, working connection or cleanup. The native per-database ownership guard is the only cross-process exclusion; in process a per-database `Mutex` keeps an open working connection and checkpoint replacement apart (no reentry, documented in `STATE-AND-CONCURRENCY.md`). Layout RED: `opening_fresh_databases_serializes_migrations` failed while `coordination.db` was still created (`red-coordinator.log`). Behavior: `databases_sharing_a_temporary_namespace_publish_independently` commits one database while another database's working connection is held, and still refuses a second owner of the same database; restoring only the old coordinator makes it time out after 5 s (`control-old-coordinator.log`); restored. |
| Retire ref-marker machinery | No PID, `refs/` or multi-handle registry is created or consulted (source grep); `initializing_another_database_does_not_sweep_other_namespaces` keeps a foreign workspace with `refs/0` and `live.db` untouched. |
| Restrict mutable escape hatches | `cpa_server::testing` (raw fixture SQL `database_execute`, raw working `database_connection`, private-namespace `config_store`, failure injection) and its supports `ConfigStore::fixture_execute`, `open_in` and `working_directory`, plus the test-runtime credential guard, compile only under `cfg(test)` or the new `testing` feature. The feature is enabled by cpa-server's and cook-router's dev-dependencies and by the two harnesses, never by a shipped build: `gate4/shipped-features.txt` lists only cpa-server's `default` feature, and no-feature `clippy -p cpa-server --lib` and `-p cook-router --bins` pass. Production `ConfigStore` exposes typed commands, reads and `backup`; `CredentialDb` exposes credential commands. |
| Whole-repository caller audit including harness and test wiring | `cpa_server::testing` users: cpa-server unit and integration tests, cook-router unit tests (`#[cfg(test)]`) and `tests/config_cli.rs`, `harness/rust` and `ui/scripts/login-harness`. Production `ConfigStore::open` callers: `cook-router` main and `config_cli` only; the one test that used it (`runtime.rs` cold-copy check) now uses the private fixture namespace. `watching::start` callers are listed under 7.1. |
| Permitted private SQL stays behind the service | All SQL is in `config_store` (`db`, `encode`, `history`, `published`) and the gated fixture helpers. |
| Fixtures cannot sweep a production workspace | `testing::config_store` roots workspaces at `<fixture-parent>/.cook-router-test-storage`, never `<TMPDIR>/cook-router`; cleanup removes only the owner's own path-hash directory under its ownership guard, and another database's workspace is never swept (test above). This is enforced by the fixture and the cleanup rule, not by a type barrier: `ConfigStore::open` stays public for the CLI. |

Gates (`gate4/steps.jsonl`, Rust frozen): fmt, no-feature lib/bin clippy, shipped-feature check, harness `--locked` check, workspace all-target clippy, workspace `cargo test` **2152 passed / 0 failed / 2 ignored** (the same pre-existing ignores), `alloc_budget` pass. `Cargo.lock` gains only cpa-server's self dev-dependency edge; `harness/rust/Cargo.lock` is unchanged.

#### Parent closure — task 7.3

User decision (product-visible, asked during this pass): online CLI commands read the management key from `--password`, else `COOK_ROUTER_MANAGEMENT_KEY`, else a non-echoing terminal prompt, so onboarding never puts the key on argv. Evidence root: `/var/tmp/cook-router-parent-batch/key-env/`.

| Clause | Evidence |
| --- | --- |
| CLI guidance matches the boundary | Online logins, Vertex import, SIWC, plugin commands and `config import` share `management_key` (`main.rs`, `config_cli.rs`). RED: `online_import_uses_the_owner_without_local_fallback` extended with an environment-only import failed with HTTP 401 `missing management key` (`red-env-key.log`); GREEN 10/0 (`green-env-key.log`), including a keyless non-interactive import that the owner refuses with no change. Precedence unit test passes (`green-env-key-unit.log`). A PTY run shows the prompt, no echo of the typed key, and the key on the request (`pty-prompt.txt`). `cook-router` tests 205/0, clippy `-D warnings` passes. GETTING-STARTED, AI-SETUP, INSTALL (host, Docker, systemd), MULTI-ACCOUNT, MIGRATING-FROM-GO and CONFIGURATION now route sign-ins and imports to a running service through `--management-base-url`, state that an offline write is refused as `already owned`, and keep offline `--db` sign-in for a stopped service. CONFIGURATION's config-command intro no longer claims read-only commands are refused under an owner. |
| Link the accepted design contract and separate current from target | CONFIGURATION opens with the State and concurrency link and says the operational details are not a completion claim; MIGRATING and CONFIGURATION no longer describe the retired coordinator, PID checks or `VACUUM INTO`. |
| Keep the single-file copy promise | CONFIGURATION "Database safety and backup", GETTING-STARTED security notes and MIGRATING backup text: copy the `--db` file while running; `config backup` encodes accepted state into a standalone file. |
| Deliberate cold restore | CONFIGURATION "Restore a backup instead of resuming" and MIGRATING: stop every owner, remove only the stopped owner's working directory or select a fresh namespace, never delete ownership guards, then copy the backup. |
| Temporary-storage loss without promising tmpfs survives reboot | CONFIGURATION: the published snapshot is the durable recovery source if OS tmp is lost. INSTALL Docker: tmp needs no persistence; losing it seeds from `/data/cook.db`, and only a change reported as failed may be lost. INSTALL systemd: `PrivateTmp=yes` cold-starts every service restart and a tmpfs `/tmp` every reboot. STATE-AND-CONCURRENCY: a tmpfs can disappear on power loss. |

`changes/sqlite-snapshots.md` names the key sources; `tools/changelog.py check` passes.

#### Parent closure — task 6.2

User decision (asked during this pass): add a per-resource secret read rather than keep the full export or use a redacted read that loses credentialed proxies. Evidence root: `/var/tmp/cook-router-parent-batch/resource-secret/`.

| Clause | Evidence |
| --- | --- |
| Consumers take the supplied authorized view | Management's required installer (`management.rs` `install_configuration_and_notify` → `accept_configuration`) receives the committed `ConfigurationView` and feeds access (`config_published`), logging (`logging::configure`), usage (`usage_queue().configure`), policy and the runtime view (`install_service_configuration`) from it, then credential reconciliation (`publish`) from the installed runtime config. Plugins, catalogs, Artificial Analysis, pprof and watching follow `Runtime::subscribe_config` and read the installed `rt.config()`; none calls `ConfigStore::load`, re-reads YAML or keeps a second writable cache. `stored_config` (legacy reload adapter) checks the stored revision and returns the installed runtime config. |
| Observe the committed version | `committed_configuration_reaches_access_and_runtime_and_credential_commits_do_not` (additive, passed first run): an `/admin/v1/apply` adding a client key and changing `routing.retry` returns `X-Cook-Published-Revision` equal to its revision, the new client key authenticates `/v1/models` immediately, and `rt.config()` carries the new retry count. Also `ordered::service_commit_updates_bound_runtime_before_returning` and `required_runtime_views_precede_even_preexisting_change_subscribers`. |
| Only relevant domain changes | The same test: a credential batch leaves the installed runtime config `Arc` identical, the `subscribe_config` watch unchanged and the configuration head unchanged. `ordered::rejected_dry_run_and_other_domain_commands_do_not_notify_configuration` covers credential, cooldown, rejected and dry-run commands. |
| No ambient-global reload | No consumer reloads configuration from disk, environment or a global. Two process-environment inputs remain and are Go-parity deployment inputs, not configuration state: `logging::resolve_log_dir` reads `WRITABLE_PATH` and probes `./logs` when the log output changes (Go `ResolveLogDirectory`), and `management/access.rs` reads `MANAGEMENT_PASSWORD` once at construction. Recorded for the 8.4 review. |
| No unnecessary secret-bearing export | In process, `export_json` is called only by the admin export route and `config export`; consumers receive views, not exports. The online CLI added by this change fetched `export?include_secrets=true` for every built-in login. RED: `online_builtin_flows_wait_for_durable_save_and_preserve_source_fences`, extended to assert the login configuration has no unrelated section or secret, failed with `[config-version, oauth, requests, server]` (`red-cli.log`). The server now accepts `GET /admin/v1/r/{kind}/{id}?include_secrets=true`, revealing only that resource (RED: `$secret`, `red.log`; GREEN: `one_resource_can_be_read_with_its_secrets_without_the_full_export`, admin_contract 24/0). `login_config` reads only `requests` with secrets (a proxy URL can carry credentials) and the SIWC identifier from the redacted `oauth`; only the owner's structured `not_found` means absent; both reads refuse redirects. Plugin commands keep the full secret export as their raw configuration, as in Go (`plugin_config`). cook-router 206/0; clippy `-D warnings` passes. |

Follow-up outside this task's in-process scope: the dashboard's and TUI's single-secret reveal still read the full secret export and could use the per-resource read.

#### Parent closure — task 6.1

Source: `config_store/notifications.rs`; tests in `config_store/tests/ordered.rs` (cpa-server lib, green in gate4).

| Clause | Evidence |
| --- | --- |
| Owned function-callback registration | `subscribe_configuration` returns a `ConfigurationSubscription`; dropping it removes the callback by ID through a `Weak` list reference, without taking the command gate. After drop no event arrives: `registering_concurrently_with_publication_has_no_version_gap` (later import, `rx.try_recv().is_err()`) and `destroying_callback_captures_unsubscribes_without_the_list_lock`. |
| Atomic initial view | Registration takes the writer, builds the view from current state and inserts the callback before delivering `Initial`, so no commit falls between. `registering_concurrently_with_publication_has_no_version_gap` races registration with a commit 16 times and accepts only `[new]` or `[old, new]`; `initial_binding_wins_over_a_racing_volatile_publication`. Management registers its installer and notifier together (`install_configuration_and_notify`). |
| Version-ordered delivery outside state/list locks | `dispatch_configuration` clones the callback lists under the list mutex, releases it, then invokes installers, then ordinary callbacks, in commit order before the command returns. `callback_errors_reads_unsubscription_and_owned_followup_do_not_deadlock` receives `(rev, 8102)` then `(rev + 1, 8103)`; `required_runtime_views_precede_even_preexisting_change_subscribers`. A capture that owns another subscription is dropped after the list lock is released (`ConfigurationSubscription::drop`; destroying-capture test). |
| Read reentrancy | The callback in `callback_errors_reads_unsubscription_and_owned_followup_do_not_deadlock` calls `store.load()` and sees the delivered revision. |
| Synchronous mutation reentry refused | `check_reentry` (thread-local dispatch marker) rejects commands from inside a callback; the same test asserts the reentrant `import_yaml` errors. |
| Self-unsubscription | The same test drops its own handle inside the callback; the later command is not delivered to it. |
| Subscriber failure isolation | Ordinary callbacks run through `notify`: an error or panic (`catch_unwind`) is logged without its text and later subscribers still run (failing subscriber in the same test). Required installers propagate failure and keep the event for replay (`required_projection_failure_retains_recovery_and_withholds_ordinary_success`, `management_retries_an_interrupted_projection_before_success_notifications`). `dispatch_pins_unlock_before_error_panic_and_failed_registration_cleanup` covers unlock on error and panic. |
| Later-command scheduling without deadlock | The callback sends owned follow-up work to a worker thread, which commits after the dispatching command returns; both versions are delivered in order and the worker joins. `explicit_shutdown_drains_normalization_queued_behind_the_owner_before_cleanup` covers owned work queued behind the owner. |

#### Parent closure — task 1.1

Baseline tree: `2eca0edd` (the rebased `8a48b742`, before this change's implementation), archived to `/var/tmp/cook-router-baseline-src` and built in the separate `/var/tmp/cook-router-master-target`. Evidence root: `/var/tmp/cook-router-parent-batch/baseline11/`. The two black-box scripts run the real binary in a network namespace with a private home and TMPDIR.

| Example | Before implementation | Final tree |
| --- | --- | --- |
| Memory-only query: an authenticated export still answers while live persistence is locked | Phase 00 RED above: HTTP 500 `store_failed` (`committed_config_remains_readable_when_persistence_is_unavailable`) | Passes (admin_contract 24/0) |
| Sole online ownership: with a service running on key k1, an offline `config import` adding k2 is refused as already owned and the service never accepts k2 (`acceptance.sh`) | RED: the import succeeded (`Imported revision 2`) and the service accepted k2 within two poll intervals (`acceptance-baseline.log`) | PASS: refused with `already owned`, k2 still 401 (`current/`) |
| Commit/publication order: when a running-service `config import` reports success, the service already accepts k2 and a copy of the published file contains it (`acceptance-order.sh`) | RED: the baseline has no online config import, and its offline import reported success while the service still rejected k2 (`acceptance-order-baseline.log`) | PASS: the owner import reported success with k2 already accepted and present in a copied file (`acceptance-order-current.log`) |

In-repository equivalents: `config_cli::online_import_uses_the_owner_without_local_fallback` and `a_live_owner_allows_snapshot_reads_and_refuses_offline_logins`, plus `ordered::service_commit_updates_bound_runtime_before_returning`.

Named historical tests, rerun this pass:

| Test | `2eca0edd` | Final tree |
| --- | --- | --- |
| `usage_record::tests::redirects_start_the_upload_measurements_over` | FAIL at `usage_record.rs:3593` (redirect retains `upstream_body_sent_ms`), as in phase 00 | PASS. Commit `e221d09e` changed only the test: its exchange now uses a client with a 64 KiB TCP send buffer instead of the shared timed client, so the partial-upload case no longer depends on host TCP autotuning. Flagged for the 8.4 review because the test no longer goes through the executor's shared client. |
| `watching::tests::incomplete_documents_keep_the_credential_until_valid_json` | PASS | PASS |

#### Parent closure — task 6.4

| Clause | Evidence |
| --- | --- |
| Explicit job inputs and results with relevant fences | Refresh and grant jobs carry the dispatched credential, its registration and its credential version, and adoption rechecks them inside admission (table under "A. One admitted command, before reload and per-ID guards"). Online CLI jobs receive explicit inputs: `login_config` (two settings), `credential_sources` (original bytes plus raw SHA-256) and a private scratch `auth_dir`; their result is one conditional batch (`if_match` / `if_none_match`). Admin handlers run on the blocking pool with an `Arc<Management>` and read one immutable snapshot. |
| Ambient configuration, CWD and environment do not alter the supplied computation | `readers_keep_the_previous_complete_view_during_a_slow_mutation` (a read keeps its complete view while a mutation is in flight). `online_import_uses_the_owner_without_local_fallback` now also runs an online import with `COOK_DB`, a working-directory `config.yaml` and a `.env` naming another database: the owner commits the supplied file and neither ambient database is created (additive, passed first run, `key-env/ambient.log`); the same test keeps an explicit local `--db` byte-identical. Online logins never read the local `--db` or `--config` and render into a private scratch directory (`online_builtin_flows_wait_for_durable_save_and_preserve_source_fences`). Source: owner paths are canonical absolute paths fixed at open. The one environment/CWD read on a configuration change is the Go-parity log directory probe recorded under 6.2. |
| Stale results cannot overwrite current state | `a_codex_refresh_is_discarded_when_the_credential_version_moved_meanwhile`, `stale_result_does_not_overwrite_a_refreshed_credential`, `an_in_flight_refresh_does_not_overwrite_newer_credentials`, `stale_lease_cannot_poison_deleted_and_recreated_credential`, `a_stale_scan_cannot_undo_a_later_write` (runtime); `a_refresh_from_an_earlier_registration_leaves_the_new_ones_schedule` (plugin_owned); `held_virtual_grants_recheck_registration_version_and_source_at_recovery`; `config_reloads_never_publish_a_value_older_than_a_save` (management); online login save returns 412 for a replaced or deleted source and never resurrects it (`online_builtin_flows_...`). |
| Unrelated changes do not spuriously reject valid output | `pending_publication_preserves_two_inflight_codex_grants` (two distinct grants both survive); `consumed_grant_survives_a_checkpoint_error_and_merges_the_next_result` (a retained grant whose checkpoint failed survives an intervening unrelated configuration command and a second grant; after recovery both grants land and the unrelated, uninstalled mutation does not revive); `terminal_builtin_login_withholds_only_its_unchanged_valid_destination` (management/oauth): an unrelated configuration commit cannot settle the exact-source fence and the valid replacement is still adopted; `credential_like_resource_ids_survive_effective_reads_and_unrelated_sets`. |
