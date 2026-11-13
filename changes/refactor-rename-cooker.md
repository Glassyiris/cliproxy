Changed

- The project is renamed cooker. The binary, the Docker image (`ghcr.io/prep-cook/cooker`), the image's user and group, its documentation directory and the GitHub address (`github.com/prep-cook/cooker`) use the new name, and `--version` prints `cooker <version>`. Old names are not accepted anywhere.
- Environment variables start with `CK_` instead of `COOK_` or `COOK_ROUTER_`: for example `CK_MANAGEMENT_PASSWORD`, `CK_DB`, `CK_WRITABLE_PATH`, `CK_NO_UPDATE_CHECK`. Rename them in your service, container and shell settings before upgrading.
- Response headers start with `X-Ck-` instead of `X-Cook-` (for example `X-Ck-Version`, `X-Ck-Trace-Id`, `X-Ck-Routed-Model`). Update scripts, proxies and log filters that read them.
- The inbound request header `x-ck-claude-workload` replaces `x-cook-claude-workload`; clients that set the old name must send the new one.
- The dashboard session cookie is `cooker_session`, so everyone signs in to the dashboard again after the upgrade.
- The default database file is `cooker.db` beside the config file instead of `cook.db`. Rename the file, or pass `--db` or `CK_DB`, before starting the new version; otherwise the new version does not find it.
- Config exports carry the format `cooker-config`; exports made by earlier versions are refused by `config import`. Export again after upgrading.
- Browser preferences (theme, palette, language, side navigation) are stored under new keys and return to their defaults once.
- mDNS discovery advertises and finds the product `cooker`; earlier versions on the network are no longer recognised as this product. The default instance name is `Cooker-<ID>` instead of `CPA-<ID>`.
- The discovery instance ID is kept in `$XDG_CONFIG_HOME/cooker/discovery` (`~/.config/cooker/discovery` without `XDG_CONFIG_HOME`) instead of `.../cpa/discovery`, so the instance gets a new ID once; the old directory is not read.
- The development and test controls `CK_BACKEND`, `CK_URL`, `CK_KEY`, `CK_TEST_NO_SKIP` and `CK_FIXTURE_OUT` replace the `CPA_` names of the same suffix, in the dashboard dev server, the benchmark scripts, the Dockerfile and the Go reference generators.
- Log targets follow the new crate names (`ck_server`, `ck_exec` and so on), so `RUST_LOG` filters naming `cpa_*` crates must be rewritten; `cpa_latency` is unchanged.
- Stop the running server before starting the new version: the owner lock moved to `.cooker-owners` and the working directory to `cooker`, so the two versions do not see each other's lock.
