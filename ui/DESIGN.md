---
name: cliproxy-rs Rosé Pine
description: A quiet operator console. Grey carries hierarchy; hue carries state.
---

# Design language: Rosé Pine (Moon/Dawn)

The dashboard is where one person keeps many provider accounts healthy behind one local endpoint.
They come to answer three questions, in this order: can the proxy serve right now, which account
needs me, and what did my tools just send. Every screen is built for scanning a long list and
acting on one row, not for reading.

This replaces the Braun "Instrument" language (2026-11-08, owner: the dashboard gets its own new
style). Product rules in `PRODUCT.md` still apply; its visual and size clauses are superseded here.

## Principles

1. **Grey carries hierarchy, hue carries state.** Surfaces, text and controls are the palette's
   neutral roles. A coloured pixel means a state (ready, cooling, failing, info) or, in iris
   only, a link or the focus ring.
2. **One way to draw each thing.** One row, one list, one detail panel, one dialog, one form field,
   one notice. Astryx components first; a local component exists only when two screens need it.
3. **Dense, not cramped.** Row height and type follow Astryx's console scale. Numbers use tabular
   figures; identifiers (model IDs, keys, paths, file names) use the mono family.
4. **State is never colour alone.** Every lamp has a word or an accessible label; active navigation
   changes weight and background, not only hue.
5. **Motion reports, it does not decorate.** One motion module, Astryx durations, all off under
   `prefers-reduced-motion`.

## Colour

The palette is [Rosé Pine](https://rosepinetheme.com): **Moon** in dark mode and **Dawn** in light
mode by default, with **Rosé Pine** (Main) for dark as the second choice. The values come
unmodified from [rose-pine/palette](https://github.com/rose-pine/palette) (MIT): the named roles
from `palette.json`, the highlight roles from `dist/css/rose-pine.css`; they live in
`src/themes/site/rosePine.ts`. Owner, 2026-11-08: 「https://github.com/rose-pine 配色用這個把」;
「原色優先」 — every colour is an official value; pairs that miss a contrast limit are listed in
`REQUIREMENTS.md` Exceptions instead of being adjusted.

- Theme: both site themes extend Astryx's official neutral theme
  (`defineTheme({extends: neutralTheme})`, as Astryx's setup guide does) and set only colour and
  type-size tokens: fonts, component styles, icons (lucide), radius and motion come from
  neutral. `src/themes/site/siteTheme.ts` builds `site` (Moon, in the entry) and
  `siteMainTheme.ts` builds `site-main` (loaded on demand when chosen), both with
  `astryx theme build`; the colour and type tokens are shared (`roseTokens`). Both modes are
  first-class, following the system by default with a manual switch.
- Palette and mode are separate choices. Mode is one click: a ghost icon button flips light and
  dark relative to what is shown (BoothDex's ColorModeToggle), and until the first press the page
  follows the system. Palette, mode (with "follow the system") and language are set in the
  settings dialog (see Preferences). The choice is stored and applied before the first render.
- Roles, the same for both palettes, following Rosé Pine's own usage table:

  | Dashboard role | Rosé Pine role |
  | --- | --- |
  | Page background | base |
  | Card, side nav surface | surface |
  | Popover, menu, palette, toast; status and accent muted fills | overlay |
  | Hover and selected nav item, neutral badge | highlight med (low measures 1.01–1.12:1 on base and surface) |
  | Hover tint mixed into radios, checkboxes and switches | highlight low |
  | Borders, dividers, skeleton, track | highlight med |
  | Emphasized border (inputs) | highlight high |
  | Body text | text |
  | Secondary text | subtle |
  | Tertiary, placeholder, disabled text | muted |
  | Primary button fill / its label | text / base (ink) |
  | Links, focus ring | iris |
  | Ready / success | pine |
  | Info | foam |
  | Warning (cooling), yellow Token (warning log level) | gold |
  | Error (failing), red Token (error log level) | love |
  | rose | unused |

- Status vocabulary, closed set: `ready`, `cooling`, `failing`, `info`, `disabled` (muted). A lamp
  is Astryx's `StatusDot` (`success`, `warning`, `error`, `neutral`; `info` is for banners and
  badges only) with its word in secondary text beside it, as the owner's BoothDex console draws
  it (`admin/live-status.tsx`). Icons, lamps and status borders take the hue; banner and badge
  fills are overlay with the hue as their text, so no fill is mixed from a hue. Contrast limits stay: body text ≥ 10:1,
  secondary and status text ≥ 5:1, measured on the composited colour; the official colours miss
  some of them, see `REQUIREMENTS.md`.
- The dialog scrim, the shadow and the hover and pressed overlays drawn over a fill keep Astryx's
  translucent defaults: they are not palette colours, and Rosé Pine defines none.
- Text tokens are not fill tokens. Traffic strips use the neutral roles for volume; gold for a
  bucket where 5 % to 50 % of the requests failed, love from 50 % (fewer failures stay neutral).

## Type

- Fonts are the neutral theme's own, unchanged (owner, 2026-11-08: fonts and icons use the
  component library's defaults): Figtree, then the system sans stack, for body and headings;
  the system monospace stack for code. Neutral's `fonts.css` loads Figtree from Google Fonts at
  run time; the app imports the same four weights from `@fontsource/figtree` instead (in
  `src/themes/site/index.ts`), so it makes no third-party request, as BoothDex does. There is no
  `typography` block and no per-locale font rule, so CJK text falls to the system fonts the
  browser picks for the page language.
- Scale: neutral's (base 14, ratio 1.2) is the app's, so no `typography.scale`. Three size tokens
  stay in `roseTokens` because neutral's steps differ: page title 24/600 (`--text-heading-1-size`),
  section 18/600 (`--text-heading-2-size`), supporting 13 (`--text-supporting-size`); body is 14.
  Headings are 600 in every locale (neutral's weight).

## Layout

Every screen starts from an Astryx template and keeps its frame (owner, 2026-11-08: build from
the templates and the components as they come; 「這個側邊欄絕對不是組件庫和我的項目有的純ai風格難看死了」;
「內容都要組件庫的」). Each page file names its template in its header comment and lists every
deviation with its reason.

### Routes

Eleven hash routes. Sign-in is not a route; connecting an account is a dialog.

| Route (`#id`) | Answers first | Template | Required |
| --- | --- | --- | --- |
| Overview (`overview`) | Can the proxy serve now, and what needs me? | `dashboard-alert-rail` | The share of accounts that can serve; the most urgent problems in the template's own alert rail; the total and failure chart. On phones the alerts are in the first screen (below 1024 px the rail folds into the content) |
| Accounts (`accounts`) | Which accounts cannot serve, and when do they recover? | `table-inbox` | Opens on the needs-attention view, with a switch to All; each row: name, status, why it is stuck, the quota windows (Session and Weekly progress bars), recovery time; batch selection; 1,000 rows virtualized with `@tanstack/react-virtual` |
| Provider keys (`providers`) | Which upstream serves, and which key has a problem? | `table-grouped` | Keys grouped by provider family (no tabs); families with no key sit under Add |
| Client keys (`keys`) | Which key do I use, and how do I revoke one? | `table-page` (minimal) | `table` is WIP (`isReady: false`), so the minimal list |
| Use with tools (`use`) | How do I set up this tool? | `form-wizard-inline` | Three steps: choose the tool, copy its settings, test the connection |
| Traffic analysis (`usage`) | Where does traffic come from, and when does it fail? | `dashboard-comparison` | Source comparison and failure rate, each number beside the one it compares with; the live queue starts only when switched on in the header and confirmed, a recorded deviation |
| Logs (`logs`) | What happened to the request that just failed? | `table-filter` | Search (request ID included) and filters in the `LayoutHeader`; Clear in a menu; the raw content in the detail |
| Models (`models`) | Which models can clients ask for, and where do they go? | `table-filter` | Two tabs: Catalog, and Rules (aliases and exclusion patterns) |
| Payload rules (`payload`) | Which requests are rewritten, and how? | `table-grouped` | Empty groups collapsed; each row: model, action, field count; the JSON in the detail |
| Plugins (`plugins`) | Is the plugin loaded, and does the server need a restart? | `table-page` | A facts area above the list: loaded, needs restart; a switch between Installed and Store |
| Configuration (`config`) | Which setting do I change, and what does it affect? | `settings-sidebar` | Sections by task; a diff before save; raw YAML as an advanced section; no search (the template has none); the About panel with its eight items (below) replaces the System page |
| Sign-in (not a route) | Which server do I connect to, and what do I enter? | `login-card` | The template's card frame; the fields and the preference controls at the top end follow the current `SignIn.tsx` (below) |
| Connect an account (dialog) | Which kind of account, and how far is the authorization? | `form-wizard-dialog` | After the type is chosen only that flow shows; the Vertex fields appear only when Vertex is chosen |

- Sign-in follows `login-card`; "Connect an account" is a `form-wizard-dialog` opened from
  Overview and Accounts (and the command palette). There is no Connect page and no System page.
- Old hashes still land: `#connect` and `#oauth` open the connect dialog over the current page (or
  Overview), `#system` opens Configuration's About panel, `#configuration` is Configuration,
  `#credentials` and `#quotas` are Accounts.
- Filters, tabs, paging and the open item live in the hash query, so Back restores them.

### Shell (`shell-side-nav`, as BoothDex's admin shell)

The precedent is the owner's BoothDex console, `web/src/components/admin/admin-shell.tsx`, itself
built from the same template.

- Astryx `AppShell` with the side nav only; there is no top bar. `SideNav` is `collapsible` and
  `resizable` (260 px default, 220 to 360).
- Header: `SideNavHeading` with the brand mark and "cliproxy-rs", linking to the first page.
- Body: one `SideNavSection` per route `group` in `src/app/routes.ts`, titled; a section with no
  page is not shown. Each page is a `SideNavItem` with its icon (a lucide component from
  `routes.ts`); the current page is Astryx's own selected item.
- Footer (`SideNavSection isHeaderHidden`): the connection row (host with its `StatusDot`; a
  popover gives the lamp, version and commit), "Go to page" (`CommandPalette`, also Ctrl/Cmd+K,
  lists every page grouped by section; SideNav has no search slot), GitHub (new tab) and Sign
  out.
- Footer icon row (`SideNav footerIcons`, beside the collapse button, the slot SideNav keeps in
  the collapsed rail): the colour-mode toggle and the settings button, each a ghost icon button
  with a tooltip.
- Phones (below Astryx `md`): AppShell's own phone bar and drawer, nothing hand-built; the bar
  carries the heading and the footer icon row.
- After sign-in and after every page change, focus moves to the page's h1 without a ring.

### Preferences

- The settings button opens the `settings-dialog` template. Appearance: palette (with a preview),
  mode (light, dark, follow the system) and language. Keyboard shortcuts: the template's own panel
  (`settings-dialog/page.tsx:413`). Options that affect only this browser sit in the dialog too.
- Server settings, which affect everyone, stay on the Configuration page and never enter the
  dialog.
- Sign-in keeps its own mode, palette and language controls at the page's top end, on the page
  gutter, because the side nav is not there yet.

### Sign-in (`login-card`)

- One flat card, centred (the template's: no `elevation`); the preference controls above. Under
  the card, one link to the repository. The template's third-party sign-in, forgotten password,
  sign-up and terms do not exist for cliproxy and are left out.
- Inside the card, top to bottom: brand mark and name; h1 "Connect to this server"; a status line
  (lamp, host, and whether `GET /healthz` answers, rechecked every 10 s while the tab is shown);
  the key field with a show/hide button (`InputGroup`); the primary Connect button; the help as a
  closed `Collapsible`.
- Connect is never greyed out. With an empty field it focuses the field and shows the field's
  error; while signing in it shows Astryx's busy state and one press sends one request. Enter in
  the field submits through `onEnter`, which ignores Enter that commits an IME conversion.
- Sign-in errors are the field's error status, so the field describes them (`aria-describedby`).

### Pages

- Every page is the templates' shared frame: `Layout height="fill"` with `LayoutHeader`,
  `LayoutContent` and, for a detail or a rail, `LayoutPanel` at the end. There is no app-level
  page frame component; the values come from the roles table below.
- The header holds the h1, one supporting line, the page's controls and at most one primary
  action. A list's search and filters sit in the `LayoutHeader` (as `table-filter` does), so they
  stay while the content scrolls; on phones they fold as the template's narrow layout folds them
  (`table-filter:2034-2088`). A rarely used action (Clear) goes into a menu.
- The outcome of a page action is a toast, or a banner directly under the header for a read.
- Collections are rows, not cards. Accounts and Logs are virtualized with
  `@tanstack/react-virtual` (as `LogRows.tsx` does; the templates do not virtualize).
- Low-frequency detail (raw JSON, empty groups, import forms) starts collapsed or lives in the
  detail panel.
- Configuration's About panel lists the build and the server in one `MetadataList`: version,
  commit, build time, config layout, routing strategy, auth directory, remote management (a lamp
  with its word) and dashboard source; a value the server does not send reads "Not reported". It
  ends with the release check, whose outcomes are: up to date (`success`), update available with a
  link to the releases (`info`), cannot compare (`info`), no release published yet (`info`; the
  server's 502 `invalid_response`), checks disabled (`info`), anything else an error banner with
  Retry.

### Roles

A role that repeats across pages has one value, measured from the templates above. Spacing and
sizes inside one template's own composition (its gaps, a toolbar's `size="sm"`) stay as that
template writes them. Values are in `src/themes/site/roles.ts`; `check:ui` enforces the type rows
and `npm run measure` the rendered values.
A template's typography value (`Text size="sm"`, for example) enters a page only after it is
added to `roles.ts` with a named use and its `template:line`, so text stays one scale across pages.

| Role | Value | Source | Where templates disagree |
| --- | --- | --- | --- |
| Page frame | `Layout` / `LayoutHeader` / `LayoutContent` / `LayoutPanel` | `dashboard-alert-rail:1446-1567`, `table-filter:4333-4480` | — |
| Header | Every route has a `LayoutHeader` with a divider holding the h1 and one `Text type="supporting"` line | `dashboard-alert-rail:1450-1462`, `dashboard-comparison:786-790`, `table-inbox:2411-2417` | `table-page` puts its title in the content (`:856-869`) and `settings-sidebar` has no header (`:301`): those pages add `LayoutHeader` and h1, a recorded deviation |
| Header padding | 4 | `table-grouped:901`, `table-filter:4339` and `dashboard-comparison:786` (default inset), `table-inbox:2413` | `dashboard-alert-rail:1450` uses 6; 4 is the majority and equals the content inset, so the h1 and the content start on one line |
| Content inset | `LayoutContent padding={4}`; a table bleeds to the edges and re-insets its first and last cells | `table-filter:4480`, `table-inbox:2599`, `settings-sidebar:313` | `dashboard-alert-rail:1503` and `dashboard-comparison:826` use 6, `table-grouped:952` and `table-page:856` use 0; 4 keeps the header's line |
| Content width | Lists and dashboards (with a detail panel or rail): none, full width. Settings: `contentWidth` 1200, which includes their own nav. Single-column forms (wizards): 800 | `settings-sidebar:303`, `form-wizard-inline:610` | `dashboard-comparison:784` 1440 and `table-page:848` 960 are not used: lists take the full width |
| Table density | `balanced` | `table-inbox:2628`, `table-grouped:953`, `table-page:933`, `dashboard-comparison:879` | `table-filter`'s density switch (`:3896`) is removed, a recorded deviation |
| Heading levels | 1 page title, 2 section, 3 card title, 4 heading inside a card; nothing deeper; one level 1 per route | every template's title; `dashboard-alert-rail:868`, `:782`, `:1317` | `dashboard-comparison:437` draws metric values as `level={1}`; metric values are text (below) |
| Text types | `body` content and table cells; `supporting` the line under a title and hints; `label` a field or metric label; `large` a metric value; `code` identifiers (model IDs, keys, paths, versions); `inherit` text inside another text. A `Heading` takes no `type`: its level sets the scale | `table-grouped:777`, `dashboard-alert-rail:1461`, `dashboard-alert-rail:863`, `table-filter:3350`, `dashboard-comparison:389`; `code` from the Text docs (no assigned template shows identifiers) | The `display-*` types (`contact-form:116`, `product-detail:167`) belong to marketing pages and are not used |
| Text size and weight | Size: `lg` for the brand name only. Weight: `semibold` for emphasis, `bold` for the brand and a group name, `normal` as the plain branch of a conditional emphasis. Headings take neither | `login-card:94`, `dashboard-alert-rail:1098`, `table-grouped:1001`, `table-inbox:1059` | `form-wizard-inline:737` uses `medium`; not allowed |
| Primary action | At most one `Button variant="primary"` per page, default size (`md`), at the header's end; the other header controls default size too | `table-inbox:2434`, `dashboard-comparison:795-818` | `table-grouped:907` and `dashboard-alert-rail:1477-1495` use `lg`; the default is the majority and keeps one control height across headers |
| Row actions | `IconButton variant="ghost" size="sm"` | `table-inbox:1008`, `table-filter:2159` | — |
| Numbers | Every numeric column and metric value: `Text hasTabularNumbers`; a metric value is `Text type="large" hasTabularNumbers` | `dashboard-comparison:703`, `table-page:503`, `table-filter:3350` | `dashboard-alert-rail:868` draws KPI values as `Heading level={2}`, which has no tabular figures and puts numbers in the outline |
| Detail panel | `LayoutPanel` behind a `ResizeHandle`, 380 px (320 to 560), padding 0. Below the compact query (`(max-width: 768px), (max-width: 1024px) and (pointer: coarse) and (hover: none)`) a `BottomSheet height="tall" padding={0}` | `table-filter:2229`, `:4300`, `:4313`, `:1129` | `table-grouped:887` is 360 (280 to 500); `table-inbox:2115` is a 58 % reading pane that takes the full surface on phones. The sheet is chosen for phones: it keeps the list, its scroll position and selection under it, so closing returns to the same row |
| Skeleton | Each region renders `Skeleton`s in the shape and size of its content, as `table-filter`'s loading rows do (one bar per column, the cell inset of the density); a refetch keeps the previous data on screen | `table-filter:1882-1945` | Only `table-filter` draws skeletons; every page follows it |

Measured limits (`npm run measure`, plan section 八): CLS during load ≤ 0.02; the first region
moves ≤ 2 px from its skeleton to its content; each route's answer element (the first row of
Overview's alert rail, for example) is inside 1440×900 and 390×844. Every measured route declares
its answer selector and the measurements its page draws (table rows, header buttons, row actions,
skeleton); a missing declaration or a declared measurement with no sample fails, and so do
buttons of one role whose heights differ within a route.

### Keyboard

As the templates do it: each row is one tab stop and Enter or Space opens its detail
(`table-inbox:1109-1125`, `table-filter:2754-2762`). Astryx Table has no arrow-key movement
between rows, and none is added. Ctrl/Cmd+K opens "Go to page"; the shortcuts are listed in the
settings dialog.

## Components

| Need | Use |
|---|---|
| Account, key, model, plugin, log rows | One `Row` pattern on Astryx `List`/`Table`: status lamp + label, name + secondary line, metrics, row menu |
| Detail | Astryx `LayoutPanel` + `MetadataList`; `BottomSheet` on phones (Roles) |
| Edits | Astryx `Dialog purpose="form"`; config edits show a diff and reread before write |
| Quota windows | Astryx `ProgressBar` with label and reset time |
| Traffic per source (20 × 10 min) | The `dashboard-alert-rail` template's own `UptimeStrip`: one cell per bucket, neutral volume, gold or love by failure share, accessible summary |
| Charts | See Charts |
| Writes | Busy button, one write at a time, success toast, failure toast that stays with the server's text; deletes confirm in `AlertDialog` |
| Notices | See below |

## Notifications

| Level | Meaning | Where |
|---|---|---|
| `success` | An action the user started finished | Toast, auto-dismiss |
| `info` | Neutral fact the user should know now | Toast, auto-dismiss |
| `warning` | Something works but needs attention (account cooling, setting ignored by this server) | Banner on the page. A lasting state (an account cooling) is rendered by the page from its data and stays while the state lasts; a warning sent through `notify()` is an event and stays until dismissed or the page changes |
| `error` | An action failed or a read failed | Banner for reads; toast that stays for a failed action |

`notify()` accepts only these four levels. Toasts sit at the bottom end, one at a time.

## Motion

Press feedback, toast enter/exit, panel open/close, lamp pulse on live things (log tail, OAuth
waiting, live usage). No page transitions, no row entrance stagger: a list that refreshes every
10 s must not move.

## Charts

- Charts use recharts, as nine Astryx templates do (`dashboard/page.tsx:20`,
  `dashboard-alert-rail/page.tsx:60-68`); Astryx has no chart component. All charts live in one
  module (`src/components/charts/`), structured after card-v2's chart set (`charts.tsx`,
  `TrendChart.tsx`, `LegendDot.tsx`, `MetricCard.tsx`, `focusRing.ts`).
- Colours are theme tokens passed as CSS variables (`dashboard-alert-rail:697-730`): series take
  `--color-data-categorical-*`, defined in the theme as Rosé Pine colours; failure stays gold and
  love. No hex or px fallbacks in chart code.
- `isAnimationActive` is off on every series: the 10 s poll must not replay an animation.
- Hover or focus shows a point's tooltip and the arrow keys step through points; a mouse click
  draws no browser outline, keyboard focus draws Astryx's focus ring.
- Charts draw only what the API has: total and failed requests over 200 minutes (Overview), source
  comparison and failure rate (Traffic analysis). The templates' 1h / 1d / 7d windows are dropped.
  Each chart has a one-line written conclusion beside it.
- KPI tiles appear where the page's template has them: Overview and Traffic analysis.

## Not doing

- No gradients, glass or glow.
- No top bar: the brand is the side nav's heading and the page title is the page's h1.
- No custom selected-item decoration and no style overrides on Astryx navigation components, or
  on any component: the theme sets tokens only (gate: `check:ui`, a `components` block in a
  theme source fails).
- No disabled-grey primary buttons: a primary action stays pressable and explains itself (focus
  and a field error, or a banner) instead of greying out.
- No long explanatory paragraphs above data: one supporting line under the title; anything more
  is a collapsed section or one muted note after the data.
- No accent hue beyond iris in its two places (links, focus ring); the primary button stays ink.
- Icons are the component library's defaults and no app registry: a semantic name from the theme
  where one fits the meaning (`calendar`, `wrench`, `search`, `copy`, `check`, `eyeSlash` ...; the
  list is `npx astryx docs icons available-names`), otherwise a lucide component passed straight to
  `Icon` or an `icon` prop and typed with Astryx's `IconProps["icon"]`. No `registerIcons`, no second
  icon set, and template icons (heroicons) become lucide. The brand mark is lucide `Server` in the
  text colour with no tile behind it, in the side nav, on the sign-in card and in
  `public/favicon.svg` (gate: `check:ui`, any `<svg>`, `<path>` or `registerIcons` fails).
- No per-page colours, spacings or font sizes: the Roles table holds the one value per role.
