# Moving from CLIProxyAPI (Go) to cook-router

cook-router develops independently from CLIProxyAPI. SQLite is now the sole durable authority for configuration **and OAuth credentials**. Migration is a one-time import, not two binaries sharing `config.yaml` or an auth directory. The old Go parity audit remains [historical evidence](PARITY.md), not the current administration contract.

## Before switching

1. Locate the Go server's YAML config, credential directory and service command. Legacy layouts use `auth-dir`; v8 layouts use `oauth.auth-dir` (often `~/.cli-proxy-api`). Export legacy remote-store contents to private local files if necessary; cook-router will not fetch or mutate them as runtime state.
2. Stop the Go server before copying or importing credentials. Back up its YAML and credential files privately. They contain provider secrets and refresh tokens.
3. Choose a stable SQLite path on a persistent local volume, for example `/var/lib/cook-router/cook.db`. Give the cook-router service user exclusive write access to the directory; keep it private (0700 on Unix). The published database, temporary working databases and backups must be private (0600 or equivalent ACLs).
4. Remove selected `PGSTORE_*`, `OBJECTSTORE_*` and `GITSTORE_*` backend settings from the new server's environment. A selected legacy remote config store now fails startup with a migration error; it is not a fallback authority or asynchronous YAML mirror.

Do not run Go and cook-router with credentials for the same account at the same time, even from separate copies. Providers can rotate refresh tokens; one server's refresh can invalidate the other's copy. A copied credential directory is not an isolated test. Use a separate test account and a different port for side-by-side trials. A backup's refresh tokens may stop working after either server refreshes them.

## Import and start

Prepare the YAML with the desired listen address, client keys and management access. The v8 and older flat layouts are import formats; [Configuration](CONFIGURATION.md) describes their settings and runtime projection, not SQLite's internal persisted schema. OAuth-only scope and versioned plugin raw data are preserved during import; do not assume unknown or invalid settings are silently dropped. Review validation errors before switching.

```sh
cook-router --db /var/lib/cook-router/cook.db config validate /private/config.yaml
cook-router --db /var/lib/cook-router/cook.db config import /private/config.yaml
cook-router --db /var/lib/cook-router/cook.db
```

Use that same `--db` path (or `COOK_DB`) for services, server starts, sign-ins and other CLI operations. `--config FILE` remains a first-bootstrap compatibility import selector only: it is not a watched runtime config. Without an explicit database path, the default is `cook.db` beside `--config` (`config.yaml` by default). A fresh ordinary startup needs its import YAML; cloud/Home can initialize without it. Once initialized, later startup never reads that YAML, even if it changes, is missing or is invalid.

The first local server start or credential/plugin CLI operation imports raw JSON credentials from the configured legacy `oauth.auth-dir` exactly once. This migration has its own durable marker, so it still runs after the separate `config import` above initialized configuration. Later starts load SQLite only: leftover files cannot resurrect deleted credentials. Legacy `.cds` cooldown files are imported alongside that one-time migration; persisted cooldowns then use SQLite's credential state. OAuth login, refresh, account edits, disables and revocations are stored separately from config revisions and excluded from config exports. Keep the original credential backup offline and private; never leave another server refreshing it. The private `<canonical-db-path>.credentials` directory is an internal materialized cache/refresh-lock domain, not a new editable auth directory; edits are reverted to DB state. Home-dispatched credentials are not persisted locally. See [Installation](INSTALL.md) for deployment and volume ownership.

Open `/management.html`, check the account list and send a request through `/v1/models` with a client key. The client routes remain the tool-facing interface; point clients at the new address/port if those changed.

Credential `auth_index` values change on the first import because local credential paths move into the database's working directory. Refresh account lists and cached selections after migration; historical usage/log records retain their old indexes and do not automatically join to new records. Ordinary credential names remain usable, and cooldown state uses credential IDs rather than `auth_index`. Indexes remain stable across restarts at the same canonical database path, but moving the database changes local credential indexes again. Home-assigned indexes are unaffected; plugin-generated IDs may also depend on the source path.

## Administration changes

- Configuration now uses `/admin/v1/r/{kind}/{id}` resources with stable IDs and revisions. The old `/v0/management` and `/v8/management` config reads/writes, raw YAML upload and per-setting routes are deleted, not aliased. Migrate external scripts as well as dashboard/TUI callers.
- `POST /admin/v1/apply` validates and commits multiple operations atomically. `?dry_run=true` checks the whole candidate without writing or publishing.
- Use strong revision ETags and `If-Match` to prevent overwriting another administrator's work. Failed preconditions return 412; schema validation returns structured 422 errors. Import and restore require a global `If-Match` (428 if absent).
- `/admin/v1/revisions` records configuration history; restoring a revision creates a new config revision. Credential state is not in those revisions, so restore never resurrects a revoked token.
- `/admin/v1/export` and `config export` redact secrets by default. Explicit secret export is sensitive. Configuration export is not a full credential backup.
- Non-config credential and OAuth management operations remain separate and use database-backed credential persistence.

See [Configuration](CONFIGURATION.md#administration-api) for routes, preconditions and response headers. YAML comments/formatting are not a runtime contract; the server never rewrites or mirrors a watched YAML file.

## Services and containers

Update a service to use an explicit `--db /var/lib/cook-router/cook.db`, with a writable private database directory. If bootstrapping through `--config`, use it only to select the initial import. Changes made later through the dashboard do not update that file; service health probes must not treat stale YAML as the effective configuration.

Mount a **directory** for the published SQLite snapshot, not only a file: each commit creates a temporary snapshot beside it and atomically replaces it. Keep OS tmp writable and private for the working database; server and CLI writers must share the same OS user and temporary namespace. WAL/SHM files are not runtime storage. The default Docker image runs as UID/GID 10001: give it ownership of the mounted directory. A remote bucket, PostgreSQL database or git repository is not a substitute for this persistent volume. See [Docker](INSTALL.md#docker).

## Backup and recovery

```sh
cook-router --db /var/lib/cook-router/cook.db config backup /private/cook-router-backup.db
```

This uses SQLite's `VACUUM INTO` and includes configuration, revision history and credential secrets. The `--db` file is also a complete published snapshot: copy it directly while the service runs for a usable backup. Keep backups private and treat old refresh tokens as potentially invalid. Config-history restore is not credential recovery. Logical deletion or secure-delete settings do not guarantee physical disk erasure, especially on SSDs, snapshots or retained backups.

For a cold restore, stop all server/CLI users first. A valid working database left by an abnormal exit wins on restart and can republish over a replaced snapshot. Before restoring, either remove only the correct `<TMPDIR>/cook-router/<canonical-db-path-hash>` directory after verifying no PID reference is alive, or configure a fresh private trusted temporary namespace shared by every future server/CLI user. Never delete `coordination.db` or an active working directory; do not later switch back to a namespace containing the old live state. Restore the snapshot with the service user's ownership and private permissions, then restart in the selected namespace. See the [step-by-step cold-restore procedure](CONFIGURATION.md#restore-a-backup-instead-of-resuming).

## Switching back

This is no longer a shared-file switch. Stop cook-router and restore a separately managed Go installation from your private migration backup, or reconfigure Go manually. A cook-router resource export is not Go YAML, and a redacted export lacks secrets. Do not expect Go to understand SQLite or assume old OAuth refresh tokens are still valid; sign in again when necessary. Never start both servers on the same account to test rollback.
