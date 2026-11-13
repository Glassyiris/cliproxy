Removed

- Go-style single-dash flags (`-config`, `-tui`, `-flag=value`, `-bool=false`) are gone; use `--config`, `--tui` and the other double-dash forms. A repeated flag, a flag after an operand and `--bool=false` are parse errors, and a parse error now exits before any database opens.
- The `CLIProxyAPI Version: ...` banner on stdout is gone; the version is logged at startup.
- The environment variables `MANAGEMENT_PASSWORD`, `WRITABLE_PATH` (and `writable_path`), `DEPLOY`, `CLIPROXY_NO_UPDATE_CHECK` and `COOK_ROUTER_NO_UPDATE_CHECK` are no longer read; set `COOK_MANAGEMENT_PASSWORD`, `COOK_WRITABLE_PATH`, `COOK_DEPLOY` and `COOK_NO_UPDATE_CHECK` instead.
- The `X-CPA-*` response headers are renamed `X-Cook-Version`, `X-Cook-Commit`, `X-Cook-Build-Date`, `X-Cook-Support-Plugin`, `X-Cook-Trace-Id`, `X-Cook-Routed-Model`, `X-Cook-Routed-Provider` and `X-Cook-Safe-Mode`; the `X-CPA-Claude-Workload` request header is now `X-Cook-Claude-Workload`. Builds read `COOK_COMMIT` and `COOK_BUILD_DATE` instead of `CPA_COMMIT` and `CPA_BUILD_DATE`.
- LAN discovery advertises and recognizes the product id `cook-router` instead of `cliproxyapi`.
