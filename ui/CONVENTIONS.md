# Dashboard code conventions

How code in `ui/` is written. Visual rules are in `DESIGN.md`; the quality requirements every
change is checked against are in `AGENTS.md`. Where a rule has a gate, the gate is named; a rule
without one is checked in review.

## Language and tooling

- TypeScript `strict`, ES modules, React 19 function components. The only class is the error
  boundary. No `any` (lint), no `// @ts-ignore`; `@ts-expect-error` only with a reason.
- Prettier: double quotes, semicolons, trailing commas, `printWidth` 100 (`npm run format`,
  checked by `npm run lint`).
- ESLint flat config with typescript-eslint, react-hooks, the import-boundary rule and the limits
  below. `--max-warnings 0`.

## Layout and boundaries

```
src/app/         shell, hash routes, providers, page error boundary
src/features/<page>/   one directory per screen: <Page>.tsx, parts, queries.ts, *.test.ts, index.ts
src/components/  shared parts used by two or more features
src/lib/api/     one module per Management API area, one typed function per route
src/lib/         i18n, notify, session, pure domain logic (credentials, quota, time)
src/themes/      the site theme, the only place a colour value may appear
src/i18n/        catalogs per area: en, zh-CN, zh-TW
```

- A feature imports from `components/`, `lib/` and `app/` only, never from another feature.
  Shared code moves up. (gate: import-boundary lint)
- A feature exposes only what `index.ts` exports; the route table imports that. The page entry is
  the one default export, for `React.lazy`.
- Pages never build URLs or call `fetch`; they call `lib/api` through query hooks in their
  `queries.ts`. (gate: `check:api`, lint ban on `fetch` outside `lib/api`)
- No module or directory named util, common, helper, shared or misc.

## State

- Server state: TanStack Query only. One query key factory per feature; writes invalidate the
  keys they change. Polling uses `refetchInterval` with `refetchIntervalInBackground: false`.
- UI state: component state, or the hash query string when it should survive reload or be
  shareable (tab, filter, search, open row).
- Session (management key, server version, capabilities) lives in one React context and in
  memory only — never in storage.

## Styling

- Astryx component props first; then StyleX `stylex.create` with theme tokens. No CSS files, no
  `style={{}}`, no hex, rgb or px values outside `src/themes/`. (gate: check-ui)
- Our StyleX output sits in the `app` cascade layer, after Astryx's components and before the
  theme (`src/themes/layers.css`, `useCSSLayers` in `vite.config.ts`). Unlayered CSS would beat
  the theme: one of our atomic classes shared a name with Button's and hid every destructive
  label. So when xstyle and the theme set the same property, the theme wins.
- Motion only through the shared motion module. (gate: check-ui)

## Text

- Every user-visible string, including `aria-label`, `title` and `placeholder`, goes through
  `t("area.key", args)` with ICU messages; plurals use ICU `plural`, never string suffixes.
  (gate: check-i18n, JSX literal lint)
- Keys are `<area>.<part>.<name>`, camelCase segments; `area` is the feature name or `app`.
- Notifications go through `notify(level, message)` with `success | info | warning | error`.

## Naming

- Components and their files: PascalCase (`AccountRow.tsx`). Hooks: `useX`. Other modules:
  camelCase (`quotaWindows.ts`). Feature directories: lowercase (`accounts/`).
- Names say what a thing is in this product's terms (account, provider key, client key), the
  same words as the glossary.

## Comments

- English. Only for what the code cannot say: an invariant, a server quirk, a security boundary,
  a trade-off. No comments that restate the code, no commented-out code, no TODO.
- A deliberate simplification carries `ponytail:` with its limit and how to lift it (repository
  convention, see `CONTRIBUTING.md`).

## Limits

File ≤ 600 lines, function ≤ 80 lines, cyclomatic complexity ≤ 15. Existing excess is a ratchet
file that fails both when the count rises and when it falls without being lowered. (gate: lint)

## Tests

- Pure logic: `*.test.ts` beside the module, `node --test`. Assert behaviour, not implementation.
- Browser behaviour: `ui/scripts/*-check.mjs` against disposable backends inside
  `ui/scripts/isolated.sh`; performance: `ui/tools/perf`.
- Deleting a component deletes its tests in the same change.

## Adding a page

1. `astryx build "<page idea>"`, scaffold with `astryx template`, keep its frame.
2. Create `src/features/<page>/` with `<Page>.tsx`, `queries.ts`, `index.ts`.
3. Add its API functions to `lib/api` (registry entry included) if they do not exist.
4. Add its catalog area in all three locales.
5. Add the route in `src/app/routes.ts` and its perf adapter selectors if it is measured.

## Commits

Repository style: an optional area prefix and one plain sentence, e.g.
`Dashboard: Accounts page for many accounts`. Body explains why. No AI attribution.
