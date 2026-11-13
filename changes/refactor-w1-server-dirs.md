Internal

- Group `ck-server` source files by responsibility without changing behavior. Callers use grouped paths, including `management::api` and `observability::api`; `ck_server::runtime`, the root `Runtime` re-export and gated `testing` module remain available. No old-path compatibility aliases remain.
- Unit-test module prefixes and implicit tracing targets follow the grouped modules; update test selectors and module-specific `RUST_LOG` filters, including `websocket::tests::` to `realtime::websocket::tests::` and `pprof::tests::` to `observability::pprof::tests::`. Explicit targets, including `cpa_latency`, are retained.
