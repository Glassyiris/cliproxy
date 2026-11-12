# cook-router

If you are an agent installing cook-router for a user rather than developing it, stop here and follow [docs/AI-SETUP.md](docs/AI-SETUP.md).

cook-router started as a Rust rewrite of CLIProxyAPI (https://github.com/router-for-me/CLIProxyAPI) and no longer tracks it. Go behaviour is not a target: change routes, config, response shapes and the Management API when a better design calls for it, and migrate every caller (dashboard, TUI, tests, docs) in the same change.

## History

- The port was frozen at CLIProxyAPI **v8.0.35**, commit `ae3ee3be303fb07fb8173279923413005bf32177`. Comments citing Go file paths explain where existing behaviour came from; they do not oblige new code to follow Go.
- Existing Go goldens and comparison tests pin behaviour that has not changed since the port. A change that moves away from a golden updates or deletes that test in the same change; it does not need an entry in `docs/DIFFERENCES-FROM-GO.md`, which records only the differences that predate the split.

## Layout

- `crates/cpa-core`: legacy config import/runtime projection and credential formats. No networking.
- `crates/cpa-common`: provider-neutral, Go-exact helpers shared by translators and executors.
- `crates/cpa-translate`: format translation between the Anthropic, OpenAI and Gemini APIs.
- `crates/cpa-exec`: one module per upstream provider (wire format, auth headers, HTTP client profile).
- `crates/cpa-server`: axum routes, client auth, credential selection, management API.
- `crates/cpa-plugin`, `crates/cpa-home`: the plugin host and Home mode.
- `crates/cook-router`: the binary. Go-style single-dash flags are accepted.
- `ui/` is the dashboard, `harness/` sends the same requests to Go and Rust and compares them.

## Rules

- The full test suite is slow and memory-heavy (the BoringSSL build and the release link). While iterating, run the affected crate or a filter, for example `cargo test -p cpa-exec kimi`; CI runs fmt, `clippy -D warnings` and the whole suite. On a shared or small machine, add `CARGO_BUILD_JOBS=2 nice -n 19`.
- The Go comparison tests in `cargo test` run fully only in CI, inside a network-denied namespace. For a local Go/Rust differential run on Linux, use `./harness/run` (see `harness/README.md`).
- Case mapping and case-insensitive comparison use `cpa_core::gostr::GoStr` (`go_lower`, `go_upper`, `go_eq_fold`, equal to Go's `strings.ToLower`, `strings.ToUpper` and `strings.EqualFold`). Rust's full case mappings differ on non-ASCII input, so `clippy.toml` disallows `str::to_lowercase` and `str::to_uppercase`; keep `eq_ignore_ascii_case` only where the input is ASCII by definition (header names, protocol tokens) or the comparison is explicitly ASCII. An ASCII literal alone is not enough: `go_eq_fold` also matches `ſ` to `s` and the Kelvin sign `K` to `k`.
- Request bodies are forwarded byte for byte unless a ported rule rewrites them. Never re-serialize JSON just to pass it through.
- Upstream credentials and client keys must never be logged or forwarded to the wrong side.
- SQLite is the sole durable authority for configuration and OAuth credentials. YAML is an explicit first-import format, not a watched runtime file or an asynchronously mirrored backup. Config mutations use `/admin/v1` resources and atomic revisions, not the removed v0/v8 config endpoints. Preserve versioned plugin raw data and OAuth-only scope on import; do not silently discard unsupported input. Credential state is separate from config revisions: restoring configuration must never resurrect a revoked token.
- One running process owns a database and serves its state from memory; offline commands that write it are refused while it runs, and online changes go through the management API. The `--db` file is a standalone SQLite snapshot without WAL, SHM or journal companions, published atomically before a commit succeeds, so copying it while the server runs is a complete backup; `config backup` encodes the accepted state into a new file. Keep snapshots, temporary working databases and backups private; logical deletion is not a promise of physical erasure from disk. The invariants are in [docs/STATE-AND-CONCURRENCY.md](docs/STATE-AND-CONCURRENCY.md).
- Upstream request and response capture goes through the shared sink in `crates/cpa-server/src/request_logging.rs`. It redacts `Cookie` and `Set-Cookie` values, credentials in URLs and short keys, and spools large sections to disk. Don't format or log captured bytes anywhere else.
- Keep request preparation linear in the body size. Coding agents send bodies from 100 KB to several MB, so walk a JSON body once and edit by path (see `crates/cpa-exec/src/claude/signals.rs`) instead of searching it again from the start for each element.
- Performance and memory claims come from `docs/BENCHMARKS.md`. `bench/run.sh`, `bench/messages.sh` and `bench/latency.sh` reproduce its scripted workloads; field observations there are labelled as such and are not reproducible on demand.
- Tests use local mock upstreams and never send traffic to real provider accounts. Give every test a private SQLite database and any legacy import a private `auth-dir`; never import real logins from `~/.cli-proxy-api`. Build test runtimes with `cpa_server::testing::runtime`; `cpa_server::testing` compiles only in tests and with the `testing` feature that the dev-dependencies and harnesses enable.
- Mark deliberate simplifications with a `ponytail:` comment naming the ceiling and the upgrade path.
- Prompt-cache changes must keep request semantics and stable prefixes, and show cache-read and cache-write usage for warm, changed-context and idle continuations before merge. Never add inference keepalive pings. `bench/claude-cache-live.sh` runs that check against a live Claude login, by hand.

## Landing a change

`master` must stay green. A change that turns it red blocks every pull request that touches Rust.

- **Never merge with a failing or pending check.** The `master` ruleset requires `ci-ok`, `fragments` and `title`. Do not disable it to land a feature. If CI is red for a reason outside your change, fix that first in its own pull request.
- **Before you open the pull request, run what CI runs** on the final tree and read the results:
  - `cargo fmt --all --check`
  - `cargo clippy --workspace --all-targets --locked -- -D warnings`
  - `cargo nextest run --workspace --locked`
  - `cargo check --locked --manifest-path harness/rust/Cargo.toml`
  - `npm run check` in `ui/`
  - `python3 -I tools/third-party-notices.py --check`
  - after a change to anything that runs while the server is idle: `cargo build --release -p cook-router && bench/gate.sh idle linux target/release/cook-router 1`

  A change too large to check this way is too large for one pull request; split it.
- **A dependency change updates every generated file in the same pull request:**
  - `Cargo.lock`;
  - `harness/rust/Cargo.lock`, which `--locked` refuses to update in CI;
  - `THIRD-PARTY-NOTICES`: run `python3 -I tools/third-party-notices.py` (cargo-about 0.9.3 with `--features cli`; `npm ci` in `ui/` first).
- **Removing a screen or control also removes its message keys** in every locale. `npm run check` fails on unused keys.
- **A background task or thread stops with its owner.** Stop it on drop or shutdown and wait for it. A task that outlives its owner keeps writing into directories that tests then fail to delete (`DirectoryNotEmpty`). Wait on events (a channel, `Notify`, a file watcher), not on a polling timer. The idle server must stay within `bench/budgets.txt`: about three wakeups in the measured window. Raising a budget needs a maintainer's approval and a measured reason.
- **Title the pull request `type(scope): subject`.** The types, scopes and rules are in CONTRIBUTING.md under Commits and pull request titles. The title becomes the squash commit's subject.
- **Claims need their line.** A consequence stated in a pull request or an issue names the code producing it, or is narrowed until it can; say what you did not check. Line numbers come from `origin/master`, not your working tree.
- **A check that could not run did not pass.** If a gate is missing, errors, or produces no output, say so; empty output reads exactly like a clean run.
- **Fix where the paths converge**, not where you first saw the failure: a guard on one loader leaves its siblings failing open.

## Review guidelines

Flag, in order: request or response bytes changed on passthrough; credentials or client keys reaching logs or the wrong side; tests that can touch the network, a real database or a real `auth-dir`; work on a request body that grows faster than linearly with its size; a behaviour change that leaves a caller (dashboard, TUI, tests, docs) on the old contract. Skip style nits that `cargo fmt` and clippy already cover.

## Claude cache telemetry deployment check

Publishing a release or replacing Core's running proxy requires Vayun's explicit
approval. Mock tests do not prove that Core's collector retains the new fields.
After an approved deployment, explicitly enable `observability.usage.claude-cache-telemetry`
alongside usage statistics. Inspect the collector's protected JSONL file without
printing legacy credential fields (hashes remain stable only until proxy restart):

```sh
jq -c 'select(.claude_cache.schema_version == 2) | {execution_id, usage_observed, tokens: {cache_read_tokens: .tokens.cache_read_tokens, cache_creation_5m_tokens: .tokens.cache_creation_5m_tokens, cache_creation_1h_tokens: .tokens.cache_creation_1h_tokens}, claude_cache}' "$USAGE_JSONL"
```

Confirm that normal existing Amp traffic produces ordered start, first-byte, and
end timestamps, final TTLs, stable hashes, and returned TTL buckets. Check both
buffered and streaming requests if both occur naturally. Do not send synthetic
requests to a live login for telemetry-only deployment checks. This rule does not
replace the required live cache-read/cache-write check above for changes to cache
semantics. The usage queue holds at most one hour, so a week-long
study needs a continuous collector and a separate hashed schedule export. See
[Claude cache telemetry](docs/CLAUDE-CACHE-TELEMETRY.md) for replay and limitations.
