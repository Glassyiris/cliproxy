---
name: cliproxy-rs Switchboard
description: A quiet operator console. Grey carries hierarchy; hue carries state.
---

# Design language: Switchboard

The dashboard is where one person keeps many provider accounts healthy behind one local endpoint.
They come to answer three questions, in this order: can the proxy serve right now, which account
needs me, and what did my tools just send. Every screen is built for scanning a long list and
acting on one row, not for reading.

This replaces the Braun "Instrument" language (2026-11-08, owner: the dashboard gets its own new
style). Product rules in `PRODUCT.md` still apply; its visual and size clauses are superseded here.

## Principles

1. **Grey carries hierarchy, hue carries state.** Surfaces, text and controls are neutral. A
   coloured pixel always means a state: ready, cooling, failing, info. No brand hue in the chrome;
   the logo is the only chromatic thing that is not state.
2. **One way to draw each thing.** One row, one list, one detail panel, one dialog, one form field,
   one notice. Astryx components first; a local component exists only when two screens need it.
3. **Dense, not cramped.** Row height and type follow Astryx's console scale. Numbers use tabular
   figures; identifiers (model IDs, keys, paths, file names) use the mono family.
4. **State is never colour alone.** Every lamp has a word or an accessible label; active navigation
   changes weight and background, not only hue.
5. **Motion reports, it does not decorate.** One motion module, Astryx durations, all off under
   `prefers-reduced-motion`.

## Colour

- Theme: one `defineTheme` in `src/themes/site/`, both modes first-class from the first commit,
  following the system by default with a manual switch.
- Neutrals: Astryx neutral ramp, a cool grey (very low chroma). Body and surface share one
  background; cards and popovers step up one level.
- Primary action: ink, not a hue — near-black on light, near-white on dark (the same treatment as
  doona lite). Focus ring uses the same ink.
- Status vocabulary, closed set, each with a text colour and a muted background, declared for both
  modes: `ready` green, `cooling` amber, `failing` red, `info` blue, `disabled` neutral. Contrast:
  body text ≥ 10:1, secondary and status text ≥ 5:1 in both modes, measured on the composited colour.
- Text tokens are not fill tokens. Traffic strips use the neutral ramp for volume; red only for
  failed buckets.

## Type

- Figtree for UI (the owner's other consoles use it), CJK fallbacks to the system SC/TC fonts with
  SC first for zh-CN and TC first for zh-TW.
- Mono: JetBrains Mono for data only.
- Scale (Astryx tokens): page title 24/600, section 18/600, body 14/400–500, supporting 13.
  Headings stay 600 in every locale.

## Layout

- Shell: Astryx `AppShell` with a collapsible side nav (icon + label), the connection state and
  server version once in the nav footer. Phones get the native drawer.
- Every page uses one page frame: title, one supporting line, actions at the end of the title row,
  then a single-column body. No card around a collection.
- Collections are rows, not cards. A long list (Accounts, Logs) is virtualized and keeps its
  toolbar (search, filters, batch bar) above it.
- Detail opens in a side panel on desktop and a bottom sheet on phones; the list does not reflow.
- Content width: full width for list + panel screens; 960 px reading width for forms and settings.

## Components

| Need | Use |
|---|---|
| Account, key, model, plugin, log rows | One `Row` pattern on Astryx `List`/`Table`: status lamp + label, name + secondary line, metrics, row menu |
| Detail | Astryx `LayoutPanel` + `MetadataList`; `BottomSheet` on phones |
| Edits | Astryx `Dialog purpose="form"`; config edits show a diff and reread before write |
| Quota windows | Astryx `ProgressBar` with label and reset time |
| Traffic (20 × 10 min) | One local `TrafficStrip`: a single SVG path per row, neutral volume, red failures, accessible summary |
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

- No KPI tile row, no chart library, no gradients, glass or glow.
- No brand accent hue in controls (add one later only as a theme token used in four places:
  primary button, current nav item, links, focus ring).
- No second icon set: one icon registry for the whole app.
- No per-page colours, spacings or font sizes.
