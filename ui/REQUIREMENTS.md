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
| Frontend entry chunk, gzip | ceilings, set once 2026-11-09: initial JS 360,000 B, initial CSS 55,000 B, largest lazy chunk 120,000 B (`tools/size-budget.json`) | 333,632 B, 47,776 B, 105,870 B (2026-11-09, committed build); old Svelte UI: JS 53,436 B, CSS 5,351 B (2026-11-07, desktop, load not recorded) | `tools/size.mjs` |
| Frontend total JS + CSS, gzip | reported in the size report comment, no ceiling | JS 946,229 B, CSS 55,811 B (2026-11-09, committed build) | `tools/size.mjs` |
| Accounts, 1,000 accounts: load to all rows painted | ≤ baseline | 426 ms | `tools/perf/run.mjs` |
| One 10 s poll on Accounts, main thread | ≤ baseline | 101 ms | `tools/perf/run.mjs` |
| JS heap after 5 min of polling | ≤ baseline | 53.2 MB (from 52.0 MB) | `tools/perf/run.mjs` |
| Idle CPU on Accounts | ≤ baseline | 1.2% of one core | `tools/perf/run.mjs` |
| Select all, main thread | ≤ baseline | 313 ms | `tools/perf/run.mjs` |
| Contrast, both themes | body ≥ 10:1, secondary and status text ≥ 5:1 (above WCAG AA, from `DESIGN.md`) | Rosé Pine Moon dark: body 11.86, lowest 3.94; Rosé Pine (Main) dark: body 13.39, lowest 3.16; Dawn light, both palettes: body 8.69, lowest 2.86 (2026-11-08, browser, 1440 px, en; remeasured with the highlight roles, unchanged). Pairs below the limits: Exceptions | browser measurement, reported per phase |

Bundle ceilings (owner, 2026-11-09: 「預算判夠不要每次都改 和doona honk的ci一樣評論可以看到變化的」): the limits above are ceilings with headroom, not the last measurement, so a pull request that grows the bundle does not edit `tools/size-budget.json`. CI posts each pull request's sizes next to master's and the ceilings as a comment (`.github/ci/report`). Raise a ceiling only when a change needs it, with the owner's approval.

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
| The management key is kept in the tab's session storage, so a reload stays signed in (a browser may restore it with the tab); in local storage only when "Remember on this device" is ticked; in the browser's password manager only when the operator saves it there. Sign-out, here or in another tab, clears both stores and cancels any sign-in in progress in any tab; a rejected key is removed only from the stores that hold that same key, so a newer key saved by another tab survives | Retyping the key on every reload was too much. Both stores are readable by any script on the page, so the protection against injected scripts is the same as before reload support existed, not stronger; the difference is how long the key lives, and that local storage sits on disk in the browser profile | 2026-11-08, 「話說登錄每次f5 都要重新輸入是不是太過分了可以怎麼改？」 (session storage, local storage behind an unticked box) and 「可以也加瀏覽器上的是吧」 (password manager); `PRODUCT.md` |
| The sign-in form holds one raw `<input hidden>` carrying the host as the username | A password manager files a single-field sign-in under a username; Chromium's guidance for such forms is a hidden username field, and Astryx's `VisuallyHidden` is a span that must not wrap a control | 2026-11-08, 「可以也加瀏覽器上的是吧」 |
| Live usage is opt-in and kept in the tab | Reading the usage queue removes its records for other consumers | `README.md` (legacy), carried over |
| Write actions are probed before they are offered; unsupported ones render disabled | The server answers a missing route and a real one alike to OPTIONS | carried over from the legacy dashboard |
| A config write rereads and compares first, and refuses when the server copy changed | Two operators, or the file edited by hand, must not overwrite each other | carried over |
| Quota checks run only on request, one at a time, at most once per account every 2 minutes | Each check is a real provider request | carried over |
| Batch actions on accounts that share one file act on the whole file, and the dialog says so | The server deletes and toggles by file | carried over |
| Polling pauses while the tab is hidden | No load for a dashboard nobody looks at | carried over |
| Provider brand marks are drawn from vendored path data in `src/components/ProviderIcon.tsx`, the one file `check:ui` lets hold `<svg>` | lucide has no brand marks; the monochrome files of `@lobehub/icons-static-svg` 1.102.0 (MIT) are copied into `providerMarks.ts`, not installed, and take the text colour, so both themes follow without colour values | 2026-11-09, 「前端可以加這些知道的ai的圖示嗎」 (monochrome, theme colour) |

Contrast below the limits (official Rosé Pine colours). The owner ruled that the official palette
values are used unmodified and the limits above stay (2026-11-08, 「原色優先」). "Browser" rows were
measured on the rendered sign-in and System pages, menu open, info and error banners, at 1440 px
in English (log: `/scratch/ssd/cliproxy-p1/rosepine/contrast-summary.log`); "palette" rows are
pairs the theme maps but no P1 page draws yet, computed from the palette values. Remeasured
after the highlight roles came in (2026-11-08). Dawn rows apply
to both palettes.

| Mode | Foreground on background | Ratio | Limit | Measured | Where | Owner ruling |
| --- | --- | --- | --- | --- | --- | --- |
| Moon dark | text on overlay | 8.82 | 10:1 | browser | Menu items | 「原色優先」 2026-11-08 |
| Moon dark | text on highlight med | 7.41 | 10:1 | browser | Selected nav row, neutral badge, Kbd, "Go to page" button | 「原色優先」 2026-11-08 |
| Moon dark | text on overlay under the hover layer | 7.65 | 10:1 | browser | Hovered or open menu row | 「原色優先」 2026-11-08 |
| Moon dark | pine on surface | 3.94 | 5:1 | browser | Sign-in status line | 「原色優先」 2026-11-08 |
| Moon dark | love on overlay | 4.00 | 5:1 | browser | Error banner, field error, destructive button label, error level on Logs | 「原色優先」 2026-11-08 |
| Moon dark | subtle on surface | 4.46 | 5:1 | browser | Secondary text on cards, side nav, content area | 「原色優先」 2026-11-08 |
| Moon dark | subtle on base | 4.86 | 5:1 | browser | Secondary text on the page and side nav | 「原色優先」 2026-11-08 |
| Main dark | pine on surface | 3.16 | 5:1 | browser | Sign-in status line | 「原色優先」 2026-11-08 |
| Main dark | text on highlight med | 7.93 | 10:1 | browser | Selected nav row, neutral badge, Kbd, "Go to page" button | 「原色優先」 2026-11-08 |
| Dawn light | text on base | 8.69 | 10:1 | browser | Body text on the page and side nav | 「原色優先」 2026-11-08 |
| Dawn light | text on surface | 9.14 | 10:1 | browser | Body text on cards and the content area | 「原色優先」 2026-11-08 |
| Dawn light | text on overlay | 7.92 | 10:1 | browser | Menu items | 「原色優先」 2026-11-08 |
| Dawn light | text on highlight med | 6.86 | 10:1 | browser | Selected nav row, neutral badge, Kbd, "Go to page" button | 「原色優先」 2026-11-08 |
| Dawn light | text on overlay under the hover layer | 7.31 | 10:1 | browser | Hovered or open menu row | 「原色優先」 2026-11-08 |
| Dawn light | base on text | 8.69 | 10:1 | browser | Primary button label | 「原色優先」 2026-11-08 |
| Dawn light | foam on overlay | 2.86 | 5:1 | browser | Info banner | 「原色優先」 2026-11-08 |
| Dawn light | love on overlay | 3.50 | 5:1 | browser | Error banner, field error, destructive button label, error level on Logs | 「原色優先」 2026-11-08 |
| Dawn light | gold on overlay | 1.87 | 5:1 | browser | Warning level on Logs | 「原色優先」 2026-11-08 |
| Dawn light | iris on surface | 3.65 | 5:1 | browser | Skip link | 「原色優先」 2026-11-08 |
| Dawn light | subtle on base | 4.02 | 5:1 | browser | Secondary text on the page and side nav | 「原色優先」 2026-11-08 |
| Dawn light | subtle on surface | 4.23 | 5:1 | browser | Secondary text on cards and the content area | 「原色優先」 2026-11-08 |
| Moon dark | subtle on overlay | 3.61 | 5:1 | palette | Secondary text in menus and popovers | 「原色優先」 2026-11-08 |
| Main dark | subtle on overlay | 4.71 | 5:1 | palette | Secondary text in menus and popovers | 「原色優先」 2026-11-08 |
| Dawn light | subtle on overlay | 3.67 | 5:1 | palette | Secondary text in menus and popovers | 「原色優先」 2026-11-08 |
| Moon dark | muted on base / surface / overlay | 3.03 / 2.79 / 2.25 | 5:1 | palette | Tertiary and placeholder text (disabled text is exempt) | 「原色優先」 2026-11-08 |
| Main dark | muted on base / surface / overlay | 3.42 / 3.20 / 2.94 | 5:1 | palette | Tertiary and placeholder text (disabled text is exempt) | 「原色優先」 2026-11-08 |
| Dawn light | muted on base / surface / overlay | 2.73 / 2.87 / 2.48 | 5:1 | palette | Tertiary and placeholder text (disabled text is exempt) | 「原色優先」 2026-11-08 |
| Moon dark | pine on base / overlay | 4.29 / 3.19 | 5:1 | palette | Ready text | 「原色優先」 2026-11-08 |
| Main dark | pine on base / overlay | 3.38 / 2.91 | 5:1 | palette | Ready text | 「原色優先」 2026-11-08 |
| Moon dark | love on surface | 4.94 | 5:1 | palette | Failing text | 「原色優先」 2026-11-08 |
| Dawn light | love on base / surface | 3.84 / 4.04 | 5:1 | palette | Failing text | 「原色優先」 2026-11-08 |
| Dawn light | gold on base / surface / overlay | 2.05 / 2.16 / 1.87 | 5:1 | palette | Cooling text, warning banner | 「原色優先」 2026-11-08 |
| Dawn light | foam on base / surface | 3.14 / 3.30 | 5:1 | palette | Info text | 「原色優先」 2026-11-08 |
| Dawn light | iris on base / overlay | 3.47 / 3.16 | 5:1 | palette | Links | 「原色優先」 2026-11-08 |

Neutral, the default palette (2026-11-09), computed from the built `site-neutral.css` values:
body 18.59 light (on #f1f1f1) and 15.13 dark (on #262626), secondary 8.23 and 5.65, warning text
10.27 and 8.65, the warning badge 7.70 and 6.46, bar fills 3.15 (#919191 on white) and 3.85
(#777777 on #1b1b1b), chart volume 4.70 (#0171E3 on white) and 3.67 (on #1b1b1b), all against the
3:1 non-text limit. Two of neutral's own status
colours miss the 5:1 limit on the light page and stay unmodified (they pass WCAG AA):

| Mode | Foreground on background | Ratio | Limit | Measured | Where | Owner ruling |
| --- | --- | --- | --- | --- | --- | --- |
| Neutral light | success text #2f7d33 on page #f1f1f1 | 4.53 | 5:1 | palette | Ready text on the page (5.12 on white surfaces) | none yet |
| Neutral light | info text #0067ce on page #f1f1f1 | 4.85 | 5:1 | palette | Info text on the page | none yet |

## Not yet enforced

| Rule | Current state | Plan |
| --- | --- | --- |
| CI runs the merge gate | No dashboard job in `.github/workflows/` | Add one job running `npm run check` in P4 |
| Contrast is measured automatically | Measured by hand per phase | Decide after P1 whether a check earns its cost |
| API errors map to notification levels | Defined in `DESIGN.md`, not tested | Unit test with the first write action (P2), where errors first reach `notify()` |
