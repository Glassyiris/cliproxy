# .github/AGENTS.md: CI rules

The root `AGENTS.md` applies. Commands, limits and enforcement gaps live in root `REQUIREMENTS.md`.
Name this file in briefs for gate scripts outside `.github/`, including `scripts/`.

## CI

### Tiers, jobs and gates

Split checks by cost and timing, without one giant run or one job per trivial check.

| Tier | Existing implementation | Coverage |
| --- | --- | --- |
| Pre-commit | Not yet enforced | Read-only changed-file fast checks; adoption is tracked in `REQUIREMENTS.md`. |
| Merge gate | `ci.yml` builds the `Dockerfile` stages `dashboard`, `check`, `test` (two shards) and `perf`, then smoke-tests and measures the `runtime` image; path selection in `.github/scripts/ci-lanes.py`, `ci-ok`; `changes.yml` supplies `fragments` and `title` | Pushes to `master`, manual runs, release calls and `ci:full` reruns select all lanes. |
| Release | `release.yml` on a `v*` tag calls `ci.yml`, builds `runtime` on native amd64 and arm64 runners, checks the tag against `--version` and the image size, pushes the `<version>-rc` images and creates a draft release; a manual run with the tag promotes them after approval | Every CI lane, both image architectures, the version and size gates. Publication follows root Rule priority. |

Lanes and their rules: `.github/scripts/ci-lanes.py`.

- Keep one job per concern, grouped by area. Use only supported OS/version matrices and caches worth their cost. Duplicate a suite across tiers only for a stated reason. `master` sets no required checks for now; `ci-ok` reports the aggregate result.
- Preserve selector failure safety: unknown/unreadable/empty change sets select all lanes. `ci-ok` requires successful selection, success for selected lanes and skips only for unselected lanes. A selector failure runs all lanes and fails the aggregate.
- Adding `ci:full` does not start a run; rerun the workflow. Record skipped suites and run them on the final commit or in the scheduled tier.
- Run a gate's planted-violation self-test in the merge tier when its script changes; release self-tests cover every Enforcement gate.
- Release-only proof includes reproducibility and a deploy rehearsal.
- Write each check as a `Dockerfile` stage, so `docker buildx build --target <stage> .` runs it locally exactly as CI does. A check that needs pull request data (title, labels, history) runs as a workflow step on the same script.
- Use the same repository scripts locally and in CI. Prefer an existing SHA-pinned action over copying its implementation.
- A check must fail on a planted violation and when it scans no content. Exit 1 means a violation; exit 2 means it could not run. Adapt tool-specific codes explicitly at the gate boundary.
- Fix flakes or quarantine with an owner and a date; never silently retry. Quarantine is the only allowed removal of a check from a gate.
- Keep budgeted builds on the pinned compiler. A compiler or base image bump remeasures size, idle and heap budgets with a dated entry in `bench/budgets.txt`.
