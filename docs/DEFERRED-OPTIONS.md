# Deferred options

| Item | Source | Reason deferred | Reconsideration trigger |
| --- | --- | --- | --- |
| Non-consuming cursor reads for the usage queue | [Plan v5 §八](https://paste.gentoozh.org/md/i6sae5u8moj.md) | The new behaviour and storage require decisions on retention, restart and multiple readers. | A separately scoped proposal with its own acceptance criteria. |
| Roles and read-only keys | [Plan v5 §八–九](https://paste.gentoozh.org/md/i6sae5u8moj.md) | The current API has one administrator role; no read-only requirement is recorded. | If a user needs view-without-write permission, use a static operation-to-role table. |
| v1 compatibility policy and microversion negotiation | [Plan v5 §九](https://paste.gentoozh.org/md/i6sae5u8moj.md) | The 2026-11-13 ruling keeps no backward compatibility anywhere, and every caller changes in the same change. | An external client needs long-term support and cannot update with the server. |
| Hosted dashboard (option E) | [Plan v5 §九](https://paste.gentoozh.org/md/i6sae5u8moj.md) | Cross-origin and browser local-network access are not yet proven. | The management origin allowlist is deployed and a real browser verifies that an HTTPS dashboard can reach the user's server under current Local Network Access restrictions. |
