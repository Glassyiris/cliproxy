#!/usr/bin/env python3
"""Exercise installers against private, local release archives, never user accounts."""
import hashlib
import http.server
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import signal
import ssl
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.request
import zipfile


def capture(command, *, timeout=120, **kwargs):
    # Children launched by PowerShell can inherit a pipe and keep communicate()
    # blocked after the shell exits. A file keeps output without waiting for EOF.
    # No fixture reads stdin. Do not let Windows PowerShell inherit the runner's
    # still-open input stream while stdout goes to a file.
    kwargs.setdefault("stdin", subprocess.DEVNULL)
    with tempfile.TemporaryFile(mode="w+", encoding="utf-8", errors="replace") as output:
        try:
            result = subprocess.run(command, stdout=output, stderr=subprocess.STDOUT,
                                    timeout=timeout, **kwargs)
        except subprocess.TimeoutExpired:
            output.seek(0)
            print(output.read(), file=sys.stderr)
            raise
        output.seek(0)
        return subprocess.CompletedProcess(command, result.returncode, output.read())


def main():
    binary = Path(sys.argv[1]).resolve()
    repo = Path(__file__).resolve().parents[2]
    windows = os.name == "nt"
    version = subprocess.check_output([binary, "--version"], text=True, timeout=20).splitlines()[-1].split()[-1]
    target = {
        ("Linux", "x86_64"): "x86_64-unknown-linux-gnu",
        ("Linux", "aarch64"): "aarch64-unknown-linux-gnu",
        ("Darwin", "arm64"): "aarch64-apple-darwin",
        ("Darwin", "x86_64"): "x86_64-apple-darwin",
        ("Windows", "AMD64"): "x86_64-pc-windows-msvc",
    }[(platform.system(), platform.machine())]
    exe = "cook-router.exe" if windows else "cook-router"
    requests = []

    with tempfile.TemporaryDirectory(prefix="installer-test-") as tmp:
        root = Path(tmp)
        releases = root / "releases"
        releases.mkdir()

        def package(tag, source):
            name = f"cook-router-{tag.removeprefix('v')}-{target}"
            directory = root / name
            directory.mkdir()
            shutil.copy2(source, directory / exe)
            download = releases / "download" / tag
            download.mkdir(parents=True)
            archive = download / (name + (".zip" if windows else ".tar.gz"))
            if windows:
                with zipfile.ZipFile(archive, "w") as z:
                    z.write(directory / exe, f"{name}/{exe}")
            else:
                with tarfile.open(archive, "w:gz") as t:
                    t.add(directory, arcname=name)
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            (download / "SHA256SUMS").write_text(f"{digest}  {archive.name}\n")

        package(f"v{version}", binary)
        if windows:
            package("v999.1.0", binary)
        else:
            wrapper = root / "version-wrapper"
            wrapper.write_text(f'#!/bin/sh\nif [ "$1" = --version ]; then echo "cook-router 999.1.0"; else exec {shlex.quote(str(binary))} "$@"; fi\n')
            wrapper.chmod(0o755)
            package("v999.1.0", wrapper)
        fixtures = repo / "target/installer-fixtures"
        hanging = fixtures / ("hanging" + (".exe" if windows else ""))
        package("v999.3.0", hanging)
        if windows:
            legacy = fixtures / "legacy.exe"
            package("v999.0.0", legacy)
            package("v999.4.0", fixtures / "plain-health.exe")
        if not windows:
            bad = root / "broken"
            bad.write_text('#!/bin/sh\ncase "$1" in --version) echo "cook-router 999.2.0";; --help) echo "--db PATH";; *) case " $* " in *" config "*) exec "$INSTALLER_REAL_BINARY" "$@";; *) exit 1;; esac;; esac\n')
            bad.chmod(0o755)
            package("v999.2.0", bad)

        class Releases(http.server.SimpleHTTPRequestHandler):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, directory=root, **kwargs)

            def do_HEAD(self):
                requests.append(self.path)
                if self.path == "/releases/latest":
                    self.send_response(302)
                    self.send_header("Location", f"/releases/tag/v{version}")
                    self.end_headers()
                elif self.path == f"/releases/tag/v{version}":
                    self.send_response(200)
                    self.end_headers()
                else:
                    super().do_HEAD()

            def do_GET(self):
                requests.append(self.path)
                super().do_GET()

            def log_message(self, *_):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Releases)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        home = root / "private home"
        bindir = root / "private bin"
        # PSModuleAnalysisCachePath points Windows PowerShell at the runner image's module
        # cache. Without it, each powershell.exe spends about 22 s indexing every installed
        # module before its first command.
        env = {k: v for k, v in os.environ.items() if k.upper() in {
            "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP",
            "PROCESSOR_ARCHITECTURE", "PROCESSOR_ARCHITEW6432", "PSMODULEANALYSISCACHEPATH",
        }}
        env.update({"HOME": str(root), "USERPROFILE": str(root), "LOCALAPPDATA": str(root),
               "COOK_ROUTER_RELEASES": f"http://127.0.0.1:{server.server_port}/releases",
               "COOK_ROUTER_HOME": str(home), "COOK_ROUTER_INSTALL_DIR": str(bindir),
               "COOK_ROUTER_NO_OPEN": "1", "COOK_ROUTER_NO_UPDATE_CHECK": "1"})
        env["INSTALLER_REAL_BINARY"] = str(binary)
        # Catalog fetches cannot leave loopback even on native runners without namespaces.
        env.update(HTTP_PROXY="http://127.0.0.1:9", HTTPS_PROXY="http://127.0.0.1:9",
                   ALL_PROXY="http://127.0.0.1:9", NO_PROXY="127.0.0.1,localhost,::1")
        original_run = None

        def ps(code, check=True, cwd=None):
            entered = root / "powershell-entered"
            entered.unlink(missing_ok=True)
            path = str(entered).replace("'", "''")
            prelude = f"[IO.File]::WriteAllText('{path}','entered'); "
            finished = f"; [IO.File]::WriteAllText('{path}','finished')"
            began = time.monotonic()
            try:
                result = capture(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", prelude + code + finished], env=env, cwd=cwd, timeout=120)
            except subprocess.TimeoutExpired:
                phase = entered.read_text() if entered.exists() else "not entered"
                print(f"PowerShell helper phase: {phase}", file=sys.stderr)
                raise
            elapsed = time.monotonic() - began
            if elapsed > 10:
                print(f"PowerShell helper completed in {elapsed:.1f}s", file=sys.stderr)
            if check:
                if result.returncode:
                    print(result.stdout, file=sys.stderr)
                assert result.returncode == 0, result.stdout
            return result.stdout.strip()

        def install(*args, success=True, pipe=False):
            if windows:
                if pipe:
                    script = str(repo / "install.ps1").replace("'", "''")
                    command = ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", f"$ErrorActionPreference='Stop'; Get-Content -Raw '{script}' | Invoke-Expression"]
                else:
                    shell = "pwsh.exe" if "-Service" in args else "powershell.exe"
                    command = [shell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(repo / "install.ps1"), *args]
            else:
                command = ["sh", str(repo / "install.sh"), *args]
            result = capture(command, env=env)
            assert (result.returncode == 0) == success, result.stdout
            return result.stdout

        def health():
            for _ in range(40):
                try:
                    with urllib.request.urlopen("http://127.0.0.1:8317/healthz", timeout=2) as r:
                        assert r.status == 200
                    return
                except OSError:
                    time.sleep(0.25)
            raise AssertionError("server not healthy")

        def pid():
            return int((home / "cook-router.pid").read_text().strip())

        def stop_owner():
            """A running server owns cook.db and refuses offline writes, so stop the one
            this test started; the next install() starts it again."""
            pidfile = home / "cook-router.pid"
            try:
                running = int(pidfile.read_text().strip())
            except (FileNotFoundError, ValueError):
                return
            if running <= 0:
                return
            if windows:
                ps(f"Stop-Process -Id {running} -ErrorAction SilentlyContinue; Wait-Process -Id {running} -ErrorAction SilentlyContinue", check=False)
                return
            try:
                os.kill(running, signal.SIGTERM)
            except ProcessLookupError:
                return
            for _ in range(80):
                try:
                    os.kill(running, 0)
                except ProcessLookupError:
                    return
                time.sleep(0.25)
            raise AssertionError(f"server {running} did not stop")

        def commit_config(text):
            """Write committed settings through the supported offline import, retaining
            stale YAML backup."""
            with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", dir=root, delete=False) as source:
                source.write(text)
                path = Path(source.name)
            try:
                stop_owner()
                result = capture([binary, "--db", home / "cook.db", "config", "import", path], env=env)
                assert result.returncode == 0, f"fixture config import failed: {result.stdout}"
            finally:
                path.unlink()

        def migrate_windows():
            """A pre-rename YAML-only home becomes a DB install without replacing its keys."""
            user = root / "legacy-windows"
            old_home = user / ".cliproxy-rs"
            (old_home / "auth").mkdir(parents=True)
            auth = str(old_home / "auth").replace("'", "''")
            legacy_yaml = f"server:\n  host: '127.0.0.1'\n  port: 8322\naccess:\n  api-keys:\n    - sk-legacy\nmanagement:\n  secret-key: legacy\noauth:\n  auth-dir: '{auth}'\n"
            (old_home / "config.yaml").write_text(legacy_yaml)
            legacy_keys = "CLIPROXY_PORT=8322\nCLIPROXY_CLIENT_KEY=sk-legacy\nCLIPROXY_MANAGEMENT_KEY=legacy\n"
            (old_home / "keys.env").write_text(legacy_keys)
            saved = env.copy()
            try:
                env.pop("COOK_ROUTER_HOME")
                env.pop("COOK_ROUTER_INSTALL_DIR")
                env.update(USERPROFILE=str(user), LOCALAPPDATA=str(user / "AppData/Local"), COOK_ROUTER_VERSION="v999.1.0")
                output = install()
                assert f"Using {old_home} from before the rename" in output, output
                assert (old_home / "cook.db").is_file() and not (user / ".cook-router").exists()
                assert (old_home / "config.yaml").read_text() == legacy_yaml
                assert (old_home / "keys.env").read_text() == legacy_keys
                with urllib.request.urlopen("http://127.0.0.1:8322/healthz", timeout=5) as response:
                    assert response.status == 200
            finally:
                marker = old_home / "cook-router.pid"
                if marker.exists():
                    ps(f"Stop-Process -Id {int(marker.read_text().strip())} -ErrorAction SilentlyContinue", check=False)
                env.clear()
                env.update(saved)

        def migrate(tag):
            """An install from before the rename: ~/.cliproxy-rs, CLIPROXY_* settings, a cliproxy
            binary and its server, once in the background and once as a login service."""
            darwin = platform.system() == "Darwin"
            for port, as_service in ((8320, False), (8321, True)):
                user = root / f"legacy-{port}"
                old_home, local = user / ".cliproxy-rs", user / ".local/bin"
                (old_home / "auth").mkdir(parents=True)
                local.mkdir(parents=True)
                (old_home / "config.yaml").write_text(
                    f'config-version: 8\nserver:\n  host: "127.0.0.1"\n  port: {port}\naccess:\n  api-keys:\n'
                    f'    - "sk-legacy"\nmanagement:\n  secret-key: "legacy"\noauth:\n  auth-dir: "{old_home / "auth"}"\n')
                (old_home / "keys.env").write_text(f"CLIPROXY_PORT={port}\nCLIPROXY_CLIENT_KEY=sk-legacy\nCLIPROXY_MANAGEMENT_KEY=legacy\n")
                old_bin = local / "cliproxy"
                shutil.copy2(binary, old_bin)
                legacy = {k: v for k, v in env.items() if not k.startswith(("COOK_ROUTER_", "CLIPROXY_"))}
                legacy.update(HOME=str(user), CLIPROXY_RELEASES=env["COOK_ROUTER_RELEASES"], CLIPROXY_VERSION=tag,
                              CLIPROXY_NO_OPEN="1", COOK_ROUTER_NO_UPDATE_CHECK="1")
                with (old_home / "cliproxy.log").open("ab") as out:
                    imported = capture([old_bin, "--db", old_home / "legacy-live.db", "config", "import", old_home / "config.yaml"], env=legacy)
                    assert imported.returncode == 0, "legacy server fixture import failed"
                    old = subprocess.Popen([old_bin, "--db", old_home / "legacy-live.db", "--config", old_home / "config.yaml"], cwd=old_home, env=legacy,
                                           stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT)
                # Reap the old server as soon as it exits, as init would: the service shims wait on
                # `kill -0`, and macOS runners refuse `ps`, so a zombie would never look gone.
                threading.Thread(target=old.wait, daemon=True).start()
                new_pid = None
                try:
                    if as_service:
                        old_unit = (user / "Library/LaunchAgents/io.github.vayungodara.cliproxy-rs.plist" if darwin
                                    else user / ".config/systemd/user/cliproxy.service")
                        new_unit = (user / "Library/LaunchAgents/io.github.prep-cook.cook-router.plist" if darwin
                                    else user / ".config/systemd/user/cook-router.service")
                        old_unit.parent.mkdir(parents=True)
                        old_unit.write_text("old unit\n")
                        (user / "old-service.pid").write_text(str(old.pid))
                        mocks = user / "service-mocks"
                        mocks.mkdir()
                        shim = mocks / ("launchctl" if darwin else "systemctl")
                        shim.write_text('''#!/bin/sh
echo "$*" >> "$HOME/calls.log"
case "$*" in
  *cliproxy.service*|*vayungodara.cliproxy-rs*)
    case "$*" in *stop*|bootout*)
      # As systemd and launchd do, return once the old server has exited (a zombie has).
      old=$(cat "$HOME/old-service.pid"); kill "$old"
      while kill -0 "$old" 2>/dev/null && ! ps -p "$old" -o stat= | grep -q Z; do sleep 0.2; done ;;
    esac
    exit 0 ;;
  *show-environment*|*daemon-reload*|*enable*) exit 0 ;;
  print*|*is-active*)
    if [ -f "$HOME/service.pid" ] && kill -0 "$(cat "$HOME/service.pid")" 2>/dev/null; then
      echo 'state = running'; exit 0
    fi
    exit 1 ;;
  bootstrap*|kickstart*|*restart*)
    (cd "$HOME/.cliproxy-rs" && exec nohup "$HOME/.local/bin/cook-router" --db "$HOME/.cliproxy-rs/cook.db" </dev/null >>"$HOME/.cliproxy-rs/cook-router.log" 2>&1) &
    echo $! > "$HOME/service.pid" ;;
  *) exit 1 ;;
esac
''')
                        shim.chmod(0o755)
                        legacy["PATH"] = str(mocks) + os.pathsep + env["PATH"]
                    else:
                        (old_home / "cliproxy.pid").write_text(str(old.pid))
                    for _ in range(40):
                        try:
                            with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=2):
                                break
                        except OSError:
                            time.sleep(0.25)
                    # The running server hashes the plain secret-key in config.yaml at start-up; the
                    # installer must leave what it finds as it is.
                    before = [(old_home / f).read_bytes() for f in ("config.yaml", "keys.env")]
                    result = capture(["sh", str(repo / "install.sh")], env=legacy)
                    output = result.stdout
                    marker = user / "service.pid" if as_service else old_home / "cook-router.pid"
                    if marker.exists():
                        new_pid = int(marker.read_text().strip())
                    assert result.returncode == 0, output
                    assert f"Using {old_home} from before the rename" in output, output
                    assert f"{old_bin} from before the rename is no longer used" in output, output
                    assert "sign in with CLIPROXY_MANAGEMENT_KEY" in output, output
                    old.wait(timeout=20)
                    assert not (user / ".cook-router").exists() and old_bin.exists() and (local / "cook-router").exists()
                    assert [(old_home / f).read_bytes() for f in ("config.yaml", "keys.env")] == before
                    assert (old_home / "cook.db").is_file(), "legacy YAML was not imported"
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=5) as response:
                        assert response.status == 200
                    if as_service:
                        calls = (user / "calls.log").read_text()
                        stopped = "bootout gui/" if darwin else "--user stop cliproxy.service"
                        assert stopped in calls, calls
                        assert darwin or "--user disable --quiet cliproxy.service" in calls, calls
                        assert not old_unit.exists() and str(local / "cook-router") in new_unit.read_text()
                        assert "--db" in new_unit.read_text() and "config.yaml" not in new_unit.read_text()
                        assert f"Removed {old_unit}" in output, output
                    else:
                        assert not (old_home / "cliproxy.pid").exists()
                finally:
                    if old.poll() is None:
                        old.terminate()
                        old.wait(timeout=10)
                    if new_pid:
                        subprocess.run(["kill", str(new_pid)], check=False, timeout=10)

        try:
            process_log = root / "process.log"
            process_log.write_text("keep existing log\n")
            failed = capture([binary, "--config", str(root / "missing-config.yaml"),
                                     "--log-file", process_log, "--local-model"], cwd=root, env=env,
                                    timeout=20)
            assert failed.returncode != 0
            logged = process_log.read_text()
            assert logged.startswith("keep existing log\n") and "config" in logged[len("keep existing log\n"):], logged
            if windows:
                original_run = ps("$e=(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue).'cook-router'; if($e){$e}")
                # Explicit OWNER RIGHTS must not survive on a pre-existing home;
                # removing inherited ACEs alone does not remove explicit grants.
                print(ps("$ErrorActionPreference='Stop'; New-Item -ItemType Directory -Path $env:COOK_ROUTER_HOME | Out-Null; "
                         "$acl=Get-Acl $env:COOK_ROUTER_HOME; $sid=New-Object Security.Principal.SecurityIdentifier('S-1-3-4'); "
                         "$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))); "
                         "Set-Acl $env:COOK_ROUTER_HOME $acl; Write-Output \"Before install: $((Get-Acl $env:COOK_ROUTER_HOME).Sddl)\""))
            else:
                # A process can exit between a liveness check and either signal.
                # An actual signal failure against a live PID must still fail.
                marker = root / "signal-test.pid"
                for phase in ("term", "kill"):
                    for state in ("exited", "alive"):
                        marker.write_text("4242\n")
                        result = capture(["sh", "-c", '''
eval "$(sed '$d' "$1")"
pidfile=$2; phase=$3; expected=$4; killed=0
managed_pid() { pid=4242; return 0; }
pid_running() { [ "$killed" = 0 ] || [ "$expected" = alive ]; }
sleep() { :; }
kill() {
  if [ "$phase" = term ] || [ "$1" = -KILL ]; then killed=1; return 1; fi
  return 0
}
if stop_pidfile; then exit 0; else exit 1; fi
''', "signal-test", repo / "install.sh", marker, phase, state], env=env)
                        assert result.returncode == (0 if state == "exited" else 1), result.stdout
                        assert marker.exists() == (state == "alive")
                assert "not installed" in install("--check")
                assert not home.exists() and not bindir.exists()
                assert not any("/download/" in r for r in requests)
            # Probe normalization reads committed settings, never the YAML backup.
            probe_config = root / "probe-only.yaml"
            probe_config.write_text('server:\n  host: "[::]"\n  port: 8317\n  tls:\n    enable: true\n')
            probe_db = root / "probe-only.db"
            imported = capture([binary, "--db", probe_db, "config", "import", probe_config], env=env)
            assert imported.returncode == 0, "probe fixture import failed"
            if windows:
                script = str(repo / "install.ps1").replace("'", "''")
                test_db = str(probe_db).replace("'", "''")
                image = str(binary).replace("'", "''")
                base = ps(f"$ErrorActionPreference='Stop'; $code=(Get-Content -Raw '{script}') -replace '(?m)^Install-CookRouter -Service.*$', ''; . ([scriptblock]::Create($code)); (Get-CookRouterProbe '{image}' '{test_db}').Base; " + f'''
$invalid=Join-Path (Split-Path $env:COOK_ROUTER_HOME) 'invalid-import'
New-Item -ItemType Directory -Path $invalid | Out-Null
$config=Join-Path $invalid 'config.yaml'
[IO.File]::WriteAllText($config, 'server: [')
$failure=$null
try {{ Initialize-CookRouterHome $invalid $config (Join-Path $invalid 'keys.env') (Join-Path $invalid 'cook.db') '{image}' | Out-Null }} catch {{ $failure=$_.Exception.Message }}
if($failure -notlike '*could not import*keep config.yaml and retry*'){{throw "import hid its recovery message: $failure"}}
if($ErrorActionPreference -ne 'Stop'){{throw 'import changed the error preference'}}
$log=Join-Path $invalid 'cook-router.log'
if((Get-Item $log).Length -eq 0 -or [IO.File]::ReadAllBytes($log) -contains 0){{throw 'import log is empty or UTF-16'}}
''' + r'''
$dir='C:\private bin'
$db='C:\private home\cook.db'
function Get-CimInstance {
  @('cook-router --db "C:\private home\cook.db"',
    'cook-router --db "C:\private home\cook.db2"',
    'cook-router --db C:\db\cook.db',
    'cook-router --db C:\db\cook.db2',
    'cook-router --log-file "C:\private home\cook.db"',
    'cook-router --config "C:\private home\config.yaml"',
    $null) | ForEach-Object { [pscustomobject]@{Name='cook-router.exe'; ExecutablePath='C:\private bin\cook-router.exe'; CommandLine=$_} }
}
$selected=@(Get-CookRouterServers $dir 'C:\private home\config.yaml' -db $db)
if($selected.Count -ne 2 -or $selected[0].CommandLine -ne 'cook-router --db "C:\private home\cook.db"'){throw 'quoted database argument was not matched exactly'}
$selected=@(Get-CookRouterServers $dir 'C:\other\config.yaml' -db 'C:\db\cook.db')
if($selected.Count -ne 1 -or $selected[0].CommandLine -ne 'cook-router --db C:\db\cook.db'){throw 'unquoted database argument was not matched exactly'}
$script:removed=@()
function Get-ChildItem {
  [pscustomobject]@{Name='cook-router.prev-keep.exe'; FullName='/long/path/cook-router.prev-keep.exe'}
  [pscustomobject]@{Name='cook-router.prev-old.exe'; FullName='/long/path/cook-router.prev-old.exe'}
}
function Remove-Item { param($LiteralPath,[switch]$Force,$ErrorAction); $script:removed += $LiteralPath }
Remove-CookRouterImages '/short/path' '/short/path/cook-router.prev-keep.exe'
if($script:removed.Count -ne 1 -or $script:removed[0] -ne '/long/path/cook-router.prev-old.exe'){
  throw "cleanup removed the rollback image through a directory alias: $script:removed"
}
''')
            else:
                code = (repo / "install.sh").read_text().removesuffix('main "$@"\n')
                base = capture(["sh", "-c", code + '\nbin=$1; db=$2; log=$3; read_probe; printf "%s" "$base"', "sh", binary, probe_db, root / "probe.log"], env=env).stdout
            assert base.strip() == "https://[::1]:8317", base
            first_output = install(pipe=windows)
            assert (home / "cook.db").is_file(), "fresh install did not create its database"
            health()
            keys = dict(line.split("=", 1) for line in (home / "keys.env").read_text().splitlines() if line.startswith("COOK_ROUTER_"))
            assert all(value not in first_output for key, value in keys.items() if key.endswith("_KEY")), "installer printed a key"
            # The dashboard page alone is not enough: on Windows its nested scripts,
            # styles and fonts once returned 404, leaving the page blank.
            with urllib.request.urlopen("http://127.0.0.1:8317/management.html", timeout=5) as response:
                assert (response.status, response.headers.get_content_type()) == (200, "text/html")
                page = response.read().decode()
            # ponytail: the page's own double-quoted src and href values only; follow url()
            # and import() in the fetched CSS and JS too if the build starts splitting chunks.
            referenced = re.findall(r'(?:src|href)="\./([^"]+)"', page)
            assert {".js", ".css", ".woff2"} <= {Path(r).suffix for r in referenced if "/" in r}, referenced
            types = {".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml"}
            failures = []
            for reference in referenced:
                try:
                    with urllib.request.urlopen("http://127.0.0.1:8317/" + reference, timeout=5) as response:
                        served = response.status, response.headers.get_content_type(), bool(response.read())
                except urllib.error.HTTPError as error:
                    served = error.code, None, False
                if served != (200, types.get(Path(reference).suffix), True):
                    failures.append((reference, served))
            assert not failures, failures
            for path, key, expected in [
                ("/v1/models", None, 401),
                ("/v1/models", keys["COOK_ROUTER_CLIENT_KEY"], 200),
                ("/admin/v1/effective/config", keys["COOK_ROUTER_MANAGEMENT_KEY"], 200),
                ("/assets/missing.js", None, 404),
            ]:
                request = urllib.request.Request("http://127.0.0.1:8317" + path)
                if key:
                    request.add_header("Authorization", "Bearer " + key)
                try:
                    with urllib.request.urlopen(request, timeout=5) as response:
                        code = response.status
                except urllib.error.HTTPError as error:
                    code = error.code
                assert code == expected, (path, code)
            if windows:
                print(ps("$ErrorActionPreference='Stop'; $me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; "
                   "foreach($p in @($env:USERPROFILE, $env:COOK_ROUTER_HOME, \"$env:COOK_ROUTER_HOME\\keys.env\")){ "
                   "$acl=Get-Acl -LiteralPath $p; Write-Output \"ACL $p $($acl.Sddl)\"; "
                   "$acl.Access | Format-Table IdentityReference,AccessControlType,IsInherited | Out-String | Write-Output }; "
                   "$who=(Get-Acl \"$env:COOK_ROUTER_HOME\\keys.env\").GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]).IdentityReference.Value; "
                   "if($who | Where-Object { $_ -notin $me, 'S-1-5-18', 'S-1-5-32-544' }){throw \"keys readable by others: $who\"}"))
            else:
                assert (home / "keys.env").stat().st_mode & 0o777 == 0o600
            if windows:
                # An oldest rotation opened without delete sharing cannot be
                # removed on Windows, even if Rust ignores its read-only bit.
                # Startup must keep its budget and prune other eligible files.
                locked = home / "cook-router-2001-09-09T01-46-40.000.log"
                removable = home / "cook-router-2001-09-09T01-46-41.000.log"
                for rotation, seconds in ((locked, 1_000_000_000), (removable, 1_000_000_001)):
                    with rotation.open("wb") as output:
                        output.truncate(33 * 1024 * 1024)
                    os.utime(rotation, (seconds, seconds))
                locked.chmod(0o444)
                reader = locked.open("rb")
                try:
                    install()
                    health()
                    assert locked.exists() and not removable.exists(), "a locked rotation must not block cleanup of other logs"
                    assert (home / "cook-router.log").stat().st_size > 0, "pruning must preserve the active process log"
                    print("PASS Windows: locked process rotation skipped; remaining rotations pruned")
                finally:
                    reader.close()
                    for rotation in (locked, removable):
                        try:
                            if rotation.exists():
                                rotation.chmod(0o600)
                                rotation.unlink()
                        except OSError as error:
                            print(f"Best-effort rotation cleanup: {error}", file=sys.stderr)
            before = [(home / f).read_bytes() for f in ("config.yaml", "keys.env")]
            old_pid = pid()
            old_inode = (bindir / exe).stat().st_ino
            if not windows:
                requests.clear()
                assert "already current" in install("--check")
                assert "already current" in install()
                assert pid() != old_pid, "setup must refresh DB startup arguments even at the current version"
                old_pid = pid()
                assert (bindir / exe).stat().st_ino == old_inode
                assert not any("/download/" in r for r in requests)
            env["COOK_ROUTER_VERSION"] = "v999.1.0"
            install("-BinaryOnly" if windows else "--binary-only")
            health()
            assert pid() == old_pid, "binary-only must leave the old server running"
            if not windows:
                assert (bindir / "cook-router.prev").stat().st_ino == old_inode
                requests.clear()
            install()
            health()
            assert pid() != old_pid
            assert [(home / f).read_bytes() for f in ("config.yaml", "keys.env")] == before
            # An existing DB is sufficient even after both import artifacts are removed.
            # The installer must neither regenerate credentials nor import defaults.
            config_backup = home / "saved-config.yaml"
            keys_backup = home / "saved-keys.env"
            (home / "config.yaml").rename(config_backup)
            (home / "keys.env").rename(keys_backup)
            committed = capture([binary, "--db", home / "cook.db", "config", "export", "--secrets"], env=env)
            assert committed.returncode == 0, "existing database export failed"
            try:
                os.utime(bindir / exe, None)
                install()
                health()
                assert not (home / "config.yaml").exists() and not (home / "keys.env").exists(), "existing DB regenerated import files"
                after_export = capture([binary, "--db", home / "cook.db", "config", "export", "--secrets"], env=env)
                assert after_export.returncode == 0 and after_export.stdout == committed.stdout, "existing DB settings or keys changed"
            finally:
                config_backup.rename(home / "config.yaml")
                keys_backup.rename(home / "keys.env")
            if not windows:
                assert not any("/download/" in r for r in requests), "current on-disk upgrade must restart without downloading"
                restarted = pid()
                assert "already current" in install()
                assert pid() != restarted
                restarted = pid()
                subprocess.run(["kill", str(restarted)], check=True, timeout=10)
                time.sleep(2)
                install()
                health()
                assert pid() != restarted, "a stopped current binary must start again"
                # Linux uses procfs without procps; Darwin confirms names with
                # non-setuid pgrep when ps cannot even inspect its own shell.
                shimdir = root / "no-ps"
                shimdir.mkdir()
                original_path = env["PATH"]
                env["PATH"] = str(shimdir) + os.pathsep + original_path
                try:
                    for refused in (1, 126, 127):
                        (shimdir / "ps").write_text(f"#!/bin/sh\nexit {refused}\n")
                        (shimdir / "ps").chmod(0o755)
                        previous_pid = pid()
                        os.utime(bindir / exe, None)
                        install()
                        health()
                        assert pid() != previous_pid, f"ps status {refused} must not skip stopping the old server"
                        subprocess.run(["kill", str(pid())], check=True, timeout=10)
                        time.sleep(2)
                        unrelated = subprocess.Popen(["sleep", "120"], env=env)
                        try:
                            (home / "cook-router.pid").write_text(str(unrelated.pid))
                            os.utime(bindir / exe, None)
                            install()
                            health()
                            assert unrelated.poll() is None, f"ps status {refused} on {platform.system()} must never signal an unrelated stale PID"
                        finally:
                            unrelated.terminate()
                            unrelated.wait(timeout=10)
                finally:
                    env["PATH"] = original_path
            second = root / "second"
            env.update(COOK_ROUTER_HOME=str(second), COOK_DB=str(second / "alternate.db"))
            try:
                install()
                assert (second / "alternate.db").is_file() and not (second / "cook.db").exists(), "COOK_DB was not honored"
                assert "COOK_ROUTER_PORT=8318" in (second / "keys.env").read_text()
                with urllib.request.urlopen("http://127.0.0.1:8318/healthz", timeout=5) as response:
                    assert response.status == 200
                second_pid = int((second / "cook-router.pid").read_text().strip())
                env.pop("COOK_DB")
                env.update(COOK_ROUTER_HOME=str(home))
                if windows:
                    # Simulate a stale PID reused by another config sharing the
                    # binary; the command-line match must still protect it.
                    (home / "cook-router.pid").write_text(str(second_pid))
                install()
                health()
                with urllib.request.urlopen("http://127.0.0.1:8318/healthz", timeout=5) as response:
                    assert response.status == 200, "upgrading one config must not stop another config sharing the binary"
                health()
            finally:
                try:
                    if (second / "cook-router.pid").exists():
                        second_pid = int((second / "cook-router.pid").read_text().strip())
                        if windows:
                            ps(f"Stop-Process -Id {second_pid} -ErrorAction SilentlyContinue", check=False)
                        else:
                            subprocess.run(["kill", str(second_pid)], check=False, timeout=10)
                except (OSError, ValueError, subprocess.SubprocessError) as error:
                    print(f"Best-effort cleanup: {error}", file=sys.stderr)
                env.pop("COOK_DB", None)
                env.update(COOK_ROUTER_HOME=str(home))
            if not windows:
                # A service command fails once after the swap; rollback must restart and
                # verify the previous image rather than losing it through `set -e`.
                mockbin = root / "service-mocks"
                mockbin.mkdir()
                shim = mockbin / ("launchctl" if platform.system() == "Darwin" else "systemctl")
                shim.write_text('''#!/bin/sh
case "$*" in
  *show-environment*|*daemon-reload*|*enable*) exit 0 ;;
  print*|*is-active*)
    if [ -f "$COOK_ROUTER_HOME/service.pid" ] && kill -0 "$(cat "$COOK_ROUTER_HOME/service.pid")" 2>/dev/null; then
      echo 'state = running'; exit 0
    fi
    exit 1 ;;
  bootstrap*|kickstart*|*restart*)
    if [ -f "$COOK_ROUTER_HOME/fail-service-once" ]; then
      rm "$COOK_ROUTER_HOME/fail-service-once"; echo 'injected service failure' >&2; exit 1
    fi
    (cd "$COOK_ROUTER_HOME" && exec nohup "$COOK_ROUTER_INSTALL_DIR/cook-router" --db "$COOK_ROUTER_HOME/cook.db" </dev/null >>"$COOK_ROUTER_HOME/cook-router.log" 2>&1) &
    echo $! > "$COOK_ROUTER_HOME/service.pid" ;;
  *) exit 1 ;;
esac
''')
                shim.chmod(0o755)
                (home / "fail-service-once").touch()
                original_path = env["PATH"]
                env["PATH"] = str(mockbin) + os.pathsep + original_path
                env["COOK_ROUTER_VERSION"] = f"v{version}"
                image = (bindir / exe).read_bytes()
                try:
                    output = install("--service", success=False)
                    assert "injected service failure" in output and "verified it is healthy" in output, output
                    assert (bindir / exe).read_bytes() == image
                    health()
                finally:
                    marker = home / "service.pid"
                    if marker.exists():
                        (home / "cook-router.pid").write_text(marker.read_text())
                    unit = (root / "Library/LaunchAgents/io.github.prep-cook.cook-router.plist" if platform.system() == "Darwin"
                            else root / ".config/systemd/user/cook-router.service")
                    unit.unlink(missing_ok=True)
                    env["PATH"] = original_path
            env["COOK_ROUTER_VERSION"] = "v999.3.0"
            image = (bindir / exe).read_bytes()
            if windows:
                running = pid()
                install("-BinaryOnly")
                assert pid() == running
                health()
                script = str(repo / "install.ps1").replace("'", "''")
                selected = ps(f"$code=(Get-Content -Raw '{script}') -replace '(?m)^Install-CookRouter -Service.*$', ''; . ([scriptblock]::Create($code)); "
                              "$dir=$ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($env:COOK_ROUTER_INSTALL_DIR); "
                              "$data=$ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($env:COOK_ROUTER_HOME); "
                              "Get-CookRouterServers $dir (Join-Path $data 'config.yaml') -db (Join-Path $data 'cook.db') | ForEach-Object { [IO.Path]::GetFileName((Get-CookRouterImage $_.ProcessId $dir)) }")
                assert selected.startswith("cook-router.prev-") and selected.endswith(".exe"), selected
            output = install(success=False)
            assert ("Rolled back" if windows else "verified it is healthy") in output, output
            if not windows:
                assert "sending SIGKILL" in output, "a hung process ignoring SIGTERM must be killed before restarting"
            assert (bindir / exe).read_bytes() == image, "unhealthy live upgrade must restore the old image"
            health()
            if not windows:
                env["COOK_ROUTER_VERSION"] = "v999.2.0"
                inode = (bindir / exe).stat().st_ino
                assert "restored the previous binary" in install(success=False)
                assert (bindir / exe).stat().st_ino == inode
                health()
                # A checksum failure must not replace a healthy image or restart it.
                env["COOK_ROUTER_VERSION"] = f"v{version}"
                sums = releases / f"download/v{version}/SHA256SUMS"
                sums.write_text(sums.read_text().replace(sums.read_text()[:64], "0" * 64))
                old_pid = pid()
                assert "checksum mismatch" in install(success=False)
                assert pid() == old_pid and (bindir / exe).stat().st_ino == inode
                health()
            else:
                env["COOK_ROUTER_VERSION"] = "v999.1.0"
                install("-Service")
                entry = ps("(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run').'cook-router'")
                assert entry.startswith(f'"{bindir / exe}" --db '), entry
                assert "--log-file" in entry and "--working-dir" in entry and not any(x in entry.lower() for x in ("powershell", "cmd.exe", "start.ps1"))
                existing_image = (bindir / exe).read_bytes()
                existing_pid = pid()
                env["COOK_ROUTER_VERSION"] = "v999.0.0"
                assert "too old for this installer" in install(success=False)
                assert (bindir / exe).read_bytes() == existing_image and pid() == existing_pid
                assert ps("(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run').'cook-router'") == entry
                health()
                env["COOK_ROUTER_VERSION"] = "v999.1.0"
                ps(f"Stop-Process -Id {pid()}")
                # Execute the exact Run entry, not an installer-generated launcher.
                (home / ".env").write_text("WRITABLE_PATH=./relative-state\n")
                config = home / "config.yaml"
                commit_config(config.read_text() + "\nobservability:\n  logs:\n    logging-to-file: true\n")
                launched = int(ps(f"$e=(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run').'cook-router'; $e -match '^\"([^\"]+)\" (.*)$' | Out-Null; (Start-Process -FilePath $Matches[1] -ArgumentList $Matches[2] -PassThru).Id", cwd=root))
                (home / "cook-router.pid").write_text(str(launched))
                health()
                assert (home / "cook-router.log").stat().st_size > 0
                assert (home / "relative-state/logs/main.log").is_file(), "Run entry must read its home .env and resolve relative paths there"
                # A later installer must find the direct Run process with a stale pid file.
                (home / "cook-router.pid").write_text("0")
                install()
                health()
                assert pid() != launched
                # A sign-in entry from before the rename makes the run a service run and gives
                # way to the cook-router entry once the new server answers.
                ps("Set-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name cliproxy-rs -Value 'legacy'")
                assert "Replaced the cliproxy-rs sign-in entry" in install()
                health()
                assert ps("$e=(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue).'cliproxy-rs'; if($e){$e}") == ""
                assert ps("(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run').'cook-router'").startswith(f'"{bindir / exe}" --db ')
                # Restoring a pre-SQLite image must never restart stale YAML or retain
                # a sign-in entry that would do so on the next login.
                ps(f"Stop-Process -Id {pid()} -Force; Wait-Process -Id {pid()} -ErrorAction SilentlyContinue", check=False)
                shutil.copy2(legacy, bindir / exe)
                ps(f"Set-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name cook-router -Value '\"{bindir / exe}\" --config \"{home / 'config.yaml'}\"'")
                env["COOK_ROUTER_VERSION"] = "v999.3.0"
                output = install(success=False)
                assert "cannot read" in output and "stale config.yaml backup" in output and "ROLLBACK FAILED" in output, output
                assert (bindir / exe).read_bytes() == legacy.read_bytes(), "old binary was not restored"
                assert not (home / "cook-router.pid").exists(), "incompatible rollback launched a server"
                assert ps("$e=(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue).'cook-router'; if($e){$e}") == ""
                env["COOK_ROUTER_VERSION"] = "v999.1.0"
                install()
                health()
            # Non-default bind host: derive both the health probe and dashboard URL.
            config = home / "config.yaml"
            plain_backup = config.read_text()
            commit_config(plain_backup.replace('host: "127.0.0.1"', 'host: "::1"'))
            env["COOK_ROUTER_VERSION"] = f"v{version}" if not windows else "v999.1.0"
            if not windows:
                # Make the on-disk current file newer than its last-start marker.
                env["COOK_ROUTER_VERSION"] = "v999.1.0"
                os.utime(bindir / exe, None)
            assert "http://[::1]:8317/management.html" in install()
            connection = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with connection.open("http://[::1]:8317/healthz", timeout=5) as response:
                assert response.status == 200
            commit_config(plain_backup.replace('host: "127.0.0.1"', 'host: "::"'))
            os.utime(bindir / exe, None)
            assert "http://[::1]:8317/management.html" in install()
            with connection.open("http://[::1]:8317/healthz", timeout=5) as response:
                assert response.status == 200
            cert = root / "fixture-cert.pem"
            key = root / "fixture-key.pem"
            subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                            "-subj", "/CN=localhost", "-keyout", key, "-out", cert],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
            plain = plain_backup.replace('host: "127.0.0.1"', 'host: "::"')
            for mapping, enabled in [("tls: # self-signed", "true"), ("tls:", "true")]:
                commit_config(plain.replace("  port: 8317", f"  port: 8317\n  {mapping}\n    enable: {enabled}\n    cert: '{cert}'\n    key: '{key}'"))
                os.utime(bindir / exe, None)
                assert "https://[::1]:8317/management.html" in install()
                connection = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                              urllib.request.HTTPSHandler(context=ssl._create_unverified_context()))
                with connection.open("https://[::1]:8317/healthz", timeout=5) as response:
                    assert response.status == 200
            if windows:
                class Unhealthy(http.server.BaseHTTPRequestHandler):
                    def do_GET(self):
                        self.send_response(503)
                        self.end_headers()

                    def log_message(self, *_):
                        pass

                unhealthy = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Unhealthy)
                context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                context.load_cert_chain(cert, key)
                unhealthy.socket = context.wrap_socket(unhealthy.socket, server_side=True)
                threading.Thread(target=unhealthy.serve_forever, daemon=True).start()
                script = str(repo / "install.ps1").replace("'", "''")
                try:
                    print(ps(f"$ErrorActionPreference='Stop'; $code=(Get-Content -Raw '{script}') -replace '(?m)^Install-CookRouter -Service.*$', ''; . ([scriptblock]::Create($code)); " + f'''
$before = [Net.ServicePointManager]::ServerCertificateValidationCallback
$good = [pscustomobject]@{{Tls=$true; Base='https://[::1]:8317'}}
$bad = [pscustomobject]@{{Tls=$true; Base='https://127.0.0.1:{unhealthy.server_port}'}}
if(-not (Test-CookRouterUp $good)){{throw 'self-signed HTTPS health probe failed'}}
if(Test-CookRouterUp $bad){{throw 'HTTPS 503 must fail the health probe'}}
if([Net.ServicePointManager]::ServerCertificateValidationCallback -ne $before){{throw 'health probe changed global certificate validation'}}
$accepted = $false
try {{ Invoke-WebRequest "$($good.Base)/healthz" -UseBasicParsing -TimeoutSec 2 | Out-Null; $accepted = $true }} catch {{}}
if($accepted){{throw 'certificate exception leaked to an ordinary request'}}
Write-Output 'PASS Windows PowerShell 5.1: HTTPS status and scoped certificate validation'
'''))
                finally:
                    unhealthy.shutdown()
                    unhealthy.server_close()
                # Accepting a TCP connection is insufficient: this candidate
                # speaks plaintext on the TLS port and must restore the healthy image.
                image = (bindir / exe).read_bytes()
                env["COOK_ROUTER_VERSION"] = "v999.4.0"
                output = install(success=False)
                assert "Rolled back" in output and "ROLLBACK FAILED" not in output, output
                assert (bindir / exe).read_bytes() == image
                with connection.open("https://[::1]:8317/healthz", timeout=5) as response:
                    assert response.status == 200, "TLS rollback must restore the original healthy server"
            assert config.read_text() == plain_backup, "database edits changed the stale YAML backup"
            if windows:
                migrate_windows()
            if not windows:
                migrate("v999.1.0")
            print(f"PASS {platform.system()}: install, upgrade, binary-only, unchanged keys" +
                  (", direct Run entry, old sign-in entry, process log and HTTPS rollback" if windows else
                   ", check, current restart, hard link, rollback, checksum rejection, install from before the rename"))
        except BaseException:
            def diagnostic(action):
                try:
                    action()
                except (OSError, subprocess.SubprocessError) as error:
                    print(f"Best-effort diagnostics: {error}", file=sys.stderr)

            for folder in (home, root / "second"):
                def logs():
                    print(f"Diagnostics: {folder}", file=sys.stderr)
                    logfile = folder / "cook-router.log"
                    if logfile.exists():
                        print("\n".join(logfile.read_text(errors="replace").splitlines()[-40:]), file=sys.stderr)
                diagnostic(logs)
                def process():
                    marker = folder / "cook-router.pid"
                    if marker.exists() and not windows:
                        recorded_pid = marker.read_text().strip()
                        print(f"pid file: {recorded_pid}", file=sys.stderr)
                        # Observe shell exit statuses too: a direct Python exec
                        # reports EPERM, not the status the installer sees.
                        status = capture(["sh", "-c", '''
kill -0 "$1"; echo "kill -0 status=$?"
name=$(ps -p "$1" -o "$2="); rc=$?; printf 'name status=%s output=<%s>\n' "$rc" "$name"
state=$(ps -p "$1" -o stat=); rc=$?; printf 'stat status=%s output=<%s>\n' "$rc" "$state"
eval "$(sed '$d' "$3")"
pidfile=$4; os=$(uname -s)
if managed_pid && pid_running "$pid"; then
  echo 'installer PID helpers: PASS'
else
  rc=$?; printf 'installer PID helpers: FAIL status=%s pid=<%s> ps_status=<%s>\n' "$rc" "${pid-unset}" "${status-unset}"
fi
''', "diagnostics", recorded_pid, "ucomm" if platform.system() == "Darwin" else "comm", repo / "install.sh", marker],
                                         env=env, timeout=10)
                        print(status.stdout, file=sys.stderr)
                        subprocess.run(["ps", "-p", recorded_pid, "-o", "pid=,ppid=,stat=,comm=,args="], check=False, timeout=10)
                diagnostic(process)
            if windows:
                diagnostic(lambda: print(ps("Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 8317,8318 } | Format-Table LocalAddress,LocalPort,OwningProcess", check=False)))
            else:
                if shutil.which("lsof"):
                    diagnostic(lambda: subprocess.run(["lsof", "-nP", "-iTCP:8317", "-sTCP:LISTEN"], check=False, timeout=10))
                if shutil.which("ss"):
                    diagnostic(lambda: subprocess.run(["ss", "-ltnp"], check=False, timeout=10))
            raise
        finally:
            try:
                if (home / "cook-router.pid").exists():
                    if windows:
                        ps(f"Stop-Process -Id {pid()} -ErrorAction SilentlyContinue", check=False)
                    else:
                        subprocess.run(["kill", str(pid())], check=False, timeout=10)
            except (OSError, ValueError, subprocess.SubprocessError) as error:
                print(f"Best-effort cleanup: {error}", file=sys.stderr)
            if windows:
                try:
                    if original_run:
                        ps("Set-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name cook-router -Value '" + original_run.replace("'", "''") + "'", check=False)
                    else:
                        ps("Remove-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name cook-router -ErrorAction SilentlyContinue", check=False)
                    ps("Remove-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name cliproxy-rs -ErrorAction SilentlyContinue", check=False)
                except (OSError, subprocess.SubprocessError) as error:
                    print(f"Best-effort cleanup: {error}", file=sys.stderr)
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    main()
