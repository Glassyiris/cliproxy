# Internal stream reference (S0)

## 1. Purpose and scope

Define the sole internal representation for cooker inference: a Chat Completions-based, versioned SSE grammar covering requests, streamed and buffered responses, count_tokens, compact, legacy completions, Responses HTTP/WebSocket, Anthropic Messages, Gemini generation/Interactions, images, speech, video, realtime/Live, Codex alpha search and AI Studio relay inference traffic. All client and upstream boundaries decode/encode, including same-protocol traffic; no raw-byte bypass exists. Only management/dashboard, health/root, model discovery, OAuth callbacks, authentication/ephemeral-key issuance, transport handshakes and already-unimplemented operations are outside inference conversion; authentication and transport remain boundary responsibilities, while SDP, session commands and media content are inside. Current route evidence: `crates/ck-server/src/lib.rs:81-146`, `crates/ck-server/src/realtime.rs:85-112`, `crates/ck-server/src/codex_alpha.rs:22-25`, `crates/ck-server/src/relay.rs:49-59`; current transcription/translation/SIP stubs: `crates/ck-server/src/realtime.rs:12`. This is a normative target, not a claim of implementation; current-code citations refer to `prep-cook/cooker` master `17608e94`.

## 2. Decisions

MUST/SHOULD/MAY have RFC 2119 meanings. Unlabelled requirements below specify this grammar, not additional owner quotations.
`Settled` means `docs/OPEN-QUESTIONS.md`, "Settled"; `Q` means the S0 question list (https://paste.gentoozh.org/md/r-Ncm2jUEeb.md). Defaults were set on 2026-11-13 by the maintainers after the owners asked them to proceed.
The specification supersedes contrary suggestions in the earlier review and unanswered-question wording; those are not competing contracts.
The maintainer defaults B1-B9, C2, D1, D3 and F, and the pool-lifetime reading of G4, stand as settled defaults: the owner accepted them on 2026-11-14 with no further questions (Settled 43). A later owner ruling may still revise a row. Interoperability requirements govern every implementation; mechanisms labelled **S1 choice** bind S1 only, with rationale beside each choice.

| Subject | Status | Decision | Source |
| --- | --- | --- | --- |
| A1–A4 | Settled | Chat chunk base; `x_ck` JSON plus named events; one version; unknown fields/events reach egress intact. | Settled |
| Conversion | Settled | Every ingress/egress converts, including same-protocol; replace pairwise paths without compatibility shims. | Settled |
| Non-SSE | Settled | Custom-data chunks ≤50 KB; collection delay ≤100 ms. | Settled; `crates/AGENTS.md:25` |
| Storage | Settled | mmap files, fixed blocks, positions only; no heap storage of stream data. | Settled; `crates/AGENTS.md:24` |
| Frame size | Settled | Storage frames are 50,000 bytes, the non-SSE chunk size. | Owner ruling 2026-11-13 (G1′) |
| Full storage | Settled | One cache queue holds all stream bytes. Under size pressure the stream read least recently goes first; a stream not read for 1 h expires. Disk-full/other edges best effort. | Settled; owner ruling 2026-11-14 (Settled 41, §6.4) |
| Plugins | Settled | Plugins are deleted; extension means modifying the source and rebuilding. See §8. | Owner ruling 2026-11-13 |
| G2 | Settled | Default directory `$XDG_RUNTIME_DIR/cook-router/` (tmpfs); configurable (§6.3). | Owner ruling 2026-11-13 |
| G3 | Settled | One preallocated mmap pool file per process, 50,000-byte frames. Padded per-thread LIFO free lists, 128-byte-aligned shared counters, per-stream frame table. The committed length lives in a per-stream header slot in the pool; the file header records only the pool's backed size (§6.1). Grow with `fallocate` and check its result; an `ftruncate`-only grow turns tmpfs exhaustion into SIGBUS. Per-request files cost -94% req/s on 2 KiB requests sequentially and -99% at 64 tasks (`mmap`/`munmap` lock and TLB shootdown); the pool matches or beats heap in every measured row except one that is still open (§6.1, §9.3). | Owner ruling 2026-11-13; shared pool confirmed 2026-11-14 |
| G4/G5 | Settled | Unlink immediately (or O_TMPFILE) where possible; otherwise keep the path until the pool closes, then delete it. No startup sweep (§6.3). The pool-lifetime reading (the path lives until the pool closes) is accepted. | Owner ruling 2026-11-13; reading accepted 2026-11-14 (Settled 43) |
| G6 | Settled | No application encryption; protection comes from OS disk and memory encryption. File 0600, directory 0700 (§6.3). | Owner ruling 2026-11-13 |
| G7 | Settled | Out of pool space or over a limit returns an error; no heap fallback (§6.4). | Owner ruling 2026-11-13 |
| G8 | Settled | Per-stream limit 256 MiB (5,368 frames); pool total at most 4 GiB (85,899 frames), lowered only by the startup caps in §6.4. | Owner ruling 2026-11-14 (Settled 41) |
| G9 | Settled | Performance tests mount the storage directory on tmpfs; no regression against heap buffering is accepted (§9.3). | Owner ruling 2026-11-13 |
| Exhaustion/platform | Settled | Visible failure, no degradation; Linux server only. | Settled; `crates/AGENTS.md:75` |
| B1 | Settled (default accepted 2026-11-14) | Claude signatures remain bound to their thinking block. | Q |
| B2 | Settled (default accepted 2026-11-14) | Redacted thinking has its own opaque event. | Q |
| B3 | Settled (default accepted 2026-11-14) | Gemini signatures remain part-bound, including signature-only parts. | Q |
| B4 | Settled (default accepted 2026-11-14) | Preserve cache TTL buckets; absence ≠ zero; usage snapshots, not deltas. | Q |
| B5 | Settled (default accepted 2026-11-14) | Logprobs stay in Chat's choice-level location. | Q |
| B6 | Settled (default accepted 2026-11-14) | Preserve media MIME, bytes, transcript and timing. | Q |
| B7 | Settled (default accepted 2026-11-14) | Independent choice state; single-choice destinations emit choice 0, debug-log dropped indexes. | Q |
| B8 | Settled (default accepted 2026-11-14) | Tools have start/argument-delta/end; whole calls become one argument delta. | Q |
| B9 | Settled (default accepted 2026-11-14) | Grounding/code execution/URL context are named events; unsupported egress drops with debug logs. | Q |
| C2 | Settled (default accepted 2026-11-14) | Invalid textual UTF-8: client 400; upstream error; binary media is not text. | Q |
| D1 | Settled (default accepted 2026-11-14) | Configurable stream limits; event and metadata sizes start with the §6.4 provisional values, replace after measurement. Cache size and cache age are owner numbers (G8, Settled 41), not defaults. | Q |
| D2 | Settled | The gateway buffers like a router: a slow client never pauses upstream reads; upstream bytes are collected into the pool and relayed at the client's pace. Buffered bytes are ordinary cache entries: they follow the same 1 h no-read expiry and least-recent-read eviction as every other byte (G8). Exceeding the per-stream limit fails the stream visibly (G7). Leased frames are never overwritten. | Owner ruling 2026-11-14; reconciled by Settled 41 |
| Further details | Settled | Any detail this spec does not cover follows the observed behaviour of the keeper component of AI-gateway, pinned at commit `b49ad9ac6c1eb65b1785d66ecb7249413d4c82bf` of https://github.com/xz-dev/openai-api-cache-keeper (the submodule of https://github.com/xz-dev/AI-gateway). It is a behaviour reference; its code is not copied. Later keeper changes are adopted only by updating this pin. | Owner ruling 2026-11-14 (Settled 43) |
| Resume | Settled | A client disconnect never cancels, releases or cleans a stream: upstream collection continues and the bytes stay cached, so a reconnecting client resumes from its last delivered position (§6.6). | Owner ruling 2026-11-14 (Settled 42) |
| D3 | Settled (default accepted 2026-11-14) | No failover after the first event producing client-deliverable bytes. | Q |
| F | Settled (default accepted 2026-11-14) | Measure first, obtain owner-approved thresholds; use §9 commands and codec metrics. | Q |

## 3. Stream grammar

### 3.1 Framing and base chunk

Every record is UTF-8 SSE: optional `event: NAME\n`, optional `id: SEQUENCE\n`, exactly one `data: JSON\n`, then `\n`.
The unnamed/default event is a Chat chunk; extension event names start `x_ck.`. Emit LF; boundary parsers accept LF, CRLF and CR.
Ingress SSE joins multiple `data:` lines with LF, observes empty-event boundaries, and validates text across fragmented network reads.
Internal JSON has no literal newlines outside strings, duplicate object keys or non-finite numbers. Reject ambiguous duplicate-key input rather than silently selecting a value.
An external event's `id`, `retry`, comments and unrecognized SSE fields are preserved in `X.source.sse`; internal SSE `id`, when present, equals `X.seq`.
Transport keepalive comments become heartbeat metadata if needed; internal heartbeats are named events. Internal `[DONE]` is forbidden; boundary codecs translate it to/from terminal events.

```text
ChatEvent = {
  id: string, object: "chat.completion.chunk", created: integer, model: string,
  choices: [{index: uint, delta: object, finish_reason: string|null,
             logprobs?: object|null, ...unknown_choice_fields}],
  usage?: ChatUsage, system_fingerprint?: string|null, service_tier?: string,
  x_ck: X, ...unknown_chat_fields
}
NamedEvent = {x_ck: X, ...payload_fields_from_the_registry}
```

`id` is the response identifier, not the gateway request identifier; preserve a supplied value, synthesize only when absent.
`created` is Unix seconds; retain any higher-resolution original timestamp in `X.source`. `model` is the effective externally mapped model, not a credential identity.
`delta` retains Chat fields, including role, content, refusal, reasoning_content, tool_calls, audio and annotations; media bytes use §3.4 rather than a second inline copy.
One canonical Chat event carries at most one choice and one item/block/tool delta; split multi-choice/multi-part source events in source order.
Usage-only/base-metadata chunks may have `choices: []`. Choice-level `logprobs` may accompany text/refusal or stand alone with `delta: {}` and `finish_reason: null`; preserve the choice index and supplied item/block correlation without fabricating text or opening a text block.
A finish-only chunk has `delta: {}` and a non-null `finish_reason`; native reasons remain separately available.

### 3.2 The `x_ck` object

`X` denotes this object; `?` denotes absence allowed, not implicit null. Integers used for counters are unsigned 64-bit unless specified otherwise.
Local identifiers are ASCII strings of at most 64 bytes; preserve unrestricted provider identifiers separately in `source.ids`.
The source protocol is provenance; internal routing, scheduling, accounting and in-process stages MUST NOT branch on protocol wire shapes.

| Field | Type | Meaning |
| --- | --- | --- |
| `v` | integer, required, `1` | This grammar version, shared by chunks, named events and requests. |
| `request_id`, `stream_id` | local ID, required | One gateway request/turn; one unidirectional logical event stream. |
| `attempt` | uint, required | Routing attempt; changes before failover, never after downstream commitment. |
| `seq` | uint, required | Starts at 0, strictly increases by one in the published stream. |
| `direction` | `request` or `response`, required | Duplex sessions use separate ordered streams per direction. |
| `choice_index` | uint? | Required for choice-scoped named events; equals the Chat choice index when present. |
| `item_id`, `tool_call_id`, `media_id` | local ID? | Stable internal identities; never substitute one for another. |
| `block_index` | uint? | Logical content/thinking/part index within an item; not a frame number. |
| `tool_index` | uint? | Chat tool index within a choice; independent of content block index. |
| `source` | object? | `{protocol, event?, ids?, sequence?, output_index?, content_index?, summary_index?, part_index?, timestamp?, sse?}`. |
| `source.ids` | object? | Original request/response/item/call/part/session IDs under their original field names. |
| `native_finish_reason` | JSON value? | Exact source stop/status reason, including unknown reasons. |
| `original` | array? | Unmapped field records `{protocol, pointer, value}`; pointer is RFC 6901 within its correlated source object. |
| `synthetic` | array of strings? | Names of generated fields, e.g. `id`, `created`, `item_id`; never pretend they came from upstream. |
| `span` | object? | `{start, end, unit, source_pointer?}`; end-exclusive source offsets, unit `utf8_byte`, `unicode_scalar`, `utf16_code_unit` or `token`. |
| `...` | JSON values | Unknown extension members preserved; only registered fields control execution. |

Every record carries correlation, even when its payload is empty. Source IDs are restored by capable egress, not regenerated on each delta.
For source protocols without item IDs, allocate stable local items at part/block starts; close them at source stops or a validated choice finish.
A signature-only Gemini part gets its own item/block even if it contains no text. Do not attach it to the preceding textual part.

### 3.3 Named-event registry

Every row inherits `X`; fields without `?` are mandatory. “Required” in schema/correlation columns means the named fields must be present; choice/item/block/tool/media abbreviate the corresponding `X` indexes/IDs. `value` is valid JSON, not a serialized JSON string unless the source value was a string.
Native annotation/grounding/code/context payloads remain boundary-only data; supported content and operation semantics use §4 schemas, not protocol-specific body inspection by internal consumers.
The registry is closed for core behavior, open for opaque carriage: an unrecognized name is preserved under §3.7, not executed.

| Event suffix after `x_ck.` | Payload schema | Correlation and purpose |
| --- | --- | --- |
| `request.start` | `{operation: string}` | Begins the request document defined in §4. |
| `request.field` | `{pointer: string, value: JSON}` | Sets one complete field of that logical document; no duplicate path assignment. |
| `request.end` | `{}` | Complete request syntax/schema and destination capability validation succeeded (§4); execution fence. |
| `response.start` | `{id: string, model: string, created: integer, status?: string}` | Response lifecycle; may precede deliverable output. |
| `item.start` | `{kind: string, role?: string, attributes?: object}` | Required item/choice identity; attributes include native item type/status. |
| `item.end` | `{status: "completed"\|"incomplete", attributes?: object}` | Closes an item after all child blocks and tools. |
| `block.start` | `{kind: string, attributes?: object}` | Text, thinking, redacted, function, media or opaque content block. |
| `block.end` | `{}` | Closes the correlated block; no later deltas/signatures for it. |
| `reasoning.signature` | `{kind: "anthropic"\|"gemini"\|"responses_encrypted", fragment: string, final: bool}` | Required choice/item/block; string bytes preserved, no decode/re-sign. |
| `reasoning.redacted` | `{data: string}` | Required choice/item/block; opaque redacted content, not readable reasoning. |
| `tool.start` | `{name: string, kind: "function"\|"custom"\|"server", arguments_format: "json"\|"text", namespace?: string}` | Required choice/item/tool ID/tool index; optional source block. |
| `tool.end` | `{status: "completed"\|"incomplete", valid_json?: bool}` | Completion marker, not another arguments payload. |
| `tool.result` | `{value: JSON, is_error?: bool}` | Correlates historical/request or server-side tool output to the call. |
| `annotation` | `{kind: string, value: JSON}` | Citation/refusal/safety metadata; retain source offsets in `X.span`. |
| `grounding` | `{value: JSON}` | Candidate/item-scoped grounding chunks, supports and search metadata. |
| `code_execution` | `{phase: "code"\|"result", value: JSON}` | Executable code and execution results remain distinct, ordered records. |
| `url_context` | `{value: JSON}` | Retrieval/context metadata with originating choice/item. |
| `usage` | `{usage: UsageSnapshot}` | Attempt-scoped cumulative snapshot (§3.5); optional choice scope. |
| `count_tokens` | `{input_tokens?: uint, total_tokens?: uint, details?: object}` | Count operation result, not generation usage. |
| `compact` | `{item: JSON}` | One ordered compact output item, including encrypted/opaque fields. |
| `media.start` | `{kind: string, mime?: string, encoding: "base64", attributes?: object}` | Required media ID; MIME is absent if unknown, never guessed from modality. |
| `data` | `{index: uint, offset: uint, bytes: string}` | Required media ID; base64 chunk, zero-based chunk index and decoded-byte offset. |
| `media.transcript` | `{text: string, final: bool, timing?: object}` | Media ID; timing retains units, start/end and track/channel information. |
| `media.end` | `{bytes: uint, status: "completed"\|"incomplete"}` | Total decoded byte count; no implicit success on EOF. |
| `operation` | `{kind: string, value: OperationValue}` | Closed semantic variants in §4 for video, search and realtime; unmapped data uses `opaque`. |
| `opaque` | `{name?: string, format: "json"\|"text", value: JSON}` | Source event/field without a registered semantic mapping. |
| `heartbeat` | `{}` | Progress/liveness, never token usage or successful completion. |
| `done` | `{}` | Successful logical stream termination, after final usage and closes. |
| `error` | `{code: string, status: uint, message: string, scope: "client"\|"upstream"\|"resource"}` | Terminal sanitized failure; source detail remains restricted provenance. |
| `cancelled` | `{reason: "client_cancel"\|"shutdown"}` | Terminal cancellation; no fabricated success. A client disconnect is not a cancellation (§6.6), and expiry or eviction ends a stream with `error` `stream.gone`, not `cancelled`. |

Error codes this specification registers: `stream.gone` (status 410, scope `resource`) means the stream expired, was evicted, never existed or belongs to another identity (§6.2, §6.6); `stream.storage_exhausted` (status 503, scope `resource`) means a stream, pool or metadata limit, or ENOSPC, refused an allocation (§6.4, G7).

Tool argument deltas use Chat `delta.tool_calls[].function.arguments`; custom text uses the same string slot plus `arguments_format: text` on its start.
The start carries identity/name; a Chat delta may repeat the original source call ID/name for native egress, but repetition is not a new call.
Text and reasoning deltas use Chat `delta.content` and `delta.reasoning_content`; `block.start.kind` distinguishes full reasoning from summaries.
Refusals use Chat `delta.refusal`, with native safety/refusal metadata in annotations. Do not reclassify a blocked answer as an ordinary stop.

### 3.4 Custom data and media

50 KB means 50,000 bytes; KiB means 1,024 bytes. JSON/SSE is textual; arbitrary binary appears only as base64 data chunks.
Use full decoded chunks of 36,864 bytes (49,152 base64 ASCII bytes; 36,864 = 3 × 12,288), with a short chunk on timer, object/message end or cancellation.
The whole encoded `data` event (SSE framing, JSON and base64) MUST NOT exceed 50,000 bytes, the size of one frame. A full chunk leaves 848 bytes (50,000 − 49,152) for framing. When an event's framing would exceed 848 bytes, shorten the decoded chunk to the largest multiple of 3 bytes not above 3 × ⌊(50,000 − framing) / 4⌋. 50,000 raw bytes would require 66,668 base64 bytes before framing and MUST NOT be used.
A complete `data` record MUST fit one frame. It contains only compact common correlation and the three payload fields; emit large source metadata in `media.start`/`opaque`, not every chunk.
Measure collection delay from the first byte of an uncommitted chunk using a monotonic clock; while allocation succeeds, publish within 100 ms or immediately at the chunk ceiling/object end.
A stalled consumer delays transmission, not collection: publish to mmap and keep reading upstream (D2). Allocation failure instead ends the stream with an error event via §6.2 terminal state; it does not extend the timer or permit heap spill.
Preserve MIME, codec, sample rate, channels, dimensions, transcript, source timestamps/timebase, message/packet boundaries and original base64 spelling when semantically relevant metadata requires it.
Binary data bytes are exact after base64 decoding; JSON whitespace, escaping and transport frames are not byte-preservation contracts.
For realtime, `media.start.attributes` names track, packet/message ID, timestamp/timebase and flags; `media.end` closes that packet/message, not the whole session.
Large media values embedded in JSON are decoded incrementally into these chunks, with a media-reference content part instead of a second inline byte copy.

### 3.5 Usage snapshots

| `UsageSnapshot` field | Meaning |
| --- | --- |
| `input_tokens?`, `output_tokens?`, `total_tokens?` | Inclusive input; inclusive output including reasoning; total if reported or derivable. |
| `input_uncached_tokens?`, `cache_read_tokens?`, `cache_write_tokens?` | Non-overlapping input components when the source reports them. |
| `cache_write_by_ttl?` | Map of TTL seconds as decimal strings to counts; Claude keys `300` and `3600`; retain other native buckets in `native`. |
| `reasoning_tokens?`, `input_audio_tokens?`, `output_audio_tokens?` | Subsets, not additions to inclusive totals. |
| `details?` | Other mapped Chat token details, including accepted/rejected prediction and modality breakdowns. |
| `native` | `{protocol, value}` preserving source usage fields and their absence/null distinctions. |
| `derived?` | Field-name array identifying computed rather than reported counts. |
| `final` | Boolean; last authoritative snapshot for this scope when true. |

Omitted counts stay absent; explicit zero stays zero; native null stays in `native`, never coerced to zero.
For Claude, inclusive input = uncached input + cache read + cache creation; do not add TTL buckets again to cache creation.
Derive `total_tokens` only from known inclusive `input_tokens` and `output_tokens`; derive Claude inclusive input only when uncached, cache-read and cache-creation counts are all known. Never infer an absent operand as zero. Retain disagreeing provider totals with a content-free diagnostic.
A partial source usage update replaces the fields it supplies in the retained snapshot; it does not add them. Missing fields retain prior known values for that attempt/scope.
Emit the resulting snapshot. A repeated or corrected snapshot replaces the previous one; accounting never sums successive snapshots or their Chat projections.
If a Chat chunk contains native `usage`, publish its canonical snapshot once and treat the chunk field only as an egress projection; account only `x_ck.usage`.
Account each routing attempt independently, including failed attempts when usage is known; bill/record no duplicate client-egress observation. A count_tokens result is never billed as generated output.

### 3.6 Ordering, termination and commitment

A request stream is `request.start`, ordered fields/media, `request.end`, `done`; parse failure uses `error` instead of successful closes.
A response is `response.start`, interleaved choice-local events, exactly one of `done`, `error`, `cancelled`.
For each item: start → block/tool starts → deltas/signatures/results → block/tool ends → item end → choice finish. Independent choices may interleave.
Signatures belong to their original block/part even when emitted after text. All signature fragments precede block end; never merge signatures across blocks.
Whole function calls become start → one arguments delta → end. Streaming calls forward each received argument fragment without waiting for block stop.
An absent whole-call argument field is not invented as `{}`; preserve absence in provenance and represent an empty argument delta only when the source supplies an empty string/object representation.
After a choice finish, only stream-level metadata/usage or other choices may continue. Success needs all opened objects closed and the source completion boundary below.
Source final snapshots are reconciliation inputs, not fresh deltas: do not duplicate text, media or tool arguments already emitted; reject contradictory completions as an upstream error.
EOF before that boundary, an unterminated SSE record, missing tool completion or invalid JSON produces `error`, not `done`.
On error/cancellation, open objects are incomplete by definition; do not manufacture successful item/tool/choice ends. No events follow a terminal record. Expiry and eviction (§6.4) end a stream with `error` `stream.gone`; `cancelled` carries only `client_cancel` or `shutdown`.
A successful non-streaming source body supplies the source completion boundary once fully validated; a finite download closes with matching byte counts.
Streaming boundaries: Chat/legacy `[DONE]` after choice finishes; Anthropic `message_stop`; Responses HTTP/WS `response.completed` or valid `response.incomplete`; Interactions `interaction.completed`/`interaction.finish`; Gemini complete HTTP JSON/array framing plus candidate finishes or terminal prompt-block feedback.
Images need each result's completed event and complete HTTP framing; finite speech/video downloads need complete HTTP framing and matching declared lengths. Realtime uses `response.done` per response, Live `turnComplete` per turn, and explicit close per session; packet EOF never ends a session. Count/compact/video-job/search and other buffered results use the validated full-body boundary above. Provider failure markers always produce `error`.
Egress alone decides deliverability. Internal metadata/heartbeat does not commit unless actually converted to client bytes; first emitted role/start/unknown-event bytes do commit.
Suppress transport keepalives and headers that would start a success response before that decision. Once deliverable bytes are scheduled to the client, disable failover even if the socket write fails.

### 3.7 Unknown fields, collisions and destination policy

Preserve unknown JSON members recursively, including array order, scalar type, null versus absence and unrecognized enums; retention is semantic, not original JSON whitespace.
Known Chat fields remain native; other fields live in `X.original` with source pointer/correlation. Do not duplicate known content in a whole-body shadow copy.
Unknown SSE events become `opaque` with source name, payload and SSE fields; valid non-JSON SSE data is a text value. Unsupported internal version is an error, not an unknown event.
A wire field named `x_ck` is untrusted source data: retain it in `original`, never interpret it as gateway control. Only the trusted internal boundary accepts this grammar.
If replay metadata is explicitly accepted by a client codec, validate its version and correlation; it cannot set trusted request IDs, routing attempts, resource limits or authorization.
Unknown fields and events always reach the egress encoder intact. That encoder writes them out where the destination grammar has a place for them (original location, native equivalent or defined extension carrier), and otherwise drops them with a content-free debug log naming field/event, destination and reason.
Known normalized mutations, including deletion, win over stale preserved values; never inject source-specific options into an unrelated provider's request root.
Mapped request semantics are distinct from unknown data: unsupported semantics in the §4 capability list produce 400 at the `request.end` fence before any upstream request is sent; unknown fields alone do not trigger rejection.
B7/B9 response projections occur inside the egress encoder after receipt: select choice 0 for single-choice destinations and drop unsupported grounding/code/URL-context events. Debug logs contain request ID, indexes/event kind and destination, never payload/signatures/tool arguments.

## 4. Internal request

The logical request is a Chat-based document plus `x_ck`, with typed content and structured historical tool input as specified below; it is a view over mmap positions, not a heap `Value` tree or buffered body.
`request.field` uses absolute JSON pointers into this document. Emit parent containers as empty objects/arrays before their child fields; arrays use consecutive numeric indexes.
The reference spelling is `{type: "x_ck_media", media_id: string, value_kind: "bytes"|"utf8"}`. Egress resolves only references registered by trusted ingress at the exact document position in this stream's own media table, never by JSON shape or client-supplied `X.media`; literal look-alike objects pass through as data.
Large strings use registered references with `mime: text/plain;charset=utf-8` and custom-data events; the logical value is concatenated decoded UTF-8. Encoders escape incrementally from positions after validation, not from a second accumulated body.
Routing may select model/operation/destination early, but no upstream request is sent before the whole internal request, including final fields and media, passes syntax/schema and destination capability validation at `request.end`. Authentication remains outside the document.
Capability validation covers supplied model/operation, roles and ordered content kinds, tool declarations/choice/call-result linkage, signed/encrypted replay, cache directives, sampling/token limits, output schema/modalities, session controls and mapped provider parameters. Unsupported members fail with 400; unknown unmapped fields follow §3.7. No unresolved field is exempt from the fence.

| Logical location | Type/content | Contract |
| --- | --- | --- |
| `model`, `messages[]` | Chat model, ordered roles/content | Preserve system/developer/user/assistant/tool distinctions and original order. |
| `messages[].content` | String or ordered `ContentPart[]` below | No guessed modality; native shape remains in provenance. |
| `messages[].tool_calls`, `tool_call_id`, `name` | History calls `{id, type, function: {name, arguments?: JSON}, arguments_format: "json"\|"text"}` and result linkage | JSON-format arguments are structured JSON; text-format arguments are strings. Trusted client ingress parses Chat argument strings; the upstream Chat egress encoder alone serializes JSON arguments to Chat's string slot. Non-Chat egress writes its native structured value; response deltas still use §3.3 strings. |
| `tools`, `tool_choice`, `parallel_tool_calls` | Chat function tool declarations/options | Native/custom/server tools additionally retain declarations in `X.tools`. |
| `temperature`, `top_p`, `max_tokens`, `max_completion_tokens`, `stop`, `n`, `seed` | Native Chat values | No presence-based field suppression or premature provider normalization. |
| `stream`, `stream_options`, `response_format`, `logprobs`, `top_logprobs` | Client delivery/output controls | Upstream stream selection is separate from client delivery preference. |
| Other native Chat fields | Bias/penalties, modalities/audio, prediction, store, metadata, user/safety identifiers, service tier, etc. | Preserve recursively; explicit fields do not make this an allowlist. |
| `X.v`, `X.original_protocol`, `X.operation` | Version 1; protocol; operation string | `generate`, `count_tokens`, `compact`, media action, realtime action, `alpha_search`. |
| `X.thinking` | `{enabled?, budget_tokens?, effort?, include?, native?: object}` | Keep both semantic controls and source-specific configuration. |
| `X.replay[]` | `{message_index, item_id, block_index, kind, signature?, redacted?, source}` | Bound history signatures/encrypted items, including signature-only parts; never move to another message. |
| `X.cache_control[]` | `{pointer, value}` | Exact breakpoints/TTL directives for messages, parts, system and tools; stable prompt ordering. |
| `X.tools[]` | `{pointer, declaration, namespace?, arguments_format?}` | Native declarations, tool search, custom tools and server-executed tools. |
| `X.provider_parameters` | Protocol-keyed object | Provider-native options without a Chat counterpart; consumed only by boundary codecs. |
| `X.original[]` | `{protocol, pointer, value}` | Every otherwise-unmapped original field; preserve semantic value, not the whole request bytes. |
| `X.session` | `{id?, turn?, previous_response_id?, previous_interaction_id?, environment_id?, mode?}` | Continuation identity; retained history is position-backed and subject to limits. |
| `X.media[]` | `{media_id, pointer, value_kind, mime?, attributes?}` | Projection of trusted per-stream reference registrations; untrusted wire values never populate the table. |
| `X.transport` | `{kind, action?, content_type?, query?, headers?}` | Only content type, multipart names/filenames and non-secret operation query/header values consumed by the codec; no Authorization/Cookie/credential values. |

`X` in this section is the request object's extension, not the per-record envelope; the envelope continues to identify its transport stream. `Q` in the schemas and mapping tables means this logical request, not the questions file.
`ContentPart` and `OperationValue` below are shared schemas in both directions; `?` permits absence, all other fields are mandatory. Strings/JSON may be position-backed; `MediaRef` means a trusted registered reference above. Unknown kinds use `opaque`, never a guessed semantic variant.

| `ContentPart.type` | Fields besides `type` |
| --- | --- |
| `text`, `reasoning`, `reasoning_summary`, `refusal` | `{text: string}`; replay signatures remain in `X.replay`. |
| `image`, `audio`, `video`, `document` | `{source: {kind: "uri", uri: string}\|{kind: "file", file_id: string}\|{kind: "data", ref: MediaRef}, mime?: string, filename?: string, detail?: "auto"\|"low"\|"high", timing?: {start: number, end?: number, unit: "seconds"\|"milliseconds"}, transcript?: string}` |
| `redacted`, `encrypted` | `{data: string, replay_index: uint}`; provider-bound, not readable text. |
| `tool_result` | `{tool_call_id: string, content: ContentPart[], is_error?: bool}` |
| `opaque` | `{protocol: string, value: JSON}`; genuinely unmapped content only. |

| `operation.kind` | `OperationValue` schema |
| --- | --- |
| `video.request` | `{action: "create"\|"edit"\|"extend"\|"retrieve"\|"content", job_id?: string}`; model/text/options/media in Q; ID mandatory except create. |
| `video.job` | `{job_id: string, status: "queued"\|"running"\|"completed"\|"failed"\|"cancelled"\|"expired", progress?: number, created_at?: number, completed_at?: number, error?: {code: string, message: string}}`; progress fraction 0–1, timestamps Unix seconds. |
| `alpha_search` | `{phase: "request", query: string, limit?: uint}\|{phase: "result", results: [{title?: string, uri?: string, text?: string}]}`; native extra fields use `X.original`. |
| `realtime.control` | `{action: "offer"\|"answer", sdp: MediaRef}\|{action: "session.configure"\|"session.created"\|"session.updated", config: RealtimeConfig}\|{action: "response.create"\|"response.append", request_id: string}\|{action: "response.cancel", response_id?: string}\|{action: "audio.commit"\|"audio.clear", track_id: string}\|{action: "session.close", reason?: string}` |
| `realtime.rates` | `{limits: [{name: string, remaining: number, limit?: number, reset_after_ms?: uint}]}` |

`RealtimeConfig = {model?: string, modalities?: ("text"|"audio"|"image"|"video")[], voice?: string, instructions?: string, tools?: Q.tools, tool_choice?: Q.tool_choice, input_audio?: AudioFormat, output_audio?: AudioFormat, turn_detection?: {mode: "disabled"|"server_vad"|"semantic_vad", threshold?: number, prefix_ms?: uint, silence_ms?: uint}}`; `AudioFormat = {codec: string, sample_rate_hz?: uint, channels?: uint}`. Omission preserves existing session settings; provider-only extras use `X.provider_parameters`.
Conversation items/tool results use Q history; audio append uses media events, whose packet attributes are `{track_id: string, packet_id: string, timestamp: uint, timebase_hz: uint, sequence?: uint, payload_type?: uint, flags?: string[]}`. Response controls reference a separately validated request; cancellation is not successful completion. Unknown sideband commands use `opaque`; mapped commands never do.
An ingress codec parses and stores preserved fields once; egress overlays normalized values. Removing a field removes its stale source projection too.
Signature replay is opaque and provider-bound; never fabricate a signature, substitute a validator-bypass token or silently discard an unsupported signed history block.
Wire capture, when enabled, occurs only at ingress/egress through the sanctioned redacting logging boundary, not by serializing internal events into logs (`crates/AGENTS.md:36-46`).

## 5. Field mappings

Tables below are normative: request tables cover client decode **and** upstream encode; response tables cover upstream decode **and** client encode, including buffered variants.
`Q` below means the logical request (not the questions file); `X` means its extension or an event envelope; `C` means a Chat chunk; `E(name)` means the registered named event.
Every unlisted field uses §3.7; no table is a discard allowlist. Reverse mappings restore native fields when present, synthesize only absent identities and obey destination capability policy.
For request destinations unable to express a supplied semantic field in §4's capability list, return 400 at its validation fence; responses apply §3.7 and B7/B9 rather than inventing data.

### 5.1 Anthropic Messages — request, both directions

| Wire fields | Internal location | Notes |
| --- | --- | --- |
| `model`, `stream`, `max_tokens`, `temperature`, `top_p`, `top_k`, `stop_sequences` | Q native options; `stop`; `X.provider_parameters.anthropic.top_k` | Preserve independent values; upstream encoder applies provider validation. |
| `system`, `messages[].role`, `content[].text` | Q messages and ordered text parts | String versus block-list shape retained in original metadata. |
| `thinking`, `output_config`, thinking block `thinking/signature`, `redacted_thinking.data` | `X.thinking`, `X.replay` | Preserve block association, effort/budget and opaque replay bytes. |
| `image/document.source`, URL/base64/file data, citation controls | Q content + `X.media`; `X.original` | MIME and document metadata survive; media uses data events. |
| `tool_use.{id,name,input}`, `tool_result.{tool_use_id,content,is_error}` | Q calls/results + `X.tools` | Structured JSON input becomes an argument string only at Chat encoding. |
| `tools`, `tool_choice`, `disable_parallel_tool_use`, server tools | Q tools/options + `X.tools` | Preserve server tool type, namespace and native schemas. |
| `cache_control`, `metadata`, `service_tier`, remaining fields | `X.cache_control`, Q metadata/tier, `X.original` | Keep TTL and cache boundaries on the exact source object. |

### 5.2 Anthropic Messages — response, both directions

| Wire fields/events | Internal location | Notes |
| --- | --- | --- |
| `message_start.message.{id,model,role}`, content block start/stop/index | `response.start`, item/block lifecycle, C role | Preserve source message ID and block order. |
| `text_delta.text`, `thinking_delta.thinking`, full text/thinking blocks | C content/reasoning + block kind | Full bodies decompose into the same events. |
| `signature_delta.signature`, thinking signature, redacted data | `reasoning.signature`, `reasoning.redacted` | Signature fragments end before their thinking block closes. |
| `tool_use`, `input_json_delta.partial_json`, `server_tool_use`, results | `tool.start`, C argument deltas, `tool.end`, `tool.result` | Forward arguments incrementally; preserve server-tool distinction. |
| `citations`, citation deltas, refusal/safety content | `annotation`, C refusal | Preserve citation offsets and source units. |
| `usage.input_tokens/output_tokens/cache_*`, `cache_creation.*` | `usage`; Chat projection | Inclusive normalization and TTL bucket rules in §3.5. |
| `message_delta.stop_reason/stop_sequence`, `message_stop`, `error`, `ping` | C finish + X native fields; `done`, `error`, `heartbeat` | Preserve stop sequence; message stop is not another finish delta. |

### 5.3 OpenAI Chat — request, both directions

| Wire fields | Internal location | Notes |
| --- | --- | --- |
| `model`, messages/roles/content, native sampling/limits/delivery fields | Same Q fields | All native fields retained, including nullable values. |
| Tools, legacy `functions/function_call`, tool history, tool choice | Q tools/calls + original spelling | Normalize call lifecycle without losing legacy declaration shape. |
| `reasoning_effort`, `reasoning`, signature extensions | `X.thinking`, bound `X.replay` | Native reasoning text remains a content property, not a signature. |
| `image_url`, `input_audio`, files, audio options/modalities | Q typed parts + `X.media`, Q audio/modalities | Decode embedded bytes incrementally; retain URLs as references. |
| Cache/provider/unknown extensions | `X.cache_control`, `X.provider_parameters`, `X.original` | Reserved-prefix collisions follow §3.7. |

### 5.4 OpenAI Chat — response, both directions

| Wire fields | Internal location | Notes |
| --- | --- | --- |
| `id/object/created/model/system_fingerprint/service_tier` | C base; source metadata | Buffered `chat.completion` decomposes into chunk events. |
| `choices[].index`, `delta` or `message`, role/content/refusal/reasoning | Same C fields + item/block lifecycle | Separate choice state; preserve empty strings versus absent fields. |
| Tool index/id/type/function name/arguments, custom-tool content | `tool.start`, C arguments, `tool.end` | A validated finish supplies tool end if Chat has no separate marker. |
| `choices[].logprobs`, content/refusal token arrays/top alternatives/bytes | C `choices[].logprobs` | No empty replacement arrays or dropped logprobs-only chunks. |
| Audio id/data/transcript/expiry; images/annotations | Media events, `annotation`, X original | Preserve source identity and timing; do not store media twice. |
| `usage.*`, `finish_reason`, native finish fields, `[DONE]`/errors | `usage`, C finish, X native reason, terminal event | Egress emits the destination terminal spelling once. |

### 5.5 OpenAI Responses HTTP — request, both directions

| Wire fields | Internal location | Notes |
| --- | --- | --- |
| `model`, `instructions`, input text/message/content/role | Q model/messages | Preserve developer/system distinctions and input ordering. |
| Input item id/type/status, function/custom calls, call_id, outputs | Q calls/results + `X.tools`, `X.original` | Item ID differs from call ID; custom tool text is not forced into JSON. |
| Reasoning summary/encrypted_content, `reasoning.effort/summary` | `X.replay`, `X.thinking` | Keep encrypted items intact, never synthesize empty encryption. |
| `tools`, tool_choice, parallel_tool_calls, built-in tools/tool search | Q tools + `X.tools` | Preserve namespace, format, schema and native tool configuration. |
| `max_output_tokens`, `text.format`, temperature/top_p, truncation/include | Q token limit/response_format; `X.provider_parameters.responses` | Keep native token-limit spelling in original metadata. |
| `previous_response_id`, conversation, store/background, metadata, service tier | `X.session`, Q store/metadata/tier, provider parameters | Continuation and persistence options are not silently discarded. |

### 5.6 OpenAI Responses HTTP — response, both directions

| Wire fields/events | Internal location | Notes |
| --- | --- | --- |
| response id/model/created_at/status; created/in_progress | `response.start`, X original | Retain source lifecycle status. |
| output_item added/done; id/type/status; output_index/sequence_number | Item lifecycle; `X.source` | Preserve source sequence alongside independent internal seq. |
| content_part and text/refusal delta/done; content_index/logprobs/annotations | Block lifecycle, C content/refusal/logprobs, `annotation` | Full done snapshots reconcile, not duplicate deltas. |
| Reasoning text/summary parts/index; encrypted_content | C reasoning + block kind, `reasoning.signature` | Summary/full reasoning and encryption stay distinct. |
| Function/custom arguments/input delta/done; call_id/name/namespace | Tool lifecycle + C arguments | Preserve item-call relation and text-vs-JSON format. |
| Image generation partial/result; audio/transcript; tool execution metadata | Media events, `tool.result`, `operation` | Preserve output identity and partial-result boundaries. |
| usage; completed/incomplete/failed; incomplete_details/error | `usage`, finish/native reason, `done` or `error` | A valid incomplete result may end successfully with a length/filter finish; failure is terminal error. |

### 5.7 OpenAI Responses WebSocket — request, both directions

| Wire fields | Internal location | Notes |
| --- | --- | --- |
| `type: response.create/response.append`, turn/request IDs | `X.transport.action`, `X.session` | Each turn gets a request ID; connection lifetime is separate. |
| `input`, model/instructions, previous_response_id, tools and all HTTP fields | §5.5 Q mappings | Resolve explicit continuation using position-backed session history; retain what was supplied versus inherited. |
| Cancel/close and other control messages | `operation` or `cancelled` | Known controls act at the boundary; unknown commands reach capability validation. |

### 5.8 OpenAI Responses WebSocket — response, both directions

| Wire fields | Internal location | Notes |
| --- | --- | --- |
| Response JSON events/type/sequence/item/usage | §5.6 events | Egress strips internal SSE framing, emits destination JSON messages. |
| Event IDs, connection/turn correlation, error/status | X source/session correlation; `error` | No new upstream attempt after a deliverable WS event. |
| Ping/pong/close | Boundary control; heartbeat/cancelled when semantic | Wire heartbeat is not a response completion or usage event. |

### 5.9 Gemini generateContent/streamGenerateContent — request, both directions

| Wire fields | Internal location | Notes |
| --- | --- | --- |
| URL model/action, `systemInstruction`, `contents[].role/parts` | Q model/messages; X operation | Preserve part order and source role spelling. |
| `text`, `thought`, `thoughtSignature`, signature-only parts | Q text/reasoning, `X.replay` | Never associate a signature with a different part. |
| `inlineData`, `fileData`, `videoMetadata`, audio transcription | Q typed parts/media references | Preserve MIME/URI/time offsets; data events carry bytes. |
| `functionCall.{id,name,args}`, `functionResponse` | Q calls/results, `X.tools` | Preserve provided IDs; whole call becomes one delta in response form. |
| generationConfig sampling/limits/candidateCount/response schema/modalities | Q native options and response_format; provider parameters | Include audio, not only text/image. |
| thinkingConfig, cachedContent, tools/toolConfig, safetySettings, labels | `X.thinking`, cache/provider parameters, Q tools | No invented cache entry or safety policy. |

### 5.10 Gemini generateContent/streamGenerateContent — response, both directions

| Wire fields | Internal location | Notes |
| --- | --- | --- |
| responseId/modelVersion/createTime; candidates[].index/content.role | C base/choice/role + X source | Preserve timestamp precision and candidate index. |
| Parts text/thought/signature, including several text parts per candidate | Ordered blocks/C deltas/signature events | Never overwrite earlier text with a later part. |
| functionCall/functionResponse; inlineData/fileData/audioTranscription | Tool lifecycle/results; media/transcript | Same MIME/timing contract for buffered and streamed bodies. |
| groundingMetadata/citationMetadata, executableCode/codeExecutionResult, urlContextMetadata | Grounding/annotation/code_execution/url_context | Source-scoped named events; B9 at unsupported egress only. |
| safetyRatings/promptFeedback, finishReason/finishMessage | Annotation, C finish + native reason | Finish is independent of whether usage is present in that source chunk. |
| usageMetadata prompt/candidates/thoughts/cache/total and modality details | `usage` snapshot | Preserve zero, missing counts and native breakdowns. |

### 5.11 Interactions — request, both directions

| Wire fields | Internal location | Notes |
| --- | --- | --- |
| model or agent, input text/messages/steps/content, system instruction | Q model/messages; `X.provider_parameters.interactions.agent` | Preserve agent semantics rather than treating agent ID as an ordinary model. |
| Function call/result steps, tools, tool choice, agent_config | Q calls/results/tools + X tools/provider parameters | Preserve step IDs and native declarations. |
| generation_config, thinking configuration, stream/store/background | Q sampling/delivery fields; X thinking/provider parameters | Retain native configuration fields. |
| previous_interaction_id, environment_id/environment, metadata, other fields | X session/Q metadata/X original | Same-protocol egress restores all retained fields. |

### 5.12 Interactions — response, both directions

| Wire fields/events | Internal location | Notes |
| --- | --- | --- |
| interaction.created id/model/status/environment; event_type | Response start; X source | Preserve environment/interaction identity. |
| step.start/delta/stop, index/id/type/content | Item/block lifecycle; C text/reasoning; opaque for unknown kinds | Preserve non-function step starts/stops as well as content. |
| function_call name/call_id/arguments, arguments_delta, function results | Tool lifecycle/C arguments/tool.result | Whole and incremental calls share one state machine. |
| Media, citations, thought signatures, native execution/context metadata | Media/signature/annotation/named events | No text-only projection inside the router. |
| interaction.usage/metadata usage variants; completed/finish/failed | Usage snapshot; choice finish; done/error | Alias spelling stays in native provenance; no duplicate totals. |

### 5.13 Legacy completions — request, both directions

| Wire fields | Internal location | Notes |
| --- | --- | --- |
| prompt string, string array, token array/batch; suffix | Q user content when textual; `X.provider_parameters.completions` otherwise | Preserve input form and batch boundaries; do not stringify token arrays. |
| model/max_tokens/temperature/top_p/stop/n/seed/penalties/stream/user | Q native fields | No fixed prompt fallback for an explicitly empty prompt. |
| numeric logprobs, echo, best_of, remaining options | X provider parameters; mapped Q logprob control | Keep requested numeric depth, not just truthiness. |

### 5.14 Legacy completions — response, both directions

| Wire fields | Internal location | Notes |
| --- | --- | --- |
| id/object/created/model, choices index/text/finish_reason | C base/content/finish | Keep all choice indexes and prompt/batch correlation in source metadata. |
| logprobs tokens/token_logprobs/top_logprobs/text_offset | C choice logprobs + X span/source | Retain legacy offset units and logprobs-only output. |
| usage, unknown fields, `[DONE]`, error | Usage/X original/terminal events | Native completion shape reconstructed at egress. |

### 5.15 count_tokens — request, both directions

| Wire fields | Internal location | Notes |
| --- | --- | --- |
| Anthropic model/messages/system/tools/thinking/cache controls | §5.1 Q; `X.operation: count_tokens` | Count the same semantic input as generation; no fake generation. |
| Gemini URL model, contents or generateContentRequest, tools/config | §5.9 Q; X original wrapper | Preserve wrapper and count-specific fields. |

### 5.16 count_tokens — response, both directions

| Wire fields | Internal location | Notes |
| --- | --- | --- |
| Anthropic input_tokens; Gemini totalTokens/cachedContentTokenCount/details | `count_tokens` plus native original | Distinguish count result from usage; retain modality/cache detail. |
| Errors or unsupported provider operation | `error` | Never synthesize a zero count as success. |

### 5.17 compact — request, both directions

| Wire fields | Internal location | Notes |
| --- | --- | --- |
| Responses model/input/instructions/previous state and options | §5.5 Q; `X.operation: compact` | Same preserved item/signature history as generation. |
| stream flag | Q delivery control | Client compact remains non-streaming; stream=true is rejected. |

### 5.18 compact — response, both directions

| Wire fields | Internal location | Notes |
| --- | --- | --- |
| id/object/created_at/model/output[] including compaction/encrypted items | Response start + ordered `compact` events | Preserve opaque items and item IDs, not a text summary substitute. |
| usage, metadata, status/error | Usage, X original, terminal | Aggregate the compact response only at egress. |

### 5.19 Images — request, both directions

| Wire fields | Internal location | Notes |
| --- | --- | --- |
| model/prompt/n/size/quality/style/background/output format/compression/moderation | Q model/text/n; `X.provider_parameters.images` | Preserve native controls and requested result format. |
| image/images/mask/reference images; multipart field names/filenames/content types | X media references + data events | Multipart decoding is incremental; preserve part order, not boundary bytes. |
| stream/partial_images/response_format/user and unknown fields | Q delivery; provider parameters/original | A single finished result still uses the same internal stream. |

### 5.20 Images — response, both directions

| Wire fields | Internal location | Notes |
| --- | --- | --- |
| created/data[]/url/b64_json/mime_type/output_format | Response/item/media lifecycle; data or URI reference | Preserve image index and actual MIME; no MIME inferred from field name alone. |
| revised_prompt, dimensions/quality/background, partial/completed event fields | Media attributes/X original/operation | Retain created time and revised prompt in emulated and native streams. |
| usage/errors | Usage/terminal | Duplicate per-image source usage snapshots are not additive. |

### 5.21 Audio/speech — request, both directions

| Wire fields | Internal location | Notes |
| --- | --- | --- |
| model, input/text, voice/voice_id, language, speed, instructions | Q model/text; `X.provider_parameters.audio` | Preserve instructions and original voice independently of provider voice mapping. |
| response_format/output_format codec/sample_rate, stream options | Q delivery; X media attributes/provider parameters | Audio input files use the same multipart/media mapping when an operation supports them. |

### 5.22 Audio/speech — response, both directions

| Wire fields | Internal location | Notes |
| --- | --- | --- |
| Raw audio body/content type, JSON audio/base64, codec/rate/channels | Media lifecycle + data events | Egress writes raw audio incrementally; non-JSON bytes do not undergo UTF-8 validation. |
| Transcript, timestamps, segment/word timing, audio IDs/expiry | Transcript/media attributes/X original | Keep units and audio-text association. |
| Usage/error/EOF | Usage/terminal | HTTP success plus complete body supplies media end; truncated body is error. |

### 5.23 Video — request, both directions

| Wire fields | Internal location | Notes |
| --- | --- | --- |
| Create/edit/extend/retrieve/content action, request_id/video_id | `operation(kind: video.request)`; X session | §4 schema preserves job identity; credential affinity stays outside payloads. |
| model/prompt/seconds/duration/size/aspect_ratio/resolution | Q model/text; `X.provider_parameters.video` | Keep original units/options even when upstream naming differs. |
| Input image/video/references, multipart fields, download metadata | Media references/data, X transport | No separate media bypass; downloads are internal data streams too. |

### 5.24 Video — response, both directions

| Wire fields | Internal location | Notes |
| --- | --- | --- |
| request_id/id, job status/progress/timestamps/error, model/prompt/options | `operation(kind: video.job)`; X native/original | Preserve cancelled/expired versus failed even if egress collapses status. |
| video.url/duration/content MIME, completed file bytes | Media references/lifecycle/data | A job response done means that HTTP operation completed, not that the video finished. |

### 5.25 Realtime/Live — request, both directions

| Wire fields | Internal location | Notes |
| --- | --- | --- |
| SDP offer, session config/model/modalities/voice/tools, call/session IDs | X session; `operation(kind: realtime.control)` | §4 offer/config schema; SDP is registered UTF-8 media with MIME, credentials stay outside. |
| Conversation items, response.create/cancel, tool calls/results | Q history/tools; §4 response controls | Per-turn validation and lifecycle are distinct from session lifecycle. |
| WS input audio append/commit/clear, binary messages; WebRTC media packets | Media/data; §4 audio controls and packet attributes | Preserve track, timestamp, sequence, payload type and packet/message boundaries. |
| Hangup/sideband commands/unknown event types | §4 session.close; `opaque` for unmapped commands | End all owned directions on close; no silent tunnel fallback. |

### 5.26 Realtime/Live — response, both directions

| Wire fields | Internal location | Notes |
| --- | --- | --- |
| SDP answer, session created/updated, call/response/item IDs | §4 answer/session controls; X source/session | Transport negotiation remains outside internal stages. |
| Text/audio/transcript/tool events, audio deltas, media packets | C deltas/tool lifecycle/media events | Both directions use the same chunk ceiling and collection timer. |
| Usage/rate limits, errors, response.done/session close | Usage/`realtime.rates`/terminal per response or session | §4 rates schema; response.done does not close a live connection. |

All accepted realtime media MUST traverse codecs; WebRTC ingress/egress terminate media transport and re-encode packet data through the internal stream rather than negotiate a direct bypass.
WebRTC media conversion applies only when the existing `media-relay` build feature is built (`crates/ck-server/src/realtime/relay.rs:1-7`); this spec adds no dependency. Builds without it reject WebRTC media visibly; feature-enabled builds must use the relay, never accept a direct media bypass.
Alpha-search requests/results use the §4 `alpha_search` schema and X original; AI Studio inference uses the Gemini codec with relay correlation. These are not exemptions.
Current alpha search bypasses translation (`crates/ck-server/src/codex_alpha.rs:4-6`); the browser relay registers an executor-side session (`crates/ck-server/src/relay.rs:4-11`).

### 5.27 Today's loss ledger

These are source-verified transformations at the cited baseline, not claims that every route/provider loses the field. `New` means not mentioned in the supplied PIPELINE-SURVEY.md.

| ID | Current path and loss | Evidence | Survey |
| --- | --- | --- | --- |
| L01 | Claude→Chat ignores signature deltas, redacted/server-tool block starts and unsupported delta kinds. | `crates/ck-translate/src/claude_chat_response.rs:133-162` | Mentioned; now verified |
| L02 | Claude→Chat keeps aggregate cache counts but not TTL buckets; default numeric state also erases missing-versus-zero distinctions. | `crates/ck-translate/src/claude_chat_response.rs:13-49`; bucket-aware accounting: `crates/ck-server/src/usage_record.rs:551-558` | Aggregate loss mentioned |
| L03 | Claude→Chat withholds tool argument fragments until block stop and invents `{}` for empty accumulated arguments. | `crates/ck-translate/src/claude_chat_response.rs:152-183` | Buffering mentioned |
| L04 | Gemini→Chat drops thought signatures, including signature-only parts, and labels inline audio/media as image_url objects. | `crates/ck-translate/src/gemini_chat_response.rs:85-103,170-220` | Mentioned |
| L05 | Gemini→Chat only projects selected candidate parts/finish fields; grounding, URL context, code and safety metadata have no projection there. | `crates/ck-translate/src/gemini_chat_response.rs:150-236` | Mentioned/unverified in survey |
| L06 | Responses→Chat drops non-tool item starts and most non-tool completion metadata (message completions retain citations); Chat→Responses synthesizes item identity and empty encrypted content/logprobs. | `crates/ck-translate/src/codex_chat_response.rs:353-368,408-426`; `crates/ck-translate/src/openai_responses_response.rs:187-203,274-280,680-695` | Identity mentioned; review details additional |
| L07 | Chat→Claude selects array element choices.0 for delta and finish, losing other choices rather than selecting by index. | `crates/ck-translate/src/openai_claude_response.rs:366,435` | Mentioned |
| L08 | Gemini→Chat streaming overwrites earlier text/thinking parts of the same kind within one candidate; buffered conversion concatenates instead. | `crates/ck-translate/src/gemini_chat_response.rs:167-186,267-274` | New |
| L09 | Gemini→Chat streaming emits a remembered finish reason only when a candidate chunk also has usage; a finishing candidate without usage can lose its finish projection. | `crates/ck-translate/src/gemini_chat_response.rs:135-143,224-235` | New |
| L10 | Chat→Gemini request filters response modalities to text/image; an audio modality is omitted. | `crates/ck-translate/src/gemini_chat_request.rs:139-152` | New |
| L11 | Claude→Chat request emits top_p only when temperature is absent, dropping top_p when both are supplied. | `crates/ck-translate/src/openai_claude.rs:50-55` | New |
| L12 | Legacy request reconstruction omits n, best_of, suffix, seed and user; numeric logprobs becomes a boolean; empty prompt becomes “Complete this:”. | `crates/ck-server/src/openai.rs:270-306` | New |
| L13 | Legacy streamed output drops a logprobs-only chunk without content, finish reason or usage. | `crates/ck-server/src/openai.rs:348-359` | New |
| L14 | Interactions→Chat ignores non-function step starts and step.stop; unrecognized delta kinds retain only nonempty text, losing structured payloads. | `crates/ck-translate/src/openai_interactions_response.rs:185-244,302-323` | New |
| L15 | Emulated xAI image completed events omit created and revised_prompt even though extraction retains both and buffered output includes them. | `crates/ck-server/src/images.rs:378-393,437-481` | New |
| L16 | Speech's xAI request builder reconstructs language/output_format/speed/text/voice_id only; supplied instructions are not forwarded. | `crates/ck-server/src/speech.rs:184-233` | New |
| L17 | Video status projection collapses expired/cancelled/canceled into failed without retaining the native status in the constructed response. | `crates/ck-server/src/videos.rs:441-449,463-483,555-597` | New |
| L18 | Realtime declares live usage logging unported; the S0 usage path must not inherit that omission. | `crates/ck-server/src/realtime.rs:24-26` | New |

Existing direct Claude→Responses carriage of redacted thinking must survive even though the Chat projection loses it (`crates/ck-translate/src/claude_responses_response.rs:167-175`).
Current compact rejects stream=true (`crates/ck-server/src/openai.rs:1064-1079`); S0 retains that operation contract, not a raw-body shortcut.

## 6. Storage

### 6.1 Pool, frames and ownership

Owner ruling (G3, 2026-11-14): each process keeps one preallocated mmap pool file that holds all stream bytes in 50,000-byte frames (§2). Fixed frames and position-based access are interoperability requirements. Frame `i` starts at `header + i × 50,000`; only the mapping is page-aligned, so frames need not be.
The measured design, from the S0 storage benchmark (§9.3):

- **Header, committed length and growth.** Two lengths exist and must not be confused. The pool file header records the backed size, the bytes backed by `fallocate`; only growth changes it. Each stream owns a header slot in the pool, 128-byte aligned and indexed by stream handle, that records the stream's committed end position and publication generation. This is the owner's G3 answer (the header records the committed length; readers learn a new length from the header), applied per stream because one pool holds many streams. The writer stores the committed end with Release ordering after the bytes and table entries are written, readers load it with Acquire, and every store is followed by a reader wake (§6.2). The slot count and layout are an **S1 choice**. The pool is preallocated to an initial size and grows by `fallocate` when no free frame is left and the limit in §6.4 allows. Check the `fallocate` result and return its error (G7). Never grow with `ftruncate` alone: it leaves sparse pages, and when tmpfs runs out the page fault raises SIGBUS instead of returning ENOSPC (measured on a 64 MiB tmpfs: `fallocate` returned ENOSPC cleanly, `ftruncate` killed the process). **S1 choice:** the initial size and the growth step are open, and the mapping covers the whole limit once so growth never moves it. The S0 benchmark measured growth stalls only on per-request files (1 MiB extents stalled at most 0.33 ms); the pool's own growth stall is unmeasured.
- **Free lists.** Each thread has its own LIFO list of free frames, with the locks at least 128 bytes apart so two lists never share a cache line. A thread takes frames from its own list first, then steals resident frames from another thread's list, and only then takes a cold frame (§6.5), which it prefaults with one `MADV_POPULATE_WRITE`. Do not use one shared FIFO list: it measured -94% req/s against heap on 2 KiB requests at 64 tasks (644,185 against 10,719,382 req/s), because every request contends on one lock and touches a cold frame.
- **Shared counters.** Every object that each request updates (the pool budget, the stream-table owner and their reference counts) is aligned to 128 bytes. Without it, false sharing doubled cycles per request at 64 tasks (27-33k against 12-13k) with the same instruction count.
- **Why a pool.** One mmap file per request cost -94% req/s on 2 KiB requests sequentially and -99% at 64 tasks, because `mmap`, `MADV_POPULATE_WRITE` and `munmap` serialise on the process's mmap lock and `munmap` sends TLB-shootdown IPIs to every CPU running the process. The pool needs no `mmap` or `munmap` on the request path and matches or beats heap in every measured row except one that is still open (§9.3).
- **Reader pinning.** A frame in use by a reader is never reused or reclaimed. A frame joins a free list only after its last lease and retention reference release it, and the reclaimer touches only frames already on a free list.

A `Position` is `(frame_number, offset)` scoped by a stream handle/generation; `offset` is in `[0, 50000)`. Frame numbers do not wrap/reuse within a stream. Each stream has a frame table of integer pool-frame indexes, like a page table, plus generation/ownership and committed extents. This is per-block state, not retained raw pointers; resolve temporary borrowed slices only under a read lease.
Request/response directions of one exchange share its stream quota; reclaiming another exchange cannot raise this quota. Duplex sessions retain separate turn quotas, with shared session replay charged to the pool/cache and its retaining exchange until released.
Stages hold only start/current/end positions for byte access; retention positions are such positions. Identity indexes and bounded scalar counters are metadata; identity strings and variable metadata remain position-backed.
No `Vec<Bytes>`, body-sized String, JSON tree, tool-argument accumulator or media queue may store stream content on the heap.
Network/TLS library scratch is not a second stream store: consume it immediately into mapped storage, bound it by transport settings and include it in measurements.
Codecs scan borrowed mapped spans and write encoding output into mapped frames; string escaping/base64 and cross-block tokens are incremental, never assembled into a heap event.
Request records, normalized events, boundary framing scratch, unknown payloads, replacement records and aggregation output all charge their actual live mapped frames to stream and pool limits.
General records may span frames; readers parse across positions. A text SSE event larger than a frame occupies consecutive frames, addressed as (frame, offset). Custom-data records start at a fresh frame boundary and fit one frame; unused tail space is padding, not stream bytes.
A separate event index stores only start/end positions and type/correlation indexes; retained index metadata has a configured ceiling too.

### 6.2 Writer/reader publication
**S1 choice:** a stream metadata lock implements the publication/lease protocol below; one synchronization mechanism makes complete-prefix visibility and safe reuse explicit. Those invariants, not the lock mechanism, are interoperability requirements.

| Actor/step | Required operation |
| --- | --- |
| Writer admission | One writer per stream; reserve every needed frame/table entry under allocator ownership before writing it. |
| Append | Write only unpublished mapped bytes; published event bytes are immutable. Finish JSON and SSE delimiter before publishing the event. |
| Publish | Under the stream metadata lock, install frame-table extents/event boundaries and advance the stream's committed end position (header slot, Release store) plus monotonic publication generation. |
| Wake | Notify readers after unlocking. Publication uses the lock's release/acquire ordering; mmap visibility alone is not synchronization. |
| Read | Register a read lease under the same lock and set the stream's last-read time from a monotonic clock; copy only table/cursor metadata, then read immutable bytes no later than the committed end. |
| Wait | Register notification before rechecking generation/end/terminal state under the lock; sleep only if unchanged, avoiding lost wakeups. |
| Acknowledge | Advance the consumer cursor, refresh the stream's last-read time and release the lease. Request-direction and scratch ranges also advance their aggregation positions and return to the releasing thread's free list when no lease or retention reference remains (§6.1). A response stream's frames stay in the cache queue (§6.4) and become free only after expiry or eviction and the last lease release. |
| Transform | A stage that rewrites an event writes replacement records into fresh mapped spans; publish downstream sequence/correlation atomically, never mutate bytes another reader sees. |
| Fail/cancel | Upstream error, explicit client cancel or shutdown: set the terminal error/cancellation state, publish the terminal record after the published prefix when space permits and wake all readers. The prefix stays readable, so a resuming reader (§6.6) receives it and then the terminal event. A client disconnect is neither. |
| Invalidate | Expiry or eviction (§6.4): atomically invalidate the stream's data, set the terminal state to `error` `stream.gone` (status 410, scope `resource`) and wake all readers; publish that record when space permits. Every attached reader, including one holding a lease, receives that one `error` event then end-of-stream, not the invalidated backlog. If upstream is still being collected, cancel it now. Successful `done` instead follows the complete published prefix. |
| Recycle | Reuse a frame only after all reader leases and retained references release it; generation checks reject stale handles. |

Committed end covers complete records only; it is the stream's header-slot position (§6.1), loaded with Acquire. A reader may observe the old complete prefix or the new complete prefix, never half JSON, stale reused content or an uninitialized frame-table entry.
The pool file header's backed size (§6.1) bounds where frames may exist; it is never a stream's committed end. There is no polling of file size and no per-event msync/fsync durability promise.
Terminal control state stores a bounded error code, not a heap data fallback; readers synthesize the error event from it when no frame remains. Egress emits a bounded destination error or aborts transport if that is impossible; never report successful completion.

### 6.3 Lifecycle, directory and permissions

Create the private directory before the pool, mode 0700, owned by the process user; reject an unsafe/symlinked location rather than using a public temporary directory.
Default directory is `$XDG_RUNTIME_DIR/cook-router/` (G2); deployment must provide it on tmpfs or explicitly configure another private directory. Missing XDG_RUNTIME_DIR requires explicit configuration, not a silent fallback.
Unlink the pool file immediately where possible (G4): use O_TMPFILE with mode 0600, or create exclusively with mode 0600 and unlink before accepting stream data. Where neither works, keep the path until the pool closes at shutdown, then delete it. There is no startup sweep (G5).
The pool descriptor/mapping lives for the process; a stream's table and frames are removed by expiry or eviction (§6.4) once the last consumer releases them, not the shared pool inode.
On disconnect, release only that reader's lease and connection state; the stream is neither cancelled nor released (§6.6). A reader that never releases retains its frames (§6.4). Shutdown stops work before unmapping; process death closes the unlinked inode after its last reference, with no startup sweep.
The application adds no encryption (G6); protection comes from OS disk and memory encryption, the 0600 file and the 0700 directory. tmpfs is not free memory and may swap; disk-backed mappings may persist physical remnants after unlink. Permissions/unlink are not secure erasure.
Never expose the pool FD, filesystem path or other streams' frames to a client. Do not mix transient stream storage with the durable configuration database.

### 6.4 Limits and the cache queue

Two structures hold frames. The free lists (§6.1) hold unused frames for allocation. The cache queue below holds every stream's retained frames in order of last read and decides which stream is invalidated after expiry or under size pressure. A frame moves from the queue to a free list only after its last lease and retention reference release it.
Owner ruling (G8, Settled 41, 2026-11-14): 「我记得这个 sse 缓存队列是1h加最大256MB总容量最大4G设计的，我们直接存进去就可以，不需要单独算别的缓存了，使用最近读取就不清理，最老没有读取就清理的方式滚动刷新缓存（和1h清理超时缓存）」. Applied:

- **One queue.** Every stream byte goes into the cache queue. There is no separate unread buffer, retained-backlog or replay accounting. Delivery does not release a response stream's bytes: the gateway cannot know how far a client got, and a reconnecting client resumes from any position it did not receive (§6.6). Request-direction and scratch ranges, which no client resumes, are released as in §7 and count against the same limits while they live.
- **Limits.** At most 256 MiB per stream and at most 4 GiB in total. The owner wrote MB and GB; this spec states every capacity in MiB and GiB (§3.4 defines KiB), so 256 MiB is 268,435,456 bytes, ⌊268,435,456 / 50,000⌋ = 5,368 frames (268,400,000 bytes), and 4 GiB is 85,899 frames. An owner may correct the unit to decimal. The 4 GiB is the owner's maximum; the startup caps in `stream.pool_bytes` only lower it.
- **Least recent read.** The entry is a stream's retained range and is evicted whole. A lease registration or a delivered advance sets the stream's last-read time. A stream that was never read counts from its creation. A recently read stream stays; under size pressure the stream with the oldest last read goes first, so the cache refreshes on a rolling basis.
- **1 h expiry.** A stream whose last read is older than 1 h expires. The owner's 「1h」 does not say from when; the applied reading is 1 h since the last read, consistent with 「最近读取就不清理」.

| Configuration knob | Default and unit/scope | Accounting/rationale |
| --- | --- | --- |
| `stream.pool_directory` | `$XDG_RUNTIME_DIR/cook-router/`, directory/process | Private tmpfs location (§6.3); no fallback when XDG is absent. |
| `stream.pool_bytes` | min(4 GiB, 50% of the tmpfs size from `statvfs` at start, cgroup `memory.max` less heap headroom), rounded down to a frame multiple; log the derived value | Bounds mapped storage and holds the whole cache queue. 4 GiB is the owner's maximum; the tmpfs and cgroup terms are startup caps below it. Tmpfs is usually 10% of RAM under logind, so the tmpfs term is often the effective limit; a service may have no `XDG_RUNTIME_DIR`. Ignore the cgroup term when `memory.max` is `max`. The heap headroom size is an S1 choice. |
| `stream.max_frames` | min(5,368, `pool_frames`) frames, where 5,368 = ⌊256 MiB / 50,000⌋ and `pool_frames` = `pool_bytes` / 50,000 (85,899 at the 4 GiB ceiling) | Request/response/scratch/replay of one exchange combined; a ceiling, not a reservation. At the 4 GiB ceiling at most 16 full-size streams fit (16 × 5,368 = 85,888 frames). |
| `stream.max_event_bytes` | 1 MiB/event | Ordinary framed event including extensions; bound parser work, chunk large content/media instead. |
| `stream.max_metadata_bytes` | 1 MiB/exchange | Tables/indexes/parser/consumer bookkeeping; bound tiny-event amplification. |
| `stream.cache_ttl` | 1 h since the stream's last read | Owner number (Settled 41). |

The unset knobs (event and metadata sizes, initial pool size, growth step, headroom) use provisional S1 defaults, **unmeasured, replace after the §9 benchmarks**. The server starts if directory/mapping and the validation below succeed; configured overrides remain supported.
Owner ruling (D2, 2026-11-14): a slow consumer never pauses upstream reads. The stream keeps collecting into the cache queue and the gateway relays at the client's pace. Only `max_frames` and the pool bound that backlog, and it expires and is evicted like every other entry.
Startup rejects zero capacities or ttl, a `pool_bytes` that is not a frame multiple, `max_frames < 4`, `max_frames > pool_frames`, or `max_event_bytes > max_frames * 50000`. Metadata must hold the configured frame table plus one event index and reader entry; validate against actual entry sizes with checked arithmetic.
1. Keep every stream's retained frames in last-read order; a read moves the stream to the recent end. Bytes arriving for a stream nobody reads do not refresh it. Physical reuse always waits for the last lease. Upstream reads never pause for a slow consumer (D2); every arriving byte and timer flush consumes quota.
2. Expiry: when a stream's last read is older than `cache_ttl`, invalidate it (§6.2). Upstream collection runs to its terminal event until this point; if it is still running, cancel it now (§6.6). Drop retention references; leased frames stay immutable and charged until their last lease releases. A periodic check (S1 choice) finds expired streams from the old end of the queue.
3. Per-stream limit: an allocation that would pass `max_frames` fails that stream with `error` `stream.storage_exhausted` (G7); evicting other streams cannot help. The prefix and the error stay resumable until the stream expires.
4. Size pressure: when no free frame exists and `pool_bytes` cannot grow, invalidate streams from the old end of the queue, never the allocating stream, until enough unleased frames are free. A stream still being produced ends with `stream.gone` via §6.2 (Invalidate) and its upstream is cancelled; a finished stream is removed. Readers with a lease see the terminal error then end-of-stream. Never skip live bytes and continue a stream. Logical removal is not physical reclamation: leased frames stay immutable and charged until their last lease releases.
5. Retry the pending reservation only against actually free capacity, including growth by `fallocate` under `pool_bytes`. Owner ruling (G7): if stream, pool or metadata limits still prevent it, or `fallocate` returns ENOSPC, return an error and fail the allocating stream visibly with `error` `stream.storage_exhausted`; no heap fallback, no indefinite wait, provider failover, spill or degradation. A reader that never releases keeps its frames indefinitely; once the pool runs out, new allocations fail visibly too.

Full-snapshot egress pins its source range and can exhaust its stream quota. Allocation/mapping/file failures return 503 before commitment when possible; after commitment emit an error or close abnormally. OS mmap faults/OOM may kill the process: no guaranteed in-band error, signal-recovery subsystem or alternate pool.

### 6.5 Reclaim and memory accounting

An idle pool must give tmpfs pages back. The S0 benchmark measured four ways to punch holes (`FALLOC_FL_PUNCH_HOLE`); only decay reclaim kept the request path at heap parity:

| Reclaim | Result against heap |
| --- | --- |
| None | Parity, but the pool keeps its high-water mark (641 MiB stayed after ten 64 MiB streams ended). |
| Eager, on every free | -97% req/s at 64 tasks: each punch zaps PTEs in a shared mapping and sends TLB-shootdown IPIs to every CPU running the process. |
| Watermark, inside the free path | +132% (256 streams) and +408% (1024 streams) wall time. |
| **Decay, background tick** | Parity or faster in every row except one that is still open (§9.3); tmpfs fell from 641 to 1 MiB about one second after the streams ended. |

Decay is the rule. A background tick runs once per second and punches the frames that stayed idle on a free list for the whole interval. It keeps 8 free frames per free list and coalesces neighbouring free frames into one call. The request path never punches. The tick holds the cold-list lock across the punch; without it, frames in flight sit on no list and a stream that fills the pool fails early. A thread taking a punched frame prefaults it (§6.1), which removed a +16% TTFB p99 regression with four readers.
Since 50,000 is not page-aligned, only whole pages inside a run of free frames are punched. An isolated frame keeps up to one partial page at each edge, so the residue grows with the page size: 8 KiB with 4 KiB pages, the page size of the S0 host; hosts with 16 or 64 KiB pages (some arm64 kernels) are unmeasured. The measured residue after decay on that host was 1-2 MiB. Record the page size with every memory result (§9.2). Each tick still sends TLB-shootdown IPIs to the CPUs running the process; the cost on hosts with many more busy threads is unmeasured.
Accounting: mapped tmpfs pages count as `RssShmem` inside `VmRSS`, as `shmem` in the cgroup's `memory.stat` and `memory.current`, and in `statvfs` on the tmpfs. They do not appear as `RssFile`. Monitoring and memory limits must read these, not `RssAnon` alone; a full pool puts `VmRSS` at about `pool_bytes`.

### 6.6 Client disconnect and resume

Owner ruling (Settled 42, 2026-11-14): 「我们必须需要考虑，客户端可能暂时断开然后连接上后下一次继续读取的问题，所以一定不能清理」. Behaviour below is mandatory; only the mechanism marked **S1 choice** is open.

- **Disconnect does nothing to the stream.** It closes the connection and releases that reader's lease. It does not cancel upstream, publish `cancelled`, invalidate the stream or free a frame. Collection continues until the upstream terminal event, or until the stream expires or is evicted (§6.4), whichever comes first; every byte stays in the cache queue meanwhile.
- **What removes a stream.** Only the 1 h no-read expiry and least-recent-read eviction (§6.4).
- **What still cancels upstream.** A client's explicit cancel control where the protocol has one (`client_cancel`: the `response.cancel` and close controls in §4 and §5.7), `shutdown`, expiry or eviction while upstream is still running (readers receive `error` `stream.gone`, not `cancelled`; §6.2), the per-stream limit and the other G7 limit errors, and an upstream error. A non-streaming client request is a client stream too: its upstream call also runs to the end after a disconnect, and its bytes stay cached.
- **Resume.** The client presents a stream id and a position. **S1 choice:** the mechanism, for example SSE `id:` lines (equal to `X.seq`, §3.1) with a `Last-Event-ID` header and a stream id the client learned from the response, or a protocol-specific equivalent such as the Responses `response.id` with a sequence number. The egress codec maps the presented position to an internal `seq`, and the event index resolves `seq` to a `Position` (§6.1).
- **Resumed delivery.** A new reader attaches without a new routing attempt. It receives every retained record after the presented position in order, with no gap and no repeat, then follows the stream live while upstream is still being collected, or ends with the stored terminal record (`done`, `error` or `cancelled`) when it is finished. Resume neither fails over nor restarts the request.
- **Authorization.** The stream id is unguessable and a resume is accepted only for the identity that created the stream. Any other identity receives the same error as an absent stream.
- **Failure is visible.** A stream that has expired, was evicted, never existed or belongs to another identity fails the resume with `error` code `stream.gone`, status 410, scope `resource`. The gateway never answers with an empty success and never restarts the content from the beginning. A reader attached when its stream expires or is evicted receives the same `error` as one event (§6.2). A position beyond the committed end is a client 400.
- **Readers pin frames.** Eviction or expiry of a stream with an active reader never overwrites leased frames (§6.1, §6.4).

## 7. Bounds and flow

| Boundary/state | Contract |
| --- | --- |
| Ordinary event exceeds limit | Client 413 for oversized input; upstream error for oversized output; never silently truncate. |
| Invalid textual UTF-8/JSON | Client 400; upstream terminal error; no replacement-character repair or raw passthrough. Binary media remains valid arbitrary bytes. |
| Partial input record | Hold only mapped spans up to event/stream limits; timer-flush custom data; ordinary incomplete JSON is not published. |
| Slow consumer | Keep reading upstream into the cache queue (D2); buffered bytes stay charged and follow the 1 h no-read expiry and least-recent-read eviction like any entry; the per-stream limit fails the stream visibly; never an unbounded queue. |
| Stream frame/cache limit | Apply §6.4: the per-stream limit fails that stream visibly; pool pressure evicts the stream read least recently and the 1 h expiry removes idle ones, each ending attached readers with `error` `stream.gone`; no resource-exhaustion provider failover. |
| Cancellation | Explicit client cancel, shutdown, expiry, eviction and limit errors cancel upstream HTTP/WS/media I/O and cooperative work, stop producers and wake readers; outstanding leases obey §6.4, never forced reuse or retry. Expiry and eviction end readers with `error` `stream.gone`, not `cancelled`. |
| Client disconnect | Release only that reader's lease. Upstream collection continues and the bytes stay cached for a resume (§6.6); a resume after expiry or eviction fails with `stream.gone`. |
| Pre-delivery upstream failure | Routing may retry another permitted upstream/credential with a fresh attempt stream; do not mix failed-attempt events into the selected response. |
| First deliverable event | Egress sets commit once before scheduling the first output bytes; status/headers become fixed; retry is disabled. |
| Post-delivery failure | Preserve delivered prefix, emit destination error/abnormal close, never append successful terminal output or restart content. |
| Non-streaming client | Egress reads position-backed events into the destination document incrementally; only final output serialization waits for completion. |
| Streaming terminal snapshots | Egress re-reads retained ranges for Responses item/output snapshots and similar formats; no accumulated heap copies. |

Request and response retention together must fit their assigned stream budget; an unlimited-duration stream is not unlimited retained history.
Keep request-direction and scratch ranges only while an egress snapshot or reader needs them; release them promptly after their last dependent position advances. A response stream's ranges stay in the cache queue for resume and snapshots (§6.4).
Where a final response requires old content, do not evict it silently to meet a limit; fail visibly under the same queue rule.
A destination that only accepts whole tool JSON may delay tool serialization at egress by reading mapped fragments; internal argument delivery remains incremental.
SSE, JSON array streams, raw media HTTP bodies, WS JSON/binary messages and WebRTC packets are egress encodings, not alternate internal pipelines.
Today `crates/ck-server/src/dispatch.rs:2653-2675` bootstraps `Done::Stream` on the first nonempty upstream chunk and concatenates non-streaming output in `BytesMut`; bootstrap is not transport commitment.
Configured nonstream/media keepalives can commit headers/body before an inference event (`crates/ck-server/src/dispatch.rs:583-632`).
The new single commit point is egress scheduling the first client-deliverable bytes after encoding; suppressed metadata cannot commit, and pre-delivery keepalives/success headers are forbidden (§3.6).
Today's framer has a 16 MiB per-event default and a BytesMut buffer (`crates/ck-translate/src/sse.rs:9-13,28-34`); that number is evidence, not an adopted S0 stream/pool limit.

## 8. Extension

Plugins are deleted (owner ruling 2026-11-13, 「目前完全删除外挂功能，如果用户想要拓展功能，需要修改源码并自行编译部署」). There is no runtime plugin, interceptor, SDK or ABI boundary. Extending cooker means changing the source and rebuilding.
Every stage that reads or rewrites stream content is in-process code. It follows the §3 grammar, the §6.2 publication protocol and the §6.4 quotas, and cannot change trusted request identity, attempt ownership, usage authority or commitment state.

## 9. Verification

### 9.1 Golden change ledger and semantic assertions

For each changed fixture, record fixture ID, affected route/direction/mode, old behavior, new behavior, ruling/spec clause, and replacement semantic assertions.
Do not bless rewritten expected bytes wholesale. Keep exact-byte checks only where bytes remain contractual, such as decoded media and opaque signature content.
Replace obsolete pair-registry/wiring assertions; same-protocol re-encoding is not a reason to retain legacy translators.
The ledger MUST explicitly replace invalid-UTF-8 passthrough and single-buffered-tool-chunk expectations (`crates/ck-translate/tests/golden.rs:550-583,588-612`).
Cover every registered client/upstream combination and applicable request/stream/buffered/count mode; current inventory is `crates/ck-translate/src/lib.rs:303-335`. Add native same-protocol, compact, all media and duplex routes.

| Assertion group | Required semantic proof |
| --- | --- |
| Text/order | Every text/thinking part survives in source order, including several same-kind Gemini parts, empty strings and interleaved choices. |
| Replay | Claude fragmented signatures, redacted thinking, Gemini signature-only parts and Responses encrypted items round-trip to the correct history block. |
| Tools | Start/fragments/end remain incremental; IDs and choices survive; historical JSON input stays structured until Chat egress serializes it, while custom text remains text. |
| Usage | Partial/repeated/corrected snapshots, explicit zero/absent/null, cache TTL buckets and multiple attempts count once; count_tokens never becomes generation usage. |
| Fidelity | Choice-scoped `delta: {}` logprobs-only chunks need no fabricated text; refusal/safety/citation offsets and provider sequences survive; unknown nested fields/events reach egress before destination-specific emission/debug-logged drop. |
| Request fields | Both sampling fields, audio modalities, legacy options, speech instructions and provider options survive. Late unsupported mapped semantics cause 400 with zero upstream requests; Typed content/controls round-trip; literal media-marker look-alikes remain data, references cannot cross streams. |
| Destination projections | Choice 0 selected by index, not array position; dropped choices and unsupported B9 events produce content-free debug diagnostics. |
| Framing | Fragment every UTF-8/SSE delimiter/base64 unit across reads; exercise multiline data, CR/LF variants, empty events and source terminal markers. |
| Failures | Client invalid UTF-8→400; upstream invalid UTF-8/malformed/truncated input→error; no success after error/cancel or post-terminal content. |
| Commitment | Metadata-only output that egress suppresses permits retry; deliverable role/event bytes prevent it; keepalive cannot commit early. |
| Media | Exact bytes/MIME/timing, 36,864-byte full chunks, whole encoded event ≤50,000 bytes, framing overflow shortens the chunk; ≤100 ms collection while allocation succeeds, including a slow consumer; failed reservation ends with error. |
| Duplex | Responses append/history and realtime control/media/sideband preserve direction/turn/session/packet identity; cancellation closes owned work. |
| Storage | Concurrent publication exposes complete prefixes; cross-block JSON, lost-wakeup races, cancellation, stale handles and frame reuse cannot leak/corrupt content. A frame held by a reader is never reused or punched. |
| Bounds | Exercise a throttled client against a fast upstream (upstream reads never pause; the 5,369th frame of one stream fails visibly with the 256 MiB per-stream error), eviction by least recent read (the stream read most recently survives, the stream whose last read is oldest goes first, a read refreshes recency, error then EOF for a leased reader), 1 h expiry with a test clock (a stream survives just under 1 h, expires after it, and a read inside the hour restarts it; unread bytes of a stalled client expire like any other), and last-lease-only reuse; a stuck lease survives expiry and eviction and forces visible allocation failure, never overwrite/heap growth. |
| Resume | Disconnect a client mid-stream: upstream is not cancelled, collection reaches `done`, and the bytes stay cached. Reconnect with the last delivered position: delivery continues with no gap and no repeat, live while upstream runs and from the cache after it ended. Resume after expiry (test clock), after eviction and from another identity returns `stream.gone` (410), never an empty success or a restart. Explicit cancel, expiry, eviction and a limit error still cancel upstream. |
| Permissions/lifecycle | Real private mmap pool on tmpfs and configured disk directory; modes, unlink, process death and last-reader release verified. Pool exhaustion on a small tmpfs returns an error (ENOSPC from `fallocate`), never SIGBUS. |
| Loss ledger | L01–L18 receive consumer-visible regression coverage where applicable; no test merely greps source or repeats implementation wiring. |

New gates require planted violations and a recorded failing result: erase a signature, replace absent usage with zero, overwrite a Gemini part, publish before event completion, reuse a leased frame, bypass chunk timer/size, commit on suppressed metadata, cancel upstream on client disconnect, or leave the last-read time unrefreshed by a read.
Use deterministic clocks and local mock upstreams; concurrency/storage checks use real temporary mappings and isolated process lifetimes, not fake success adapters.
No live-provider traffic without owner approval. Cache-semantic changes require warm/changed-context/idle checks with observed cache read/write usage (`crates/AGENTS.md:88,92-94`).

### 9.2 Benchmarks and metrics

Maintainers replace the provisional §6.4 defaults with measured values from §9 and record each value and its measurement in this specification and `docs/BENCHMARKS.md`. Choose a regression tolerance before the run: completing a benchmark is not passing an unchosen tolerance.
Use old/new release binaries separately, identical host/configuration/CPU affinity/load, three alternating old/new rounds for the codec, pipeline and flow measurements below, fresh server processes and isolated loopback mocks. The storage rows in §9.3 set their own run counts, and those gate the S1 merge.
The following are commands for implementation verification, not commands run while writing S0; OLD/NEW/OLD_LATENCY/NEW_LATENCY are existing build paths and OUT is a disposable output directory.

```sh
for round in 1 2 3; do
  SERVERS=rust SCENARIOS='chat chat-stream chat-stream-slow messages-stream' \
    bench/run.sh "$OLD" "$OLD" "$OUT/old-$round" 1
  SERVERS=rust SCENARIOS='chat chat-stream chat-stream-slow messages-stream' \
    bench/run.sh "$NEW" "$NEW" "$OUT/new-$round" 1
  MIN=1000000 MAX=3000000 DELAY=0ms \
    bench/messages.sh "$OUT/messages-$round" old "$OLD"
  MIN=1000000 MAX=3000000 DELAY=0ms \
    bench/messages.sh "$OUT/messages-$round" new "$NEW"
  bench/latency.sh "$OUT/latency-old-$round.jsonl" "$OLD_LATENCY"
  bench/latency.sh "$OUT/latency-new-$round.jsonl" "$NEW_LATENCY"
done
```

`bench/run.sh` resolves its second binary argument even for SERVERS=rust, so repeat the Rust path there; it is not a Go comparison (`bench/run.sh:30-33,155-158`).
Scenario names and current measures are in `bench/run.sh:120-151`; Messages MIN/MAX/DELAY and affinity are in `bench/messages.sh:40-51,98-110`; latency arguments/isolation are in `bench/latency.sh:5-28`.
The current `chat-stream-slow` scenario delays the upstream, not the downstream consumer (`bench/run.sh:121-130`); additionally run an explicitly throttled downstream reader to prove upstream collection continues (D2) and the per-stream limit fails visibly.
Latency harness peak memory includes proxy, mock and client (`crates/ck-server/examples/claude_latency.rs:7-28`); report it separately from proxy-only measures.

| Measurement | Required dimensions |
| --- | --- |
| Codec cost | CPU ns/event, allocations/event, allocated bytes/event, encoded/decoded bytes/event; each protocol/direction and event kind. |
| Pipeline cost | CPU/completion, throughput, TTFB/time-to-first-deliverable-event, inter-event delay, completion latency and p50/p95/p99. |
| Memory/storage | Heap peak/retained bytes, RSS/PSS, anonymous versus mapped/shmem resident bytes, pool reserved/used frames, metadata bytes, page faults and tmpfs/cgroup charge. |
| Flow limits | Consumer lag, blocked-read duration, cache bytes, time since last read, evictions, expiries, resumes and `stream.gone` count, allocation failures, cancelled-stream cleanup and outstanding leases. |
| Media/long streams | Signatures, tool fragments, logprobs, multiple choices, audio/video chunks, long-lived realtime, completed-output snapshots and actual slow consumers. |
| Small requests | Few-KB requests, pool startup/mapping cost separately from steady-state frame allocation; no per-request pool-file cost assumed. |

Record host architecture/page size, kernel, filesystem, CPU affinity/load, build flags, configuration, binaries/revisions, repetitions and raw results.
A lower heap/RSS reading alone is not a memory improvement claim: account for mmap/tmpfs residency and OS page cache; compare total charged resources under the same workload.

### 9.3 Storage regression gate (S1)

Owner ruling (G9): performance tests mount the storage directory on tmpfs, and no regression against heap buffering is accepted. S1 may not merge the pool until every row below holds. The comparison is the chosen pool backend (per-thread LIFO lists, 128-byte alignment, decay reclaim) against heap frames of the same size and layout, on the same host, with `stream.pool_directory` on tmpfs. The per-request-file backend was rejected (§6.1) and is not measured here.
**S1 choice:** use at least 7 alternating runs per row and compare medians. A row regresses when the pool's median is worse than heap's and falls outside heap's own min..max range. The open row below uses a stricter rule.

| Row | Workload | Measured | Pool must be |
| --- | --- | --- | --- |
| Small request | 2 KiB (32 × 64 B), create, write, read, drop; 1 task and 64 tasks; req/s, p50, p99 | 64 tasks: +2.5% req/s, p99 -19%; 1 task: -0.4% req/s, p99 +7.2% (other runs -1.3%, within noise) | Not slower than heap |
| Concurrent streams | 256 and 1024 streams of 256 KiB in 256 B deltas, 1 reader each; wall time and TTFB p99 | 256: -18% wall; 1024: -40% wall; TTFB p99 -27% in both | Not slower than heap |
| Throughput | 1 writer, 1 and 4 readers, 64 B and 48 KiB appends, streams of 1, 32 and 250 MiB; MB/s. 250 MiB is the largest size that fits the per-stream limit of 5,368 frames when each 48 KiB append takes one frame (5,334 frames); the limit is not raised | S0 ran 256 MiB streams with a raised limit: +2% to +121% except the open row below. The 250 MiB rerun is pending | Not slower than heap |
| Latency | 64 B deltas 20 µs apart, 1 and 4 readers; append-to-observe p50 and p99; TTFB | p50 equal; p99 +4% with 1 reader (inside heap's range), -21% with 4 readers | Not slower than heap |
| Memory | 100 × 1 MiB and 10 × 64 MiB held, then released (expired with the test clock for the pool); `VmRSS`, `RssAnon`, `RssShmem`, cgroup `memory.current`, tmpfs used; sampled after the first eligible reclaim tick, at most two decay intervals after the release, because frames freed just after a tick are not yet idle for a full interval at the next one (§6.5) | Sampled about 1 s after release: 100 × 1 MiB: `VmRSS` 3 MiB and tmpfs 2 MiB against heap's 17 MiB `VmRSS`; 10 × 64 MiB: 2 and 1 MiB against heap's 2 MiB | `VmRSS` at or below heap's, and tmpfs used and `VmRSS` each at most 4 MiB over the pre-test baseline, plus 8 frames for each free list; the run uses 8 worker threads, so the allowance is 8 × 8 × 50,000 = 3,200,000 bytes |
| Total-budget exhaustion | 4 GiB pool on a tmpfs with at least 4 GiB free, 256 MiB per stream, every stream held by an active reader lease so nothing is evictable: each stream is capped at 5,368 frames (§6.4), and streams append until refused | Not measured with these quotas. The S0 `totalcap` run used 512 MiB streams of 10,738 frames; rerun it with 5,368. Sixteen streams hold 85,888 of 85,899 frames | Streams 1-16 stop at the per-stream limit; stream 17 stops at the total cap after at most 11 frames; each refusal is an error, no SIGBUS, no heap spill |
| Tmpfs exhaustion (ENOSPC) | Private tmpfs of 64 MiB (`unshare -Urm`), growth by `fallocate` | ENOSPC returned after 66,158,592 committed bytes; the same run grown by `ftruncate` died of SIGBUS | `fallocate` error becomes a stream error, no SIGBUS, no heap spill, process keeps running |

The 4 MiB memory margin sits just above the 1-3 MiB the S0 run reported, which is MiB-granular and varies between runs, and far below the residue of a failed reclaim (112 and 641 MiB). The 8-frame term is the free frames each list keeps by design (§6.5).

One row is open: 4 readers, 64 B appends, 1 MiB streams. It does not pass by default. S0 results over 101 repetitions: the decay pool's median was +0.4% and -2.9% in two runs, the fixed pool without reclaim -4.1% and -3.7%, and heap's own runs spread from 254 to 1320 MB/s. The harness could not attribute or remove the possible few-percent loss. S1 runs this row for the pool and for heap, 101 alternating runs each, and reports both medians and the difference. Heap's run-to-run spread is the interquartile range of its 101 runs (P25..P75). The row passes only when the pool's median is not below heap's P25; a median below it blocks the merge until fixed or until an owner accepts the loss.
The S0 prototype `s0-bench` (outside this repository) produced the numbers. S1 ports these workloads into `bench/` and keeps the gate there. Commands used, from the prototype directory with `$TMPFS` an existing tmpfs directory (the S0 `rss` rows ran the `pool-fixed+reclaim` backend, which is the chosen decay pool; `totalcap` must first be changed to give each stream 5,368 frames):

```sh
cargo build --release
sh scripts/run-all.sh "$TMPFS/s0-bench"        # about 7 min; includes the ENOSPC check
sh scripts/followup.sh "$TMPFS/s0-bench"       # padded LIFO pool, decay reclaim; about 1 min
./target/release/s0-bench small --tasks 64 --variants "pool sharded LIFO,decay" --counters 1
./target/release/s0-bench throughput --set followup --reps 101 --readers 4 --chunks 64 --sizes 1m
./target/release/s0-bench rss pool-fixed+reclaim 100 1m --dir "$TMPFS/s0-bench"
./target/release/s0-bench rss pool-fixed+reclaim 10 64m --dir "$TMPFS/s0-bench"
./target/release/s0-bench totalcap --dir "$TMPFS/s0-bench" --total 4g --max 256m
sh scripts/enospc.sh
```

## 10. Accepted defaults

Every default below is binding for S1 and **Settled (default accepted 2026-11-14)**. The cache numbers (G8: 256 MiB per stream, 4 GiB total, 1 h since last read) and the resume behaviour (§6.6) are owner rulings of 2026-11-14. Owners directed implementation to proceed, not to wait for another design approval; a later owner ruling may still revise a row. Where this spec is silent, follow the keeper behaviour at the commit pinned in §2, "Further details".

| Default | Status |
| --- | --- |
| B1: Claude block-bound signatures | Revisable by a later owner ruling (§3.2–3.3). |
| B2: opaque redacted-thinking event | Revisable by a later owner ruling (§3.3). |
| B3: Gemini part-bound/signature-only parts | Revisable by a later owner ruling (§3.2). |
| B4: TTL buckets, absence, usage snapshots | Revisable by a later owner ruling (§3.5). |
| B5: choice-level logprobs | Revisable by a later owner ruling (§3.1). |
| B6: media MIME/bytes/transcript/timing | Revisable by a later owner ruling (§3.4). |
| B7: independent choices, choice-0 projection | Revisable by a later owner ruling (§3.7). |
| B8: tool start/deltas/end | Revisable by a later owner ruling (§3.3, §3.6). |
| B9: grounding/code/URL events and egress drops | Revisable by a later owner ruling (§3.7). |
| C2: invalid-text UTF-8 failures | Revisable by a later owner ruling (§7). |
| D1: event and metadata sizes | Revisable by a later owner ruling; maintainers replace the provisional values with measured ones after the §9 benchmarks (§6.4). |
| D3: first-deliverable-byte commit | Revisable by a later owner ruling (§3.6, §7). |
| F: codec and pipeline thresholds | Revisable by a later owner ruling; maintainers set throughput, latency, CPU, allocation and total-storage tolerances after the baseline and before accepting performance (§9). |

Linux-only scope, one representation, the storage rulings in §2 and visible resource failure remain owner decisions, not pending design questions.
