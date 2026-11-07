# Dashboard requirements

Numbers, gates and exceptions for the dashboard in `ui/` and its mapping to the Management API.
The rules themselves are in zakk-workflow `references/requirements.md` and are not repeated here.
When another file under `ui/` disagrees with this one on a number, a gate or an exception, this
file wins. The Rust crates are governed by `CONTRIBUTING.md` and CI, not by this file.

## Applies

| Section | Applies | Note |
| --- | --- | --- |
| Frontend | yes | React 19, Astryx, StyleX, TanStack Query; `CONVENTIONS.md`, `DESIGN.md` |
| Backend | no | Out of scope here; the dashboard does not change Rust code |
| Security | yes | Management key handling. Upstream error detail is shown: the dashboard's users are the proxy's operators, whom the rule allows to see it |
| Money and state | state only | Config and credential writes; no money |
| Admin panel | yes | The dashboard is the admin panel |
| Frontend–backend mapping | yes | `tools/check-api.mjs` |

## Numbers

Limits set by the owner on 2026-11-08 unless noted. Performance baselines are from
`tools/perf/run.mjs` on the old Svelte dashboard, 2026-11-08, Ryzen 9 9950X3D, headless Chrome
157, load average 0.47 / 3.33 / 3.96 at start; a first run without recorded load agreed within 5%.

| Item | Limit | Baseline (date, host, load) | Enforced by |
| --- | --- | --- | --- |
| Merge gate `npm run check`, wall time | 90 s local, 5 min CI | 5.8 s (2026-11-08, desktop, shell and System page) | `tools/check-all.mjs` fails over 90 s |
| Pre-commit checks | none yet; the merge gate is the first tier | — | — |
| Browser end-to-end checks | 60 s each, 5 min total; run before merge, not per commit | pending | review of the run log |
| Performance harness | not a merge gate; run at P2 and before release | — | `tools/perf/run.mjs` |
| Frontend entry chunk, gzip | set after the shell lands | old Svelte UI: JS 53,436 B, CSS 5,351 B (2026-11-07, desktop, load not recorded) | `tools/size.mjs` |
| Frontend total JS + CSS, gzip | set after the shell lands | as above | `tools/size.mjs` |
| Accounts, 1,000 accounts: load to all rows painted | ≤ baseline | 426 ms | `tools/perf/run.mjs` |
| One 10 s poll on Accounts, main thread | ≤ baseline | 101 ms | `tools/perf/run.mjs` |
| JS heap after 5 min of polling | ≤ baseline | 53.2 MB (from 52.0 MB) | `tools/perf/run.mjs` |
| Idle CPU on Accounts | ≤ baseline | 1.2% of one core | `tools/perf/run.mjs` |
| Select all, main thread | ≤ baseline | 313 ms | `tools/perf/run.mjs` |
| Contrast, both themes | body ≥ 10:1, secondary and status text ≥ 5:1 (above WCAG AA, from `DESIGN.md`) | light: body 15.9, lowest 7.05; dark: body 15.1, lowest 5.68 (2026-11-08, browser) | browser measurement, reported per phase |

## Enforcement

| Rule | Gate or review criterion | Command or link |
| --- | --- | --- |
| Every frontend call hits a backend route; unused routes have a reason | gate | `npm run check:api` |
| No hardcoded UI text; locales complete; no unused or duplicate keys; no mixed scripts | gate | `npm run check:i18n` |
| No hardcoded colours or sizes; motion only through the motion module | gate | `npm run check:ui` |
| Feature boundaries, `fetch` only in `lib/api`, file/function/complexity limits | gate | `npm run lint` (ratchet in `tools/lint-ratchet.json`) |
| No dead code, unused exports or dependencies | gate | `npm run knip` |
| Astryx used as documented | gate | `npm run check:astryx` |
| Types | gate | `npm run typecheck` |
| Bundle size against the limit | gate | `npm run check:size` |
| Performance not worse than baseline | measurement | `tools/perf/run.mjs`, compared at P2 and release |
| Intentional designs kept (below) | test per item, plus review | `npm test`; zakk-review |
| Unified components, no reinvention, no half-done modularization | review | zakk-maintain seven checks; `CONVENTIONS.md` |
| No over-engineering, no over-fixing | review | zakk-maintain seven checks |
| Notification levels used for their meaning | review | `DESIGN.md` Notifications |
| Keyboard path and visible focus | review now; end-to-end check from P3 | — |
| Code style | gate for formatting; review for the rest | `npm run lint`; `CONVENTIONS.md` |

## Exceptions

Backend routes with no dashboard caller are listed with their reason in `tools/api-allowlist.json`
(11 routes at the time of writing); `check:api` fails on any route that is neither called nor listed.

Intentional designs that look like defects:

| What | Why | Owner ruling (date, quote) |
| --- | --- | --- |
| Upstream error detail (provider status, message, OAuth failure reason) is shown in the dashboard | Allowed by the Security rule (zakk-workflow 0466276): operators of the upstream connection see that detail; the dashboard's user is the proxy's operator | 2026-11-08, 「列為例外，面板要顯示上游錯誤」 |
| The management key lives in memory only; reloading signs out | No storage can leak the key | `PRODUCT.md` |
| Live usage is opt-in and kept in the tab | Reading the usage queue removes its records for other consumers | `README.md` (legacy), carried over |
| Write actions are probed before they are offered; unsupported ones render disabled | The server answers a missing route and a real one alike to OPTIONS | carried over from the legacy dashboard |
| A config write rereads and compares first, and refuses when the server copy changed | Two operators, or the file edited by hand, must not overwrite each other | carried over |
| Quota checks run only on request, one at a time, at most once per account every 2 minutes | Each check is a real provider request | carried over |
| Batch actions on accounts that share one file act on the whole file, and the dialog says so | The server deletes and toggles by file | carried over |
| Polling pauses while the tab is hidden | No load for a dashboard nobody looks at | carried over |

## Not yet enforced

| Rule | Current state | Plan |
| --- | --- | --- |
| CI runs the merge gate | No dashboard job in `.github/workflows/` | Add one job running `npm run check` in P4 |
| Contrast is measured automatically | Measured by hand per phase | Decide after P1 whether a check earns its cost |
| API errors map to notification levels | Defined in `DESIGN.md`, not tested | Unit test with the first write action (P2), where errors first reach `notify()` |
