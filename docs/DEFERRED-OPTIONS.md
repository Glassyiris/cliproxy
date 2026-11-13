# Deferred options

| Item | Source | Reason it waits | Reconsideration trigger |
| --- | --- | --- | --- |
| Non-consuming cursor reads for the usage queue | [Plan v5 §八](https://paste.gentoozh.org/md/i6sae5u8moj.md) | New behaviour and storage require retention, restart, multiple-reader and Home usage-push decisions. | A separately scoped proposal with its own acceptance criteria. |
| Home RESP protocol changes | [Plan v5 §八](https://paste.gentoozh.org/md/i6sae5u8moj.md) | Home is not an HTTP caller; the API redesign leaves this boundary unchanged. Home-dispatched plugins still undergo plugin ABI checks. | A separate change requiring the RESP boundary to change. |
| Roles and read-only keys | [Plan v5 §八–九](https://paste.gentoozh.org/md/i6sae5u8moj.md) | The current API has one administrator role; no read-only requirement is recorded. | A user needs view-without-write permission; use a static operation-to-role table then. |
| v1 compatibility policy and microversion negotiation | [Plan v5 §九](https://paste.gentoozh.org/md/i6sae5u8moj.md) | The 2026-11-13 ruling keeps no backward compatibility anywhere while callers change together. | An external client needs long-term support and cannot update with the server. |
| Hosted dashboard (option E) | [Plan v5 §九](https://paste.gentoozh.org/md/i6sae5u8moj.md) | Cross-origin and browser local-network access are not yet proven. | The management origin allowlist is deployed and a real browser verifies that an HTTPS dashboard can reach the user's server under current Local Network Access restrictions. |
