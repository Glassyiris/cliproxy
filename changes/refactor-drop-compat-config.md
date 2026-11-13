Removed

- Config files are read in the current (v8) layout only. Pre-v8 root keys (`host`, `port`, `auth-dir`, `remote-management`, `request-retry`, `proxy-url`, `debug`, `codex`, `claude`, `claude-code` and the rest), the `*-api-key` and `openai-compatibility` lists, a root `api-keys` list, and the historical v8 spellings under `oauth.providers` (`codex.disable-codex-cloaking`, `claude.*`, `xai.*`, `codex.optimize-multi-agent-v2`) are no longer moved to their v8 paths; import and every config write reject them as unknown settings. Move them to `server.*`, `oauth.*`, `access.api-keys`, `api-keys.<family>`, `upstream.*`, `client.*` and the other v8 sections before importing.
- The `@store-provenance` setting that kept legacy-layout OAuth settings global is gone; every `oauth.providers.*` setting applies to OAuth credentials only.
- `models[].thinking` in config YAML accepts only `zero-allowed`, `dynamic-allowed` and `disable-type`; model catalogs keep their `zero_allowed`, `dynamic_allowed` and `disable_type` spelling, and neither accepts the other.
- The `PGSTORE_*`, `OBJECTSTORE_*` and `GITSTORE_*` variables no longer stop startup with a migration message; they are not read.
