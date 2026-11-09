Changed

- The project is now called gnocchi and lives at prep-cook/gnocchi. The binary is `gnocchi` (`gnocchi.exe` on Windows), release archives are `gnocchi-<version>-<target>`, the Docker image runs `gnocchi` as user `gnocchi`, and the server reports its version as `gnocchi-<version>`.
- The install scripts download from prep-cook/gnocchi and install to `~/.local/bin/gnocchi` or `%LOCALAPPDATA%\Programs\gnocchi`, with config, keys and logs in `~/.gnocchi` (`gnocchi.log`, `gnocchi.pid`). New `keys.env` files name the keys `GNOCCHI_PORT`, `GNOCCHI_CLIENT_KEY` and `GNOCCHI_MANAGEMENT_KEY`.
- `GNOCCHI_VERSION`, `GNOCCHI_INSTALL_DIR`, `GNOCCHI_HOME`, `GNOCCHI_NO_OPEN`, `GNOCCHI_RELEASES` and `GNOCCHI_NO_UPDATE_CHECK` replace the `CLIPROXY_*` variables, which still work while the new name is unset.
- Rerunning the installer on an existing install keeps using `~/.cliproxy-rs` when there is no `~/.gnocchi`, stops the old `cliproxy` server, and replaces a start-at-login service from before the rename with the gnocchi one. The old `cliproxy` binary stays until you delete it.
- The dashboard's Codex CLI settings name the provider `gnocchi` and read the key from `GNOCCHI_API_KEY`; model routers are listed as owned by `gnocchi`.
