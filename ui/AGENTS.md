# ui/AGENTS.md: frontend rules

The root `AGENTS.md` applies. Root `REQUIREMENTS.md` decides gates, numbers and exceptions.
Use `ui/CONVENTIONS.md` for code boundaries, state, naming and limits; use `ui/DESIGN.md` for visual roles and values.
The Astryx-managed block below stays unchanged; project rules live outside its markers.

## Frontend

### Components and modularity

- Use unified components and finish existing modularization instead of leaving theme or i18n extraction half done.
- Keep literal text in locale files and colors and sizes in tokens. Follow the managed template/component workflow below without duplicating its instructions.
- Follow `ui/CONVENTIONS.md`, "Layout and boundaries" and "Limits", including the fetch boundary and file/function/complexity ratchets.

### Consistency

- Use one visual style and the shared motion duration, easing and triggers. Animate transform and opacity only; respect reduced motion and never make users wait for an exit.
- Use notification levels for their actual meanings in `ui/DESIGN.md`, "Notifications".

### Layout, type and loading

Use the scales, frames and dimensions in `ui/DESIGN.md`; keep values there rather than copying them into rules.

- Give each text role one named size and line height across pages: page, section and card titles, body, small and meta. Pages contain no literal font sizes.
- Use one spacing scale and the same gap for the same relationship: sections, cards, card content, labels and fields. Pages contain no literal pixel values.
- Each page has exactly one title drawn by the shared frame, with consistent position and spacing. Actions sit at the title row's end; pages do not draw separate headers.
- Pages of one kind share a frame width and aligned title/body edges. Put forms in the shared readable column; lists and tables span the frame.
- Fill supported phone, laptop and wide frames naturally or narrow the frame. A half-empty screen or a page-specific side gap is a defect.
- Align content to shared edges, text/actions to column starts and numbers/amounts to ends. Top-align unequal-height cells and baseline-align labels with fields.
- Center sign-in cards, empty states, dialogs and single-column flows on both axes using layout, not guessed padding. Check icon/text centering with CJK text too.
- Keep dates, times, amounts, ids and codes unbroken. Expose truncated values on hover, focus and touch.
- Show each page's own skeleton from first paint at the final frame, title and section sizes. Only loading content gets skeletons; empty and error states are separate. Data arrival does not shift layout, and a spinner does not precede the skeleton.
- Show action loading on the affected button or row, not a full-page spinner. Every click responds visibly; success and failure are explicit.
- Give a view one primary action with an action label, not "OK". Confirm irreversible destructive actions.
- At phone widths, avoid horizontal page scroll, clipping and hover-only information. Tables fit or stack.
- Before review, capture each changed page with real data at phone and desktop widths in every theme. Empty/error screenshots alone do not verify a page. Show an owner one screen of a new flow before building the rest.

### i18n (if present)

- Complete translations with consistent key naming; no hardcoded, duplicate or unused strings.
- Removing a screen or control also removes its message keys in every locale. `npm run check` fails on unused keys.

### Usability

- Keep flows familiar and easy to use. Before designing a user/admin flow, link mainstream precedents (GitHub, Google, Apple or Microsoft; Stripe, Wise or Revolut for money) and justify deviations.
- Support the project's browsers, screen sizes and themes.

### Accessibility

- Every action works by keyboard with visible focus. Route changes focus the page title.
- The default Neutral palette meets the WCAG AA thresholds in `REQUIREMENTS.md`, "Numbers". The optional Rosé Pine palettes (Main, Moon, Dawn) are a recorded exception there.

### Performance

- Track bundle size, render cost and memory against measured baselines; avoid unnecessary dependencies.
- Use the existing ceilings in `ui/tools/size-budget.json`. Approval for increases follows root Performance baseline.

### Dashboard sessions

Sign in by exchanging the management key once for the server-issued session cookie. Keep no key or token in script-readable storage.

### API error notifications

Test API error-to-notification mapping through a write action that reaches `notify()`, covering the levels required by root Frontend–backend mapping.

<!-- ASTRYX:START -->
Astryx v0.7.11 · 174 components
CLI: run every command as `npx astryx <cmd>` (shown below as `astryx ...`).

SETUP (once, in app entry e.g. main.tsx) — without these, components render unstyled:
  import "@astryxdesign/core/reset.css";
  import "@astryxdesign/core/astryx.css";

WORKFLOW — start every page from a template, never from scratch:
1. `astryx build "<idea>"` — names the template to scaffold from and the parts it lacks.
2. `astryx template <name> <path>` — scaffold it; keep its frame, gap and padding; replace the content.
3. `astryx template <Block>` for parts it lacks; `astryx component <Name>` to read props before using one.
Changing an existing page? Keep it: skip step 2 and add blocks/components inside its sections.
Before you deliver a build, run `astryx doctor --built <dir>`; don't deliver it if it fails.

RULES:
- No <div> — components handle all layout and spacing.
- Read `astryx docs layout` before changing a template's frame.
- Dense data = rows (Table, List/Item), not Card-wrapped lists. Badge = counts only.
- Style with component props first, then the xstyle prop / StyleX tokens. No raw hex/px.
- Palettes and custom colors go through the theme, never :root overrides. Run `astryx theme add <slug>` to import; `theme eject <slug>` only forks source. See `astryx docs theme`.
- SELF-CHECK: re-read the file; replace any className=, style={{…}}, raw <div>/<span>, imported .css/@apply, or hardcoded #hex/px with the component or the xstyle prop + a token.

`astryx help` lists every command. Key ones beyond the workflow:
  search "<query>"   find any component / hook / doc / template
  discover <words>   integrations you could add
  docs <topic>       getting-started, principles, tokens, theme … (`astryx docs` lists all)
  docs cli           commands and API reference
  docs authoring     build an integration package, and every field it holds
  upgrade --from <old version> --apply   run after a dependency bump
<!-- ASTRYX:END -->
