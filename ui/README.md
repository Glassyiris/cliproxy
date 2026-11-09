# cook-router dashboard

The management dashboard for cook-router, written in React 19 with the Astryx design system. It talks to the v8 Management API defined by Go CLIProxyAPI. `dist/` is the build output, checked in: the Rust binary embeds it (`crates/cpa-server/build.rs`) and serves it at `/management.html`. The dashboard ships only inside that binary.

Product rules are in [PRODUCT.md](PRODUCT.md) and the visual system in [DESIGN.md](DESIGN.md).

## Commands

Requires Node 22.12 or newer.

```sh
npm ci
npm run dev        # Vite on :5173, proxies /v8 and /healthz to 127.0.0.1:8317 (override with CPA_BACKEND=...)
npm run typecheck  # tsc --noEmit, 0 errors expected
npm test           # unit tests under src/ and scripts/private-auth-dir.test.mjs
npm run build      # vite build into dist/
npm run check:api  # src/lib/api/routes.ts against the Rust management router
```

`ui/dist` is committed because the Rust binary embeds it at compile time. After a source change run `npm run build` and commit the result; CI rebuilds and fails when `ui/dist` differs from the source.

`npm run check:api` reads `fn router` in `crates/cpa-server/src/management.rs` and fails (exit 1) when the registry names a route the server lacks, or when a `/v8/management` route has neither a registry entry nor a line with a reason in `tools/api-allowlist.json`. It exits 2 when the router uses a construct it cannot follow.

## Structure

The React dashboard source. Code rules are in [CONVENTIONS.md](CONVENTIONS.md).

| Path | Role |
| --- | --- |
| `src/main.tsx` | Entry. Loads Astryx's Chinese strings first when the page starts in Chinese, then renders `App`. |
| `src/app/` | Providers, sign-in, the shell (`AppShell` and the side nav), the page frame `PageFrame.tsx`, the route table `routes.ts` with hash routing and one lazy chunk per page, the page error boundary, the theme and language switches. |
| `src/features/<page>/` | One directory per screen: the page, its query hooks in `queries.ts`, tests. |
| `src/components/` | Parts used by two or more screens, such as the status lamp, the code editor and the chart wrappers. |
| `src/lib/api/` | One module per Management API area, one typed function per route; `routes.ts` is the registry `check:api` compares with the Rust router. |
| `src/lib/` | The i18n runtime (`i18n.ts`), `notify()`, the session (sign-in, sign-in help, capability probes) and pure domain logic with tests. |
| `src/i18n/` | Message catalogs, one per area: English in `<area>.ts`, ships with the app; the translations in `zh-CN/` and `zh-TW/`, each locale loaded on demand as one chunk through its `index.ts`. |
| `src/themes/layers.css` | The cascade layer order, imported first: reset, Astryx components, our StyleX (`app`), theme. |
| `src/themes/site/` | The one theme in three palettes: `siteNeutralTheme.ts` (Astryx neutral colours, the default, built to `site-neutral.*`), `siteTheme.ts` (Rosé Pine Moon, built to `site.*`) and `siteMainTheme.ts` (Rosé Pine, built to `site-main.*`), the last two loaded on demand, are the sources, all extending `@astryxdesign/theme-neutral` with tokens only (fonts, icons and components are neutral's), rebuilt with `astryx theme build`. |

## Honest states

Every read renders loading, empty, error, not available, or data. The server kind comes from response headers: cook-router sends `X-CPA-VERSION: cook-router-<version>`; Go sends its version with `X-CPA-COMMIT` and `X-CPA-BUILD-DATE`. Go implements the whole v8 API, so it is never probed.

Other servers are probed once per session for the write actions a screen offers. A route that does not exist answers with gin's empty 404 (or 501/405), and the UI cannot tell that apart from a real route without asking, because `OPTIONS` returns 204 everywhere. Each probe is therefore a request Go rejects with 400 during input validation, before any side effect: an empty JSON body to `POST /credentials`, `POST /credentials/refresh`, `PATCH /credentials/fields`, `DELETE /credentials`, `POST /routing/cooldown/reset`, `POST /requests/api-call` and `POST /oauth/import`; `GET /oauth/auth-url` without a provider; `GET /observability/usage/queue?count=0`. Each was checked against Go 6fecc6e to return 400 with the auth directory and config unchanged. Actions whose probe meets an empty 404 render disabled and are named in one line; reads the server lacks show "Not available on this server" with the route and status code. `DELETE /observability/logs` cannot be probed safely, so Clear is disabled when the log read is unavailable and otherwise marks itself off after a first empty 404.

Traffic comes from `recent_requests` in `GET /credentials` and `GET /observability/usage/api-keys` (twenty 10-minute buckets, reported by the server). The live usage view reads `GET /observability/usage/queue`, which removes records for other consumers, so it is opt-in, asks first, and keeps events in the tab only.

## Endpoints

All paths are under `/v8/management`. Every screen also uses `GET /config` and `GET /credentials`.

| Screen | Endpoints |
| --- | --- |
| Overview | `GET /credentials` every 10 s while visible |
| Accounts | `GET /credentials` every 10 s while visible, `POST /credentials` (upload), `DELETE /credentials`, `GET /credentials/download`, `GET /credentials/models`, `PATCH /credentials/status`, `PATCH /credentials/fields`, `POST /credentials/refresh`, `POST /routing/cooldown/reset`; quota checks by button only, one at a time and at most once per account every 2 minutes: `POST /requests/api-call` (Claude, Codex, Kimi usage), `POST /plugins/<id>/quota`. Batch actions send one request per account, except one `DELETE /credentials` for all. |
| Connect | `GET /oauth/auth-url`, `GET /oauth/status` every 2 s while waiting, `POST /oauth/callback`, `DELETE /oauth/session`, `POST /oauth/import?provider=vertex`, `GET /plugins` |
| Providers | `GET /observability/usage/api-keys`; `PUT /config/api-keys/<family>` |
| Client keys | `PUT /config/access/api-keys` |
| Models | `GET /routing/model-definitions/<channel>`; `PUT /config/oauth/model-alias/<channel>`, `PUT /config/oauth/excluded-models/<channel>` |
| Payload rules | `PUT /config/requests/payload/<kind>` |
| Usage | `GET /observability/usage/api-keys`, opt-in `GET /observability/usage/queue?count=500` |
| Logs | `GET /observability/logs` (cursor, every 3 s), `DELETE /observability/logs`, `GET /observability/logs/errors`, `GET /observability/logs/errors/<name>`, `GET /observability/logs/requests/<id>` |
| Configuration | `GET, PUT /config/<section>`, `GET, PUT /config.yaml` |
| Plugins | `GET /plugins`, `GET /plugins/store`, `POST /plugins/store/<id>/install`, `DELETE /plugins/<id>`, `PUT /config/plugins/enabled`, `GET, PUT /config/plugins/configs/<id>` |
| System | `GET /server/latest-version` on request |

Config list writes reread the target first and refuse to write if it changed since it was shown. The API has no revision precondition, so this narrows the race window rather than closing it.

## Verification scripts

These scripts are for disposable servers with fake credentials only: they edit configuration and credential files. Fixture requirements: management key `orb-dashboard-test-only`, a disabled fake Claude credential with email `operator@example.invalid`, routing strategy `round-robin`, and an empty `requests.payload.default`.

- `node scripts/browser-check-rust.mjs [url] [capture-dir]` drives the dashboard with agent-browser against the Rust binary (or Go): nine screens in both themes, unsupported actions disabled on Rust, a payload rule written and removed, a YAML diff discarded, 390 px layout, and no key in storage.
- `node scripts/fake-logins.mjs [port]` serves fake provider login endpoints (Claude, Codex, Kimi, Meta token, profile, device-code and key-mint routes) and a Claude usage endpoint that echoes its `Authorization` header. Fake tokens and `@example.invalid` emails only.
- `scripts/login-harness/` is a test build of cook-router whose only change is `Options.login_base`, which points every provider login endpoint at the fake. It is never shipped. Build it with `cp ../../../Cargo.lock . && CARGO_TARGET_DIR=../../../target cargo build` inside that directory.
- `CHROME_PATH=... node scripts/oauth-check.mjs <url> --mode fake` drives Claude and Codex sign-in through a pasted callback URL and Kimi and Meta through the device code against the harness, and checks each new credential appears and that a provider the server lacks gets an honest message. `--mode dead` runs against the shipped binary with a dead `requests.proxy-url` and checks that a pasted callback ends in an honest failure.
- The same script's `--mode plugin` uses fake management responses to check relative plugin login URLs, absolute HTTP(S) links, Copy link, guide navigation, cancellation, unsafe-scheme rejection, and a sign-in the server forgot while the tab was hidden (Go and servers before 0.4.2 keep a finished sign-in for a minute). It checks that the status is read as soon as the tab is visible again, that only one new credential name of exactly that built-in provider, between two successful reads, counts as connected, and that a rewritten file, a failed read, a kimi credential for a kimi-ai sign-in, or a plugin provider gives "Result unavailable". It also checks that a status reply delayed past a cancel and a new start leaves the new sign-in alone. Run it against both `/management.html` and a prefixed path such as `/proxy/team/management.html`; it makes no provider calls.
- `node scripts/api-call-check.mjs <base> [<base> ...]` sends the Accounts screen's `POST /requests/api-call` to the fake usage endpoint through each server, checks `$TOKEN$` substitution and that the quota parser reads the windows, and compares the response shape between servers.
- `CHROME_PATH=... node scripts/quota-check.mjs [dashboard-url] [capture-dir]` drives Overview and Accounts with fake management responses (Playwright, like `oauth-check.mjs`): failed checks retain live or passive limits and their timestamps, Claude 403 advice explains setup-token permissions, a successful retry clears errors, a second check within 2 minutes sends nothing, the drawer's Check quota re-enables by itself after its 2 minutes, and a partial batch delete keeps the failed account selected and names it. It makes no provider calls.
- The checks that sign in or send through a real server (`oauth-check.mjs` fake and dead modes, `first-run-check.mjs`, `api-call-check.mjs`) refuse to start unless the server reports an auth-dir whose real path, symlinks resolved, is strictly inside the system temp dir's real path (`scripts/private-auth-dir.mjs`; a path that doesn't resolve is refused too, and `npm test` covers it with disposable symlinks). The key is `oauth.auth-dir` (or the legacy root `auth-dir`). Anything else, such as `management.auth-dir`, falls back to `~/.cli-proxy-api`, where real logins live, and `isolated.sh` isolates the network, not the filesystem. Set `HOME` to a temp dir as well. `first-run-check.mjs` alone runs against `tools/mock/server.mjs --accounts 0` and skips the check for it (the mock answers `X-CPA-VERSION: cook-router-mock` and keeps accounts in memory).
- `scripts/verify-backend.mjs` is the API-level verifier for the Go release backend.

## Security

Requests read the management key from `src/lib/api/client.ts` module memory. It is also kept in the tab's session storage, so a reload stays signed in, and in local storage only when "Remember on this device" is ticked (`src/lib/keyStore.ts`); sign-out clears both. Otherwise only the theme mode, the palette and the language are stored (`src/app/preferences.ts`), plus the first-run card's flags (`src/lib/firstRun.ts`). Plugin store descriptions are decoded as text, never inserted as HTML. Downloaded credential files and configuration previews contain secrets; treat them accordingly. Do not use the dashboard over plain HTTP across a network.

## Fonts

Neutral's own: Figtree (body and headings, SIL Open Font License 1.1) and the system monospace stack, as `@astryxdesign/theme-neutral` (MIT) sets them; the theme package bundles no font files and its `fonts.css` loads Figtree from Google Fonts at run time, so `src/themes/site/index.ts` imports the same weights (400 to 700) from `@fontsource/figtree` (OFL 1.1) instead and the dashboard makes no third-party request. CJK text uses the system fonts.

## Colours

Rosé Pine palette (MIT, https://github.com/rose-pine/palette), values unmodified in `src/themes/site/rosePine.ts`.
