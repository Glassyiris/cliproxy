Fixed

- Responses WebSocket requests allow eligible, retryable attempts to finish credential failover before an early upstream disconnect closes the client connection. With Codex stream bootstrap buffering enabled, HTTP/SSE and non-steering WebSocket attempts can switch to the next eligible credential without exposing the failed attempt's handshake frames; request-scoped failures still stop, existing overload normalization and retry limits remain in force, and started responses and stateful continuations are not replayed across credentials.
- A retired upstream socket's disconnect cannot overtake failover and close its healthy replacement. Local validation and prewarm replies remain cancellable on upstream loss when the downstream writer is blocked.
