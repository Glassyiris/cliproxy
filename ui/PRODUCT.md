# cliproxy-rs dashboard

The management dashboard embedded in cliproxy-rs, a Rust rewrite of CLIProxyAPI. It serves at `/management.html` from the server binary and talks only to that server: the v8 Management API, plus `GET /v1/models` with a client key when the Use with tools page tests the key. It is the most visible part of the launch, so it has to look authored and still be quick to use.

## Who and where

The operator is one developer or a small team. The proxy runs on a laptop, a home server or a small VPS, and coding agents send it requests all day. The dashboard sits in a browser tab next to a terminal and an editor, often late at night. On a phone it is used to check status or flip one switch.

They come with these questions, in this order: is traffic flowing, which credentials are ready, cooling down, disabled or failing, how do I connect another account, how do I change a setting without breaking anything, and what do the logs say.

## Contract

- The data contract is Go CLIProxyAPI's v8 Management API at commit 6fecc6e (v8.0.10). The UI is built to Go's request and response shapes.
- The server may be the Rust binary, which does not implement every management route yet. Like Go, it answers a route it lacks with an empty 404. On servers other than Go the UI sends one probe per write action, a request Go rejects with 400 before any side effect, and shows actions the server lacks disabled, with one line naming them. Reads that fail this way show a "not available on this server" state naming the route.

## Non-negotiables

- Honest data. Every read shows one of loading, empty, error, not available, or data. Nothing is invented. Telemetry comes from server-side `recent_requests` buckets; the destructive usage queue is opt-in and stays in the tab.
- The management key is kept in the tab's session storage, so a reload stays signed in; in local storage only when the operator ticks "Remember on this device"; in the browser's password manager only when the operator saves it there. Sign-out, here or in another tab, clears both stores and cancels any sign-in in progress in any tab; a rejected key is removed only from the stores that hold that same key, so a newer key saved by another tab survives. Both stores are readable by any script on the page, so the protection against injected scripts is the same as before reload support existed, not stronger; the difference is the key's lifetime, and that local storage sits on disk in the browser profile (owner, 2026-11-08). Requests read the key from memory and send it only in the `Authorization` header.
- Accessibility: a complete keyboard path, visible focus, WCAG AA contrast in both themes, status never shown by colour alone, reduced motion respected.
- A small, fast bundle: at most 52,000 B of JavaScript and 6,853 B of CSS, gzip. The ceilings began as the sizes of the dashboard this one replaced (42,642 B and 6,853 B); JavaScript was raised three times, for the beginner onboarding, for the Claude usage parser and plan limits, and for 0.4.2's Accounts page, Connect result and sign-in recovery, all asked for. `npm run build` fails past them. No runtime dependencies beyond Svelte, and no chart library.

## Scope

Overview, accounts (credentials with their quotas) and connecting accounts (OAuth, device codes, callback paste, Vertex import), provider API keys, client keys, models (aliases, exclusions, catalog), payload rules, configuration (JSON and YAML with a reviewed diff and a stale-write check), logs, usage, plugins and system.

Out of scope: accounts or billing, a historical telemetry database, invented Rust-only endpoints, and process metrics the API does not expose.
