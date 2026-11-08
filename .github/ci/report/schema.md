# Size report schema

Each producer writes one UTF-8 JSON object to `<lane>.json` and uploads it as the artifact `ci-report-<lane>`, which holds that one file. The renderer accepts schema version 1 and ignores, with a note in the comment, a file larger than 256 KiB, a lane that does not match its file name or is not in `LANES` in `render.py`, and any field below that breaks its contract.

| Field | Type | Contract |
| --- | --- | --- |
| `schema_version` | integer | `1`. |
| `lane` | string | One of `perf-1`, `perf-2000` and `dashboard`; equal to the file stem. |
| `metrics` | array, at most 64 | One entry per measurement, in display order. |
| `metrics[].key` | string | `[A-Za-z0-9][A-Za-z0-9_.-]{0,99}`, unique in the file. Rust keys are those of `bench/budgets.txt`; dashboard keys are those of `ui/tools/size-budget.json`. |
| `metrics[].value` | integer or null | The measurement, nonnegative; `null` when it was not measured, which is never read as 0. |
| `metrics[].ceiling` | integer or null | The limit the gate applied (for `bench/budgets.txt`, the value times one plus the tolerance); `null` when the metric is reported without one. |
| `metrics[].unit` | string | `bytes`, `kB`, `ms` or `count`. |
| `metrics[].detail` | string, optional | A file name such as the largest lazy chunk's, `[A-Za-z0-9][A-Za-z0-9_.-]{0,99}`. |

Producers:

- `perf-1`: the perf job with 1 auth file. `bench/gate.sh size` and `idle` append one JSON line per check to `$GATE_REPORT`; the job wraps the lines as above. Keys: `size.x86_64-unknown-linux-gnu.{binary,text,rodata,archive}_bytes`, `deps.x86_64-unknown-linux-gnu.duplicate_crates` and `idle.linux.1.{wakeups,cpu_ticks,threads,rss_kb}`.
- `perf-2000`: the perf job with 2,000 auth files, `idle.linux.2000.*`.
- `dashboard`: `node tools/size.mjs --json <file>` in the dashboard job. Keys: `initialJs`, `initialCss`, `largestLazyChunk` (with `detail`), `totalJs` and `totalCss`, gzip bytes of the committed `ui/dist`.

The workflow passes the renderer a context file:

| Field | Contract |
| --- | --- |
| `head_sha` | The pull request head the run measured. |
| `base` | The default branch name. |
| `run_url` | The candidate run's page. |
| `baseline` | `{"sha", "run_id"}` of the baseline run, or `{"reason"}` when there is none. |
| `jobs` | Job name to conclusion (`success`, `failure`, `skipped`, `cancelled`, or `null` while running), the newest attempt of each job up to the run's attempt. |
