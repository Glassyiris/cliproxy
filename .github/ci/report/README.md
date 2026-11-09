# Size report

Every pull request gets one comment that shows its sizes next to `master`'s and the ceilings, so a change that grows the binary or the dashboard is visible without editing a budget.

1. In `ci.yml`, the perf jobs and the dashboard job write the measurements their gates take to `<lane>.json` (`schema.md`) and upload it as `ci-report-<lane>`, even when a gate fails. Only pull requests and pushes to `master` upload: `release.yml` calls `ci.yml` and publishes the artifacts of its run. A lane that did not run uploads nothing, and the comment says why from the job's conclusion.
2. `report.yml` runs when a CI run of a pull request completes. It checks out this directory from the default branch only, downloads the run's `ci-report-*` artifacts and those of the latest successful CI run of a push to `master` created before it, renders the comment with `render.py`, and creates or updates the comment that carries `<!-- cook-router-size-report -->` on every open pull request of this repository whose head is the measured commit. Its token can read actions and write pull requests, nothing else.

Artifacts are untrusted data from the pull request: the workflow checks their names, sizes and contents before it writes them out, and `render.py` reads them as JSON, puts only validated keys, numbers and file names into the comment, and executes nothing.

The ceilings live in `bench/budgets.txt` and `ui/tools/size-budget.json`, and the gates fail above them. Raise one only when a change needs it, with a maintainer's approval.

Tests, run by the changes job on every CI run:

```sh
python3 -I -m unittest discover -s .github/ci/report -p 'test_render.py'
```

To render a fixture, or to refresh its `expected.md` after a deliberate change:

```sh
f=.github/ci/report/fixtures/ordinary
python3 -I .github/ci/report/render.py --candidate $f/candidate --baseline $f/baseline --context $f/context.json --out $f/expected.md
```

A change to `render.py` reaches pull requests once it is on `master`, because `report.yml` runs the default branch's copy.
