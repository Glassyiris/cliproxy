# Setting up cook-router with a coding agent

These are exact steps for a coding agent (Claude Code, Codex, Amp, Cursor's agent or similar) that is installing cook-router on a user's computer. A person can follow them too. Run every command on the user's machine, in order, and stop to ask the user wherever a step says so.

## Rules for the agent

- Never sign in to a provider account for the user, and never type, paste or read the user's passwords. Signing in is the user's step (step 7).
- Never print, log or repeat the management key or the client key. They live in `~/.cook-router/keys.env`; refer to that file instead.
- Do not stop, change or reconfigure an existing CLIProxyAPI (Go) or cook-router install unless the user asks you to migrate it (see the end of this page).
- Do not open the proxy to the internet. Keep `server.host` at `127.0.0.1`.
- Ask before setting up start at login (step 5).
- SQLite is the only durable config and OAuth credential authority. Select one persistent `--db`/`COOK_DB` path for bootstrap, server, sign-in commands and services; never keep editing an imported YAML file or share a watched auth directory with Go.
- Keep the data directory, published database, temporary working databases and backups private. The `--db` file can be copied directly while the service runs; each completed write atomically publishes a complete snapshot. `config backup` is also available. Config-history restore never restores revoked tokens.

## 1. Detect the system

```sh
uname -s; uname -m
```

| Output | Use |
|---|---|
| `Linux` with `x86_64` or `aarch64` | `install.sh` (step 3) |
| `Darwin` with `arm64` or `x86_64` | `install.sh` (step 3) |
| Windows (no `uname`, or `MINGW`/`MSYS` in its output) | `install.ps1` in PowerShell (step 3), or WSL with `install.sh` |
| anything else | build from source (step 3) |

## 2. Look for an existing install

```sh
command -v cook-router cli-proxy-api CLIProxyAPI 2>/dev/null
ls -d ~/.cook-router ~/.cli-proxy-api 2>/dev/null
curl -s -m 2 http://127.0.0.1:8317/healthz; echo " exit=$?"
```

- If `~/.cook-router/cook.db` (or the configured `COOK_DB`/`--db` path) exists, cook-router is already initialized. Ask before changing it. A remaining `config.yaml` may only be stale bootstrap input, not the current settings. If only legacy YAML exists, treat it as a migration, not proof of an initialized database.
- If `cli-proxy-api`/`CLIProxyAPI`, `~/.cli-proxy-api` or an existing listener is present, ask whether to migrate (see below) or install beside it using a different database and port. Never stop the existing server or import its real credentials without permission.

## 3. Install, configure and start

On macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/prep-cook/cook-router/master/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/prep-cook/cook-router/master/install.ps1 | iex
```

The installer:

1. Downloads the release binary, checks it against the release's checksums and installs it as `~/.local/bin/cook-router` (`%LOCALAPPDATA%\Programs\cook-router\cook-router.exe` on Windows).
2. Uses `COOK_DB` or `cook.db` in the selected install home, resolving it to an absolute path. If the database exists, it skips key generation and YAML import even if the original files are absent. Otherwise it imports legacy YAML once or creates private bootstrap YAML and `keys.env` without printing keys, then runs `config import`. The retained YAML is stale backup; later configuration and OAuth changes go only to SQLite.
3. Starts the server in the background, logging to `~/.cook-router/cook-router.log`, and waits for `/healthz`.

The installer prints addresses and locations, not keys. Every managed launch uses the same explicit absolute `--db`, and probes use the secret-free `config listener` command rather than stale YAML. On Windows, rollback to a binary without `--db` support disables sign-in launch and asks for a current release instead of restarting against stale YAML. If startup fails, inspect the private process log without printing secrets and fix the reported error.

`keys.env` looks like this, with real values:

```sh
COOK_ROUTER_PORT=8317
COOK_ROUTER_CLIENT_KEY=sk-...
COOK_ROUTER_MANAGEMENT_KEY=...
```

If there is no release binary for the system, build from source. That needs `git`, a Rust toolchain (`cargo`), `cmake`, `clang` and `perl`; ask the user before installing any of them. Then follow [the first run without the install script](INSTALL.md#first-run-without-the-install-script), writing the two keys into `~/.cook-router/keys.env` in the format above with `chmod 600`.

```sh
git clone https://github.com/prep-cook/cook-router.git ~/cook-router-src
cd ~/cook-router-src && cargo build --release -p cook-router
mkdir -p ~/.local/bin && install -m 0755 target/release/cook-router ~/.local/bin/cook-router
```

The installer starts a background process until restart/sign-out unless a service is configured. In a container or sandbox with a process manager, use that manager instead: stop the intended background instance and run `~/.local/bin/cook-router --db ~/.cook-router/cook.db` under it. Mount a persistent directory for the published database snapshot in an ephemeral container; keep OS tmp writable for its private working database.

## 4. Verify

```sh
. ~/.cook-router/keys.env
curl -fsS "http://127.0.0.1:$COOK_ROUTER_PORT/healthz"; echo
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $COOK_ROUTER_CLIENT_KEY" "http://127.0.0.1:$COOK_ROUTER_PORT/v1/models"
```

On Windows, in PowerShell:

```powershell
$k = @{}; Get-Content ~\.cook-router\keys.env | Where-Object { $_ -match '^(\w+)=(.*)$' } | ForEach-Object { $k[$Matches[1]] = $Matches[2] }
Invoke-RestMethod "http://127.0.0.1:$($k.COOK_ROUTER_PORT)/healthz"
(Invoke-WebRequest "http://127.0.0.1:$($k.COOK_ROUTER_PORT)/v1/models" -Headers @{ Authorization = "Bearer $($k.COOK_ROUTER_CLIENT_KEY)" } -UseBasicParsing).StatusCode
```

Expect `{"status":"ok"}` (PowerShell shows `status: ok`) and then `200`. A `401` means the supplied key does not match the database-backed client-key settings; do not compare it with stale import YAML or print either secret.

## 5. Start at login (only if the user wants it)

Ask the user first. If they agree, run the installer again with `--service`:

```sh
curl -fsSL https://raw.githubusercontent.com/prep-cook/cook-router/master/install.sh | sh -s -- --service
```

On Windows: `& ([scriptblock]::Create((irm https://raw.githubusercontent.com/prep-cook/cook-router/master/install.ps1))) -Service`. This adds a systemd user unit, launchd agent or Windows sign-in entry; verify the launch uses the same persistent database path as bootstrap. Do not create a second database accidentally through a changed working directory. [INSTALL.md](INSTALL.md#start-at-login) covers service behavior and removal.

## 6. Open the dashboard

If the user sits at this computer and it has a desktop:

```sh
. ~/.cook-router/keys.env
URL="http://127.0.0.1:$COOK_ROUTER_PORT/management.html"
(open "$URL" || xdg-open "$URL") >/dev/null 2>&1 || echo "Open $URL in a browser"
```

If no browser can open here (a server over SSH, a container, a remote sandbox), print the address and tell the user how to reach it from their own computer without exposing it to the internet:

- an SSH tunnel, run on their computer: `ssh -L 8317:127.0.0.1:8317 user@host` (use the port from `keys.env` on both sides), then open `http://127.0.0.1:8317/management.html` there;
- or [Tailscale](MULTI-ACCOUNT.md#reach-the-proxy-from-other-machines) on both machines.

Keep `server.host` on `127.0.0.1` for the tunnel. Never set it to `0.0.0.0` or `""` while `access.api-keys` is empty.

Tell the user: the management key to sign in with is the `COOK_ROUTER_MANAGEMENT_KEY` line in `~/.cook-router/keys.env`, which they can show with `cat ~/.cook-router/keys.env` in their own terminal.

## 7. Hand over the sign-in to the user

Tell the user to connect their accounts themselves, in the dashboard (Connect account) or in their own terminal. The running proxy owns its database, so a terminal sign-in goes through it:

```sh
set -a; . ~/.cook-router/keys.env; set +a
cook-router --management-base-url "http://127.0.0.1:$COOK_ROUTER_PORT" --claude-login
```

The command reads the management key from `COOK_ROUTER_MANAGEMENT_KEY`, or asks for it without echo if the variable is unset. Do not pass it with `--password`. Running a sign-in flag with only `--db` while the proxy runs fails with `already owned`.

(`--codex-login`, `--codex-device-login`, `--kimi-login`, `--meta-login`, `--xai-login` and `--devin-login` work the same way; add `--no-browser` on a machine without a browser.) Wait until the user says they are done. Point them to [Accounts and provider terms](../README.md#accounts-and-provider-terms). This setup is for one person using their own accounts on their own machines. Use provider-sanctioned integrations or API keys where available.

## 8. Point the user's tools at it

The dashboard's Use with tools dialog, on the Client keys page, has copy-paste settings with the address and key filled in, and [CLIENTS.md](CLIENTS.md) covers each tool. Ask the user which tools they use before changing their settings.

For Claude Code, this adds the proxy to the `env` block of `~/.claude/settings.json`, keeps a backup, and reads the key from `keys.env` so it never appears in the conversation:

```sh
set -a; . ~/.cook-router/keys.env; set +a
python3 - <<'PY'
import json, os, shutil
path = os.path.expanduser("~/.claude/settings.json")
os.makedirs(os.path.dirname(path), exist_ok=True)
data = {}
if os.path.exists(path):
    shutil.copy(path, path + ".bak")
    data = json.load(open(path))
data.setdefault("env", {}).update({
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:" + os.environ["COOK_ROUTER_PORT"],
    "ANTHROPIC_AUTH_TOKEN": os.environ["COOK_ROUTER_CLIENT_KEY"],
})
json.dump(data, open(path, "w"), indent=2)
print("updated", path)
PY
```

After the user has signed in, confirm with the `/v1/models` request from step 4: the list now includes their models.

## Tips for heavier use

- Several Claude or Codex accounts: see [MULTI-ACCOUNT.md](MULTI-ACCOUNT.md) for routing strategies and limits.
- Codex accounts: set credential metadata `"websockets": true` through account management, not an old file in `~/.cook-router/auth`.
- Session affinity: keep `routing.session-affinity: true` in database-backed config. The installer includes it in initial import settings.
- Other machines: use [Tailscale](https://tailscale.com/) instead of opening a port to the internet; see [Reach the proxy from other machines](MULTI-ACCOUNT.md#reach-the-proxy-from-other-machines). Never expose the proxy to the internet without client keys.

## Migrating from CLIProxyAPI

Only when the user asks for it:

1. Locate the Go server's YAML config, auth directory and service command. Export remote-store data to private local import files if necessary.
2. With the user's permission, stop Go before copying/importing credentials; back up YAML and the auth directory privately. Separate copies are not safe for concurrent use: token refresh by either server can invalidate the other's tokens.
3. Pick a private persistent SQLite path. Remove selected `PGSTORE_*`, `OBJECTSTORE_*` and `GITSTORE_*` backend variables from cook-router's environment: they now fail startup with a migration error, not an automatic remote fetch or YAML mirror.
4. Validate and import once: `cook-router --db /private/cook.db config validate /private/config.yaml`, then `cook-router --db /private/cook.db config import /private/config.yaml`. Use the configured legacy `oauth.auth-dir` only as a credential import source. Start with `cook-router --db /private/cook.db`; use that same path in all services and sign-in commands.
5. Verify with the imported port/client key, without printing secrets, and have the user check their accounts in the dashboard. Change later settings through the dashboard or `/admin/v1`; old v0/v8 config endpoints and YAML watchers are gone.

[MIGRATING-FROM-GO.md](MIGRATING-FROM-GO.md) describes credential import, rollback limitations and safe backup. `--config FILE` is first-bootstrap compatibility import only; a started SQLite install never rereads that file. Versioned plugin raw configuration and OAuth-only scope are preserved on import; review validation errors instead of assuming unsupported input was dropped.
