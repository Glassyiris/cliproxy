# Contributing

Thanks for helping. Bug reports, fixes and new tests are all welcome.

## Before you start

- For a larger change, open an issue first so we can agree on the approach.

## Building and testing

You need Rust (stable), `cmake`, `clang` and `perl` for BoringSSL. Go 1.26 and PostgreSQL let the plugin and storage tests run instead of skipping; with `CPA_TEST_NO_SKIP=1`, as in CI, those tests fail instead.

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

CI runs the same tests with [cargo-nextest](https://nexte.st), which runs test binaries in parallel (`cargo nextest run --workspace --locked`; its settings are in `.config/nextest.toml`), then the doc tests, and cpa-server's unit tests with the optional relay: `cargo test -p cpa-server --features media-relay --lib`.

Tests use local mock upstreams only. Never point a test at a real provider or use a real account or key, and run the tests with external network access blocked if you can; CI runs them in a network namespace with only a loopback interface. The BoringSSL build and the release link use a lot of memory, so on a small machine set `CARGO_BUILD_JOBS=2`.

### Performance budgets

CI holds the binary to the numbers in [`bench/budgets.txt`](bench/budgets.txt), and it counts events and bytes, never elapsed time:

- Size, on every push to master and on pull requests that can change the binary (see `.github/scripts/ci-lanes.py`): the Linux release binary, its `.text` and `.rodata`, the release archive, and the number of crates linked in more than one version.
- Idle, on the same changes: [`bench/idle.sh`](bench/idle.sh) with 1 and with 2,000 auth files: wakeups, CPU ticks, threads and RSS over 30 seconds without requests.
- Heap per request: `crates/cpa-server/tests/alloc_budget.rs`, part of `cargo test`, sends one 306 KB and one 1.9 MB request through the Claude route, the same sizes through Claude count_tokens (counted locally) and through the Codex Responses route, and the Claude bodies cloaked and signed through a Claude OAuth login with request capture, one at a time and eight at once, under a counting allocator.
- macOS and Windows idle, in the release builds and weekly ([`idle.yml`](.github/workflows/idle.yml)). Memory soaks ([`soak.yml`](.github/workflows/soak.yml), [`bench/soak.sh`](bench/soak.sh)): one hour of the Claude load and one hour of the field mix (Claude, Codex and count_tokens requests of 200 KB to 2 MB) on every release tag, 300 minutes of the field mix every week, and up to 330 minutes by hand before a release. The resting RSS must stay flat, and the field mix's peak (`VmHWM`) within its budget.

To run the Linux gates locally, build with `cargo build --release -p cook-router`, then run `bench/gate.sh size x86_64-unknown-linux-gnu target/release/cook-router` and `bench/gate.sh idle linux target/release/cook-router 1`. The size lines and the dashboard's `ui/tools/size-budget.json` are ceilings with headroom, so an ordinary pull request does not edit them; each pull request instead gets a size report comment with its numbers next to master's and the ceilings ([`.github/ci/report`](.github/ci/report/README.md)). Raise a ceiling or budget only when a change needs it, with a maintainer's approval, and give the reason next to the line.

The dashboard lives in `ui/` (React 19 and Astryx). `npm ci`, `npm run check`, `npm test` and `npm run build` there; the build also checks the bundle size budget. See [ui/README.md](ui/README.md).

## Changelog fragments

Do not edit `CHANGELOG.md` in a pull request. Add one file, `changes/<branch-slug>.md`, whose first line is `Added`, `Changed`, `Fixed`, `Removed`, `Security` or `Internal`, followed by `- ` bullets that say what users see change:

```markdown
Fixed

- The relay stops waiting when the upstream request times out.
```

A pull request that touches shipped code needs a new fragment: `crates/`, `ui/src/`, `ui/dist/`, `ui/public/`, `ui/index.html`, `install.sh`, `install.ps1`, `Dockerfile`, `vendor/`, `Cargo.toml` or `Cargo.lock`. Tests and documentation do not. A maintainer can apply the `no-changelog` label when an entry is unnecessary. The `Changes` workflow checks every fragment; `python3 -I tools/changelog.py check` runs the same check locally and `python3 -I tools/changelog.py render` previews the Unreleased section. [changes/README.md](changes/README.md) has the full rules and the release command.

## Pull requests

- Fill in the [pull request template](.github/pull_request_template.md); a Chinese template is available through its first link. Name the person who answers for the change. You may use AI to help write it, but you must have read and verified every line, and you answer for it.
- Keep each pull request to one change, with a test that fails without it.
- Keep each pull request's commits signed; they are squashed when it merges.
- Request bodies are forwarded byte for byte unless a ported rule rewrites them; do not re-serialize JSON just to pass it through.
- Never log or forward credentials or client keys to the wrong side.
- Mark a deliberate simplification with a `ponytail:` comment that names its limit and how to lift it.
- CI must pass: the `ci-ok` check, which requires every lane the change selects (format, clippy, tests, the harness check, clippy on Windows with all targets and warnings as errors, the Linux size and idle gates, the dashboard checks and actionlint), the changelog fragment check (`fragments`) and the title check (`title`). To run every lane, add the `ci:full` label and re-run the CI workflow.
- A ruleset protects `master`, and nobody can bypass it, administrators included:
  - every change goes through a pull request and is squash-merged;
  - `ci-ok`, `fragments` and `title` must pass. A branch behind `master` can still merge; GitHub refuses only when the two conflict;
  - force pushes, deletion and merge commits are blocked.

## Commits and pull request titles

Pull requests are squash-merged: the pull request title becomes the commit subject on `master`, and GitHub appends the number, as in `fix(ui): keep Overview tiles whole on a phone (#41)`. The description stays on the pull request, so write why there.

- Write the title as `type(scope): subject`. Types: `feat`, `fix`, `refactor`, `test`, `style`, `chore`, `docs`, `deps`, `ci` and `release`. Scopes: `cli` (crates/cook-router), `server`, `exec`, `translate`, `core` (cpa-core and cpa-common), `plugin`, `home` (the matching `crates/cpa-*`), `ui`, `installer`, `docker`, `packaging`, `ci`, `docs`, `deps`, `bench`, `tools` and `release`.
- The subject is an English imperative phrase starting in lower case, such as `retry a reset Claude stream once`, with no full stop. A first word such as `OAuth` keeps its case.
- The whole title fits in 72 characters.
- Commit subjects follow the same grammar. Each commit stands alone; fixups are squashed before pushing, not pushed as `fixup!` commits.
- The `Changes` workflow checks the title and reruns when you edit it. `python3 -I .github/scripts/pr-title.py '<title>'` runs the same check locally. The type and scope lists live in that script.

## Issues

Search existing issues first, then pick a form: bug report or feature request, each in English and in Simplified Chinese. State your version (`cook-router --version`) and how you installed it. Remove keys, tokens and account files from logs and configuration before posting. Usage questions go through [SUPPORT.md](.github/SUPPORT.md), and vulnerabilities through [SECURITY.md](SECURITY.md), never a public issue. Everyone taking part follows the [code of conduct](.github/CODE_OF_CONDUCT.md).

By contributing you agree that your work is released under the [GNU Affero General Public License, version 3 or later](LICENSE).
