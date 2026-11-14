Internal

- Add lease-backed incremental JSON and SSE scanners, mapped output serialization, boundary-role contracts and a destination-bound request validation fence in ck-translate. Preserve unknown data as source positions and reject duplicate decoded keys, invalid text and incomplete records.
- Publish canonical events with trusted local identities, matching SSE and envelope sequence numbers, a validated request-end fence and frame-bounded media data. Protocol implementations remain responsible for payload schemas and item/tool/media lifecycles.
- Add shared semantic fixtures backed by the real stream pool. The pair translators remain active; protocol codecs and production storage integration are not part of this framework milestone.
