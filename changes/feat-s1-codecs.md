Internal

- Add lease-backed incremental JSON and SSE scanners, mapped output serialization, boundary-role contracts and a destination-bound request validation fence in ck-translate. Preserve unknown data as source positions and reject duplicate decoded keys, invalid text and incomplete records.
- Publish canonical events with trusted local identities, matching SSE and envelope sequence numbers, a validated request-end fence and frame-bounded media data. Protocol implementations remain responsible for payload schemas and item/tool/media lifecycles.
- Add shared semantic fixtures backed by the real stream pool and initial Chat request/response codecs with normalized tool history, mapped media references, independent choice/tool lifecycles and usage snapshots. The pair translators remain active; complete Chat acceptance and production integration are separate milestones.
- Charge scanner, document, lifecycle and output storage to the owning stream through scratch leases and metadata permits. Reject foreign owners before publication and retain provider response identity after an initial heartbeat.
- Publish completed request fields and messages before the body ends, with empty parent containers before children. Keep complete syntax, schema and destination validation at the request-end fence; a rejected suffix preserves the canonical prefix without authorizing upstream encoding.
