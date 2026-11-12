# Installing cook-router

cook-router is one executable, `cook-router` (`cook-router.exe` on Windows), with the dashboard built in. Configuration and OAuth credentials are persisted in SQLite. It needs a private, writable, persistent database directory; YAML and credential files are legacy first-import sources, not runtime storage.

## With the install script

On macOS or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/prep-cook/cook-router/master/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/prep-cook/cook-router/master/install.ps1 | iex
```

Neither needs `sudo`, administrator rights, Rust or any other tool. The first run:

1. Picks the release archive for your system, downloads it with the release's `SHA256SUMS`, and stops without installing anything if the checksum does not match.
2. Installs the binary: `~/.local/bin/cook-router` on macOS and Linux, `%LOCALAPPDATA%\Programs\cook-router\cook-router.exe` on Windows.
3. Selects an absolute database path from `COOK_DB`, or `cook.db` in the selected install home. An existing database skips key generation and YAML import, even if `config.yaml` and `keys.env` are missing. Otherwise it imports existing legacy YAML once, or creates private bootstrap YAML with a loopback free port and session affinity plus private `keys.env`, then runs `config import`. It never prints the keys. The retained YAML is stale migration backup, not runtime configuration.
4. Starts the server in the background, logging to `cook-router.log`, and checks that `/healthz` answers.
5. Prints the dashboard address and opens it in your browser when there is one.

Sign in to the dashboard with the `COOK_ROUTER_MANAGEMENT_KEY` line from `keys.env` (`cat ~/.cook-router/keys.env`, or `Get-Content ~\.cook-router\keys.env` on Windows). Your tools use `COOK_ROUTER_CLIENT_KEY`.

Running the script again upgrades the binary and restarts the server using the same explicit absolute `--db` path. Background starts, systemd/launchd services and the Windows Run entry all use it. Health probes read committed host/port/TLS with the secret-free `config listener` command, not stale YAML. Preserve the database and keys when upgrading. On Windows a failed upgrade restores the old binary, but a binary without `--db` support is not restarted: sign-in entries are disabled and the installer asks you to install a current release rather than silently serving stale YAML.

On a machine without a browser, such as a server you reach over SSH, keep the server on `127.0.0.1` and open an SSH tunnel from your own computer, for example `ssh -L 8317:127.0.0.1:8317 you@server`, then open `http://127.0.0.1:8317/management.html` there. [Tailscale](MULTI-ACCOUNT.md#reach-the-proxy-from-other-machines) works too. Never listen on `0.0.0.0` without client keys.

Read [install.sh](../install.sh) or [install.ps1](../install.ps1) before you run them if you prefer.

### Options

| install.sh | install.ps1 | Effect |
| --- | --- | --- |
| `--service` | `-Service` | Also start cook-router at login; see below. |
| `--binary-only` | `-BinaryOnly` | Install or upgrade the binary and stop there. |
| `--check` | — | Report installed and available versions without downloading a binary, changing files or restarting. |

Pass options to a piped script like this:

```sh
curl -fsSL https://raw.githubusercontent.com/prep-cook/cook-router/master/install.sh | sh -s -- --service
```

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/prep-cook/cook-router/master/install.ps1))) -Service
```

Both scripts read these environment variables. Each also accepts its `CLIPROXY_*` name from before the rename, such as `CLIPROXY_HOME`, when the `COOK_ROUTER_*` name is unset.

| Variable | Default | Meaning |
| --- | --- | --- |
| `COOK_ROUTER_VERSION` | the latest release | Release tag to install, such as `v0.1.0`. |
| `COOK_ROUTER_INSTALL_DIR` | `~/.local/bin`, or `%LOCALAPPDATA%\Programs\cook-router` | Where the binary goes. |
| `COOK_ROUTER_HOME` | `~/.cook-router`, or `%USERPROFILE%\.cook-router` | Bootstrap files, persistent SQLite database, keys and log. |
| `COOK_DB` | `cook.db` in the selected install home | Persistent SQLite database used by imports, probes and every managed launch; the installer resolves it to an absolute path. |
| `COOK_ROUTER_NO_OPEN` | unset | Set to `1` to never open a browser. |
| `COOK_ROUTER_RELEASES` | `https://github.com/prep-cook/cook-router/releases` | Release page base URL for a mirror or installer tests. Unless `COOK_ROUTER_VERSION` is set, a HEAD request for `<base>/latest` must redirect to a final URL ending in `/tag/<tag>`: the installers read the tag from that URL. It must also serve `/download/<tag>/SHA256SUMS` and the platform archive under `/download/<tag>/`. |

Use only a mirror you trust. The installer checks the archive against the `SHA256SUMS` file from that same mirror.

### Start at login

Without `--service`, the server runs until the computer restarts (on Windows, until you sign out). With it:

- Linux: a systemd user unit, `~/.config/systemd/user/cook-router.service`, enabled and started. It runs while you are logged in; for a server that should run without a login session, run `loginctl enable-linger` once. Stop it with `systemctl --user disable --now cook-router`.
- macOS: a launchd agent, `~/Library/LaunchAgents/io.github.prep-cook.cook-router.plist`, which also restarts the server if it crashes. Stop it with `launchctl bootout gui/$(id -u)/io.github.prep-cook.cook-router` and delete the file.
- Windows: a `cook-router` entry under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. Ensure its command uses the same `--db` or `COOK_DB` as interactive starts. The working directory controls `.env` and relative paths, not an alternate configuration authority. Remove the entry with `Remove-ItemProperty HKCU:\Software\Microsoft\Windows\CurrentVersion\Run -Name cook-router`. `--log-file` and `--working-dir` remain available for a managed launch.

Once set up, later upgrades restart the server through the same mechanism. The System page checks for a new release only when clicked, with an anonymous HEAD request cached for 12 h. Set `COOK_ROUTER_NO_UPDATE_CHECK=1` (or `CLIPROXY_NO_UPDATE_CHECK=1`, its name before the rename) in the server's environment before starting it to disable these checks. Release checks use the configured `proxy-url`, or the environment proxy when none is set, and never send tokens or cookies; proxy credentials go only to your proxy, with TLS verification on and redirects off.

### Upgrading an install from before the rename

The project was called cliproxy-rs, and its binary `cliproxy`. Run the install script as before; it picks up the old install:

- Without `~/.cook-router`, it keeps using `~/.cliproxy-rs` (`%USERPROFILE%\.cliproxy-rs` on Windows). Its `keys.env` can retain the `CLIPROXY_*` names. Existing legacy YAML is imported once into `cook.db` there unless `COOK_DB` selects another database; YAML is retained as stale backup.
- It stops the old managed server and replaces start-at-login commands with the explicit database-backed launch. Back up legacy YAML/auth data before migration; never keep both binaries refreshing the same account's tokens.
- It installs `cook-router` next to the old binary and leaves `cliproxy` (on Windows, `%LOCALAPPDATA%\Programs\cliproxy-rs\cliproxy.exe`) in place; delete it yourself. The old `cliproxy.log` stays too; the server now logs to `cook-router.log`.

### Removing it

Stop the server (`kill $(cat ~/.cook-router/cook-router.pid)` or the service command above), then delete the binary. On Windows stop the intended instance using its service/process command and selected database path, not a stale YAML path. This leaves other instances alone. Your data directory contains the published SQLite snapshot, bootstrap files, keys and signed-in accounts; delete it only if no longer needed. Mutable databases live under OS tmp, and clean shutdown removes the instance's per-database temporary directory when its owning process exits. Logical deletion does not guarantee physical erasure from disk or backups.

## Homebrew

On macOS or Linux, install from the tap:

```sh
brew install vayungodara/tap/cliproxy-rs
brew services start cliproxy-rs
```

The formula downloads the release binary for Apple silicon, Intel macOS, Linux arm64 or Linux x86_64; it does not compile Rust. Linux needs glibc 2.35 or newer, as with the release archives. Homebrew may also install its own runtime dependencies on older Linux systems; these are separate from the cliproxy binary.

Homebrew uses `$(brew --prefix)/etc/cliproxy-rs/cook.db`. On first install it creates private bootstrap YAML and `keys.env`, then imports once; an existing database is retained. Its service uses the explicit database path. Change settings through the dashboard or resource export/import after initialization, not by editing retained YAML. A secret-inclusive JSON resource export preserves configuration semantics; use `config backup` for full database/credential recovery.

Open `http://127.0.0.1:8317/management.html` with `CLIPROXY_MANAGEMENT_KEY` from `keys.env`; tools use `CLIPROXY_CLIENT_KEY`. Choose the listen address/port before importing, or change it through `/admin/v1` and restart when required. Run the service as your own user, without `sudo`. Logs go to `$(brew --prefix)/var/log/cliproxy-rs.log`. Stop it with `brew services stop cliproxy-rs`; remove the binary with `brew uninstall cliproxy-rs`. Your database and keys remain until you delete them yourself.

For maintainers: add `HOMEBREW_TAP_TOKEN` to this repository's Actions secrets. Give that token contents write access to the tap only. Publishing a stable release renders `Formula/cliproxy-rs.rb` from the release's `SHA256SUMS` and commits it to the tap. Without the token, the job skips the update; prereleases do not update the formula. Publishing does not rerun the release builds. The template lives in [`packaging/homebrew/cliproxy-rs.rb`](../packaging/homebrew/cliproxy-rs.rb).

## Scoop

On Windows, install from the bucket:

```powershell
scoop bucket add vayungodara https://github.com/vayungodara/scoop-bucket
scoop install vayungodara/cliproxy-rs
```

Scoop installs the binary only. Initialize SQLite as in [First run without the install script](#first-run-without-the-install-script).

## From a release

Each [release](https://github.com/prep-cook/cook-router/releases) has an archive per platform and a `SHA256SUMS` file:

| Platform | Archive |
| --- | --- |
| Linux x86_64 | `cook-router-<version>-x86_64-unknown-linux-gnu.tar.gz` |
| Linux arm64 | `cook-router-<version>-aarch64-unknown-linux-gnu.tar.gz` |
| macOS Apple silicon | `cook-router-<version>-aarch64-apple-darwin.tar.gz` |
| macOS Intel | `cook-router-<version>-x86_64-apple-darwin.tar.gz` |
| Windows x86_64 | `cook-router-<version>-x86_64-pc-windows-msvc.zip` |

Check the download before you run it:

```sh
sha256sum --check --ignore-missing SHA256SUMS      # Linux
shasum -a 256 --check --ignore-missing SHA256SUMS  # macOS
```

On Windows, compare the output of `Get-FileHash cook-router-<version>-x86_64-pc-windows-msvc.zip` with the line in `SHA256SUMS`.

Unpack and put the binary on your `PATH`:

```sh
tar -xzf cook-router-<version>-x86_64-unknown-linux-gnu.tar.gz
sudo install -m 0755 cook-router-<version>-x86_64-unknown-linux-gnu/cook-router /usr/local/bin/cook-router
cook-router --version
```

The macOS binaries are not signed or notarized. If Gatekeeper blocks the first run, remove the quarantine flag with `xattr -d com.apple.quarantine /usr/local/bin/cook-router`.

The Linux binaries link against glibc and libstdc++ and run on current distributions (Debian 12, Ubuntu 22.04 and later, Fedora, Arch). For Alpine or other musl systems, build from source or use the Docker image.

## From source

For contributors, and for systems without a release binary such as Alpine or other musl systems. You need a Rust toolchain (stable, 1.88 or newer) and the tools to build BoringSSL: `cmake`, `clang` and `perl`. On Debian or Ubuntu:

```sh
sudo apt-get install -y build-essential cmake clang perl git
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

On macOS, `xcode-select --install` and `brew install cmake` are enough. On Windows, install Visual Studio Build Tools with the C++ workload, CMake, LLVM (bindgen needs `libclang`) and NASM (BoringSSL's x86_64 assembly), for example `choco install cmake llvm nasm`, and put NASM on `PATH`. The Windows build is produced by the release workflow and has not been tested by hand.

Then build:

```sh
git clone https://github.com/prep-cook/cook-router.git
cd cook-router
cargo build --release -p cook-router
./target/release/cook-router --version
```

The WebRTC media relay is an optional feature and is not part of the release binaries or the Docker image. To include it, build with `cargo build --release -p cook-router --features cpa-server/media-relay`.

The dashboard in `ui/dist` is committed, so Node is not needed for a normal build. To change the dashboard, see [ui/README.md](../ui/README.md); rebuild the UI before building the binary.

## Docker

The repository's `Dockerfile` builds the binary and copies it into a small Debian image that runs as an unprivileged user. The build compiles BoringSSL and needs about 2 GB of memory; on a small machine add `--build-arg BUILD_JOBS=1`.

```sh
docker build -t cook-router .
mkdir -m 700 -p data
$EDITOR data/config.yaml                  # initial import only; see below
sudo chown -R 10001:10001 data            # the container runs as uid and gid 10001
docker run -d --name cook-router -p 127.0.0.1:8317:8317 -v "$PWD/data:/data" cook-router --db /data/cook.db --config /data/config.yaml
```

The first bootstrap imports `/data/config.yaml`; later starts use `/data/cook.db`, not changes to the YAML. In the initial import:

- Set `server.host` to `""` or `0.0.0.0` so the server listens on the container's interface.
- Set `management.allow-remote: true` for the dashboard. Docker bridge requests are non-local; publishing on `127.0.0.1` as above still keeps other machines out.
- Point any legacy `oauth.auth-dir` at the private credential import source only; ongoing login and refresh state belongs to SQLite.

The image declares no `VOLUME`: mount `/data` as a persistent directory so published database snapshots survive replacement. Keep OS tmp writable for the private working database; it does not need persistent storage. Every acknowledged change is already in the published `/data/cook.db`, so losing tmp with the container only means the next start seeds a fresh working database from that file; a change reported as failed may be lost with it. A YAML-only mount, remote config store or unmounted container filesystem is insufficient. On Railway attach a Volume at `/data`; its volume ownership must permit writes by the service user (see [Railway permissions](https://docs.railway.com/volumes#permissions)). The image runs as UID/GID 10001. Older images up to 0.2.5 could create an anonymous `/data` volume; preserve/import its private legacy data before replacing it.

The service must write the snapshot directory for atomic replacement and its OS temporary directory for working databases. Keep both private; SQLite contains configuration secrets and OAuth tokens. Copy the `--db` file directly for a complete live backup, or use `config backup`. See [Database safety](CONFIGURATION.md#database-safety-and-backup). Publish on loopback unless other machines need access.

Browser sign-in inside a container needs the OAuth callback ports (54545 for Claude, 1455 for Codex) published to your machine, so it is usually easier to sign in from the dashboard and paste the final callback URL, or to use `--codex-device-login`, Kimi or Meta, which use device codes:

```sh
docker exec -it cook-router cook-router --management-base-url http://127.0.0.1:8317 --codex-device-login --no-browser
```

The running server owns `/data/cook.db`, so the sign-in goes through its management API and asks for the management key; `--db /data/cook.db` alone would be refused as `already owned`.

## First run without the install script

If you installed the binary another way, set it up by hand:

1. Create a private data directory (`mkdir -m 700 -p ~/.cook-router`), make two random keys (for example `openssl rand -hex 24`) and write a private bootstrap `config.yaml`:

   ```yaml
   server:
     host: "127.0.0.1"          # only this computer can connect
     port: 8317
   access:
     api-keys:
       - "PASTE-CLIENT-KEY"     # your tools send this key to the proxy
   management:
     secret-key: "PASTE-MANAGEMENT-KEY"  # the dashboard password
   ```

   Keep a private copy of the keys: SQLite stores the management key as a bcrypt hash. This YAML is an import/runtime projection shape, not the canonical persisted schema; [CONFIGURATION.md](CONFIGURATION.md) explains the settings. Keep the bootstrap file private while it exists.
2. Import once, then run the database-backed server:

   ```sh
   cook-router --db ~/.cook-router/cook.db config validate config.yaml
   cook-router --db ~/.cook-router/cook.db config import config.yaml
   cook-router --db ~/.cook-router/cook.db
   ```

   `--db` overrides `COOK_DB`; without either the default is `cook.db` beside `--config` (`config.yaml` by default). `--config FILE` is a first-bootstrap compatibility import selector only. A fresh ordinary startup needs that source; once initialized, the server does not read or watch it. Check `curl http://127.0.0.1:8317/healthz`, which answers `{"status":"ok"}`.
3. Connect accounts from `/management.html`, or from a terminal through the running server with `--management-base-url http://127.0.0.1:8317` (it reads the management key from `COOK_ROUTER_MANAGEMENT_KEY` or asks for it) and one of `--claude-login`, `--codex-login`, `--codex-device-login`, `--antigravity-login`, `--kimi-login`, `--kimi-ai-login`, `--meta-login`, `--xai-login` or `--devin-login`. Import a Vertex service account with `--vertex-import key.json`. Add `--no-browser` on a machine without a browser. With the server stopped, the same flags with `--db ~/.cook-router/cook.db` write the database directly. Sign-ins and refresh tokens are saved in SQLite, not a watched directory.

Change configuration through the dashboard or `/admin/v1`; old v0/v8 config endpoints are removed. Go-style single-dash flags still work. `RUST_LOG=debug` enables detailed logging; the default is `info`.

## Running as a system service

For a per-user service, use the install script's `--service`. On a Linux server, a system unit like this runs it under a dedicated user:

```ini
# /etc/systemd/system/cook-router.service
[Unit]
Description=cook-router
After=network-online.target
Wants=network-online.target

[Service]
User=cook-router
WorkingDirectory=/var/lib/cook-router
ExecStart=/usr/local/bin/cook-router --db /var/lib/cook-router/cook.db
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/cook-router /tmp

[Install]
WantedBy=multi-user.target
```

```sh
sudo useradd --system --home /var/lib/cook-router --create-home cook-router
sudo systemctl enable --now cook-router
journalctl -u cook-router -f
```

Initialize the database under `/var/lib/cook-router` before starting the service, using the service user. The persistent directory must be writable for atomic snapshot publication, and OS tmp must be writable for the private working database; keep both private and set `UMask=0077` in the unit as defense in depth. While the service runs, CLI changes go through its management API (`--management-base-url`); offline CLI writes wait for it to stop. Keep the same user and OS temporary directory across restarts so a surviving working database can resume; with `PrivateTmp=yes` every service restart, and with a tmpfs `/tmp` every reboot, cold-starts from the published file instead, which already holds every acknowledged change. Mount this directory persistently in ephemeral deployments. No legacy PostgreSQL/S3/git config authority or asynchronous YAML mirror replaces it. See [backup guidance](CONFIGURATION.md#database-safety-and-backup).

On Windows, to run it as a system service without a signed-in user, wrap it with a service manager such as NSSM.
