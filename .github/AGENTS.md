# .github/AGENTS.md: CI rules

The root `AGENTS.md` applies. Commands, limits and enforcement gaps live in root `REQUIREMENTS.md`.
Name this file in briefs for gate scripts outside `.github/`, including `scripts/`.

## CI

### Tiers, jobs and gates

Split checks by cost and timing, without one giant run or one job per trivial check.

| Tier | Existing implementation | Coverage |
| --- | --- | --- |
| Pre-commit | Not yet enforced | Read-only changed-file fast checks; adoption is tracked in `REQUIREMENTS.md`. |
| Merge gate | `ci.yml`, path selection in `.github/scripts/ci-lanes.py`, `ci-ok`; `changes.yml` supplies `fragments` and `title` | Pushes to `master`, manual runs, release calls and `ci:full` reruns select all lanes. |
| Scheduled run on main | `idle.yml` and `soak.yml` on the default branch, `master` | Weekly macOS/Windows idle, reported Go idle comparison, weekly field-mix soak. Idle also runs for its path-filtered PRs/pushes and manual runs; soak also runs on release tags and manual runs. |
| Release | `release.yml` calls `ci.yml`; `soak.yml` runs separately on tags | All CI lanes, platform builds, non-Linux idle, archive size/checksums, Docker smoke/size and draft release. Manual release runs produce artifacts, not releases. Publication triggers the Homebrew update. |

Lanes and their rules: `.github/scripts/ci-lanes.py`.

- Keep one job per concern, grouped by area. Use only supported OS/version matrices and caches worth their cost. Duplicate a suite across tiers only for a stated reason. `master` sets no required checks for now; `ci-ok` reports the aggregate result.
- Preserve selector failure safety: unknown/unreadable/empty change sets select all lanes. `ci-ok` requires successful selection, success for selected lanes and skips only for unselected lanes. A selector failure runs all lanes and fails the aggregate.
- Adding `ci:full` does not start a run; rerun the workflow. Record skipped suites and run them on the final commit or in the scheduled tier.
- Run a gate's planted-violation self-test in the merge tier when its script changes; release self-tests cover every Enforcement gate.
- Release-only proof includes reproducibility and a deploy rehearsal.
- Use the same repository scripts locally and in CI. Prefer an existing SHA-pinned action over copying its implementation.
- A check must fail on a planted violation and when it scans no content. Exit 1 means a violation; exit 2 means it could not run. Adapt tool-specific codes explicitly at the gate boundary.
- Fix flakes or quarantine with an owner and a date; never silently retry. Quarantine is the only allowed removal of a check from a gate.
- Keep budgeted builds on the pinned compiler. A compiler bump remeasures idle, soak and heap budgets with a dated entry in `bench/budgets.txt`.
