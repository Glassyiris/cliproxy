Changed

- The dashboard is rewritten on React 19 and the Astryx design system, with a side navigation. Old hash links redirect to the new pages, and the dashboard reloads once once when a newer build replaced the one it loaded.
- Overview shows a status summary (accounts that can serve, requests, failure share), attention cards for problems such as missing client keys or unreachable upstreams, and request charts by time and by source.
- Accounts lists credentials with search and filters, per-account details and upstream errors, and actions to upload files, check quotas, refresh a token, reset a cooldown, disable and delete. Provider keys are managed on the same page in groups.
- Connect adds an account step by step, with progress shown, and a first-run guide walks through connecting an account and a client key.
- Client keys can be added, revealed, copied and revoked from the row actions.
- "Use with a tool" gives a three-step setup for each coding tool and tests the client key against the proxy.
- Models manages aliases and excluded models, and Payload rules adds, edits and removes the rules that change request bodies.
- Usage charts requests and failures per ten minutes, by source and per model, with an opt-in live view of recent requests that shows model, latency and tokens.
- Logs shows the application log and the error log files with follow, search by text or request ID, level filters and Clear.
- Settings edits the configuration through grouped controls or as the raw configuration file, and shows a review of the changes before saving. Plugins, About and the System dialog open from the dashboard.
- The dashboard is available in English, Simplified Chinese and Traditional Chinese, and only the active language loads.
- Light and dark themes switch with one click, and Dark Reader is kept out of the dashboard.
- Signing in lasts for the tab by default; "Remember on this device" keeps the key in the browser, and the browser's password manager can save it. Signing out in one tab signs out every tab and cancels sign-ins in progress.
- Saving a configuration change no longer overwrites a newer one made elsewhere.
- Charts load on demand, and the first load is 334 KB of JavaScript and 48 KB of CSS, gzipped.
