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
  follows the system. Palette is a menu. Both sit in the side nav's footer icon row (with
  language) and at the sign-in page's top end. The choice is stored and applied before the first
  render.
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
the templates and the components as they come; 「這個側邊欄絕對不是組件庫和我的項目有的純ai風格難看死了」).

### Shell (`shell-side-nav`, as BoothDex's admin shell)

The precedent is the owner's BoothDex console, `web/src/components/admin/admin-shell.tsx`, itself
built from the same template.

- Astryx `AppShell` with the side nav only; there is no top bar. `SideNav` is `collapsible` and
  `resizable` (260 px default, 220 to 360).
- Header: `SideNavHeading` with the brand mark and "cliproxy-rs", linking to the first page.
- Body: one `SideNavSection` per route `group` in `src/app/routes.ts` (Overview, Traffic, Observe,
  Server), titled; a section with no page is not shown. Each page is a `SideNavItem` with its
  icon (a lucide component from `routes.ts`); the current page is Astryx's own selected item.
- Footer (`SideNavSection isHeaderHidden`): the connection row (host with its `StatusDot`; a
  popover gives the lamp, version and commit), "Go to page" (`CommandPalette`, also Ctrl/Cmd+K,
  lists every page grouped by section; SideNav has no search slot), GitHub (new tab) and Sign
  out.
- Footer icon row (`SideNav footerIcons`, beside the collapse button): language, colour mode and
  palette, each a ghost icon button with a tooltip; language and palette open a radio menu, the
  colour mode flips on click. BoothDex keeps these in
  an `HStack` inside the footer section; here that row was wider than the collapsed rail and
  pushed every footer item out of it, and `footerIcons` is the slot SideNav stacks in the rail.
- Phones (below Astryx `md`): AppShell's own phone bar and drawer, nothing hand-built; the bar
  carries the heading and the footer icon row.
- After sign-in and after every page change, focus moves to the page's h1 without a ring.

### Sign-in (`login-card`)

- One flat card, centred (the template's: no `elevation`); theme and language as one pair of icon menus at the page's top end,
  on the page gutter. Under the card, one link to the repository.
- Inside the card, top to bottom: brand mark and name; h1 "Connect to this server"; a status line
  (lamp, host, and whether `GET /healthz` answers, rechecked every 10 s while the tab is shown);
  the key field with a show/hide button (`InputGroup`); the primary Connect button; the help as a
  closed `Collapsible`.
- Connect is never greyed out. With an empty field it focuses the field and shows the field's
  error; while signing in it shows Astryx's busy state and one press sends one request. Enter in
  the field submits through `onEnter`, which ignores Enter that commits an IME conversion.
- Sign-in errors are the field's error status, so the field describes them (`aria-describedby`).

### Pages (`detail-page`, as BoothDex's page frame)

- One page frame, `PageFrame` (`src/app/PageFrame.tsx`, after BoothDex's
  `admin/page-frame.tsx`): a header with a divider, the h1 with its meta line beside it (under it
  on phones) and the page's primary action at the header's end (below both on phones); the
  outcome of that action as a banner directly under the header; then a single-column body on the
  header's padding. No card around a collection.
- System: four summary tiles (Version, Commit with a copy button, Built as a relative time whose
  hover card gives the absolute time, Config layout), each label led by its icon; a
  Configuration section as a `MetadataList` with an icon on every row (routing strategy, auth
  directory, remote management as a status lamp with its word, dashboard source); one muted note at the end. A value the server does not send reads "Not reported".
  `detail-page` over `settings`: System shows one record and one action, and has nothing to
  edit, which is the `settings` template's whole body.
- Release check outcomes: up to date (`success`), update available with a link to the releases
  (`info`), cannot compare (`info`), no release published yet (`info`; the server's 502
  `invalid_response`), checks disabled (`info`), anything else an error banner with Retry.
- Collections are rows, not cards. A long list (Accounts, Logs) is virtualized and keeps its
  toolbar (search, filters, batch bar) above it.
- Detail opens in a side panel on desktop and a bottom sheet on phones; the list does not reflow.
- Content width: full width for list + panel screens; 960 px reading width for forms, settings and
  System.

## Components

| Need | Use |
|---|---|
| Account, key, model, plugin, log rows | One `Row` pattern on Astryx `List`/`Table`: status lamp + label, name + secondary line, metrics, row menu |
| Detail | Astryx `LayoutPanel` + `MetadataList`; `BottomSheet` on phones |
| Edits | Astryx `Dialog purpose="form"`; config edits show a diff and reread before write |
| Quota windows | Astryx `ProgressBar` with label and reset time |
| Traffic (20 × 10 min) | One local `TrafficStrip`, drawn like the `dashboard-alert-rail` template's `UptimeStrip`: one cell per bucket, neutral volume, gold or love by failure share, accessible summary |
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

## Not doing

- No chart library, no gradients, glass or glow. KPI tile rows appear only on Overview, Usage
  and System (System's four tiles are facts about the build, not metrics).
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
  icon set. The brand mark is lucide `Route`, in the side nav, on the sign-in card and in
  `public/favicon.svg` (gate: `check:ui`, any `<svg>`, `<path>` or `registerIcons` fails).
- No per-page colours, spacings or font sizes.
