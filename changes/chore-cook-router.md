Changed

- The project is now called cook-router and lives at prep-cook/cook-router. The binary is `cook-router` (`cook-router.exe` on Windows), release archives are `cook-router-<version>-<target>`, the Docker image runs `cook-router` as user `cook-router`, and the server reports its version as `cook-router-<version>`.
- The install scripts download from prep-cook/cook-router and install to `~/.local/bin/cook-router` or `%LOCALAPPDATA%\Programs\cook-router`, with config, keys and logs in `~/.cook-router` (`cook-router.log`, `cook-router.pid`). New `keys.env` files name the keys `COOK_ROUTER_PORT`, `COOK_ROUTER_CLIENT_KEY` and `COOK_ROUTER_MANAGEMENT_KEY`.
- `COOK_ROUTER_VERSION`, `COOK_ROUTER_INSTALL_DIR`, `COOK_ROUTER_HOME`, `COOK_ROUTER_NO_OPEN`, `COOK_ROUTER_RELEASES` and `COOK_ROUTER_NO_UPDATE_CHECK` replace the `CLIPROXY_*` variables, which still work while the new name is unset.
- Rerunning the installer on an existing install keeps using `~/.cliproxy-rs` when there is no `~/.cook-router`, stops the old `cliproxy` server, and replaces a start-at-login service from before the rename with the cook-router one. The old `cliproxy` binary stays until you delete it.
- The dashboard's Codex CLI settings name the provider `cook-router` and read the key from `COOK_ROUTER_API_KEY`; model routers are listed as owned by `cook-router`.
