# Installs cook-router on Windows, sets it up and starts it. In PowerShell:
#
#   irm https://raw.githubusercontent.com/prep-cook/cook-router/master/install.ps1 | iex
#
# The first run downloads the Windows release, checks it against the release's SHA256SUMS
# and installs %LOCALAPPDATA%\Programs\cook-router\cook-router.exe. It writes
# %USERPROFILE%\.cook-router\config.yaml with a free port (8317, or the next free one) and
# new keys, which it saves in keys.env next to it and never prints. Then it starts the
# server in the background and checks that it answers. Running it again upgrades the
# binary and restarts the server; if the new version does not answer, the previous binary
# is put back and restarted. An existing config.yaml or keys.env is never changed.
#
# An install from before the rename to cook-router keeps working: without %USERPROFILE%\.cook-router,
# an existing %USERPROFILE%\.cliproxy-rs is used as it is, its cliproxy server is stopped, and
# a healthy cook-router server replaces its cliproxy-rs sign-in entry. The old cliproxy.exe is
# left in place.
#
# Options, passed like this:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/prep-cook/cook-router/master/install.ps1))) -Service
#   -Service     also start cook-router when you sign in to Windows
#   -BinaryOnly  only install or upgrade the binary; a running server keeps running
#
# Environment: COOK_ROUTER_VERSION (a tag such as v0.1.0; default the latest),
# COOK_ROUTER_INSTALL_DIR, COOK_ROUTER_HOME, COOK_ROUTER_NO_OPEN=1 (never open a browser) and
# COOK_ROUTER_RELEASES (release page base URL, for mirrors and tests). Each falls back to its
# CLIPROXY_* name from before the rename.
param([switch]$Service, [switch]$BinaryOnly)

# Everything runs in this function, so a download cut short cannot run half a script, and
# `throw` reports a failure without closing the window that ran `irm | iex`.
function Install-CookRouter([bool]$Service, [bool]$BinaryOnly) {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $releases = Get-InstallSetting 'RELEASES'
  if (-not $releases) { $releases = 'https://github.com/prep-cook/cook-router/releases' }
  $dir = Get-InstallSetting 'INSTALL_DIR'
  if (-not $dir) { $dir = Join-Path $env:LOCALAPPDATA 'Programs\cook-router' }
  $data = Get-InstallSetting 'HOME'
  if (-not $data) {
    $data = Join-Path $env:USERPROFILE '.cook-router'
    $oldData = Join-Path $env:USERPROFILE '.cliproxy-rs'
    if (-not (Test-Path -LiteralPath $data) -and (Test-Path -LiteralPath $oldData -PathType Container)) {
      Write-Host "Using $oldData from before the rename; new installs use $data."
      $data = $oldData
    }
  }
  # Absolute paths: they go into the Run entry and identify this install's server process.
  $dir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($dir)
  $data = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($data)
  # Where an install from before the rename put cliproxy.exe: this directory when it was set
  # explicitly, otherwise the old default.
  $oldDirs = @($dir, (Join-Path $env:LOCALAPPDATA 'Programs\cliproxy-rs')) | Select-Object -Unique
  $exe = Join-Path $dir 'cook-router.exe'
  $staged = Join-Path $dir 'cook-router.new.exe'
  $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  $oldRunName = 'cliproxy-rs'
  if ($Service -and $BinaryOnly) { throw 'install.ps1: -Service and -BinaryOnly do not go together' }
  # A start-at-sign-in entry from an earlier run keeps being used, also one from before the rename.
  $oldRun = Get-ItemProperty -Path $runKey -Name $oldRunName -ErrorAction SilentlyContinue
  if ($oldRun -or (Get-ItemProperty -Path $runKey -Name 'cook-router' -ErrorAction SilentlyContinue)) { $Service = -not $BinaryOnly }

  $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  # ARM64 Windows runs the x86_64 build through its emulation.
  if ($arch -notin 'AMD64', 'ARM64') { throw "install.ps1: there is no release binary for $arch Windows" }

  $tag = Get-InstallSetting 'VERSION'
  if (-not $tag) {
    # /releases/latest redirects to /releases/tag/<tag> once a release exists.
    try { $r = Invoke-Retry { Invoke-WebRequest -Uri "$releases/latest" -Method Head -UseBasicParsing } }
    catch { throw "install.ps1: cannot reach $releases ($($_.Exception.Message))" }
    $final = if ($r.BaseResponse.ResponseUri) { $r.BaseResponse.ResponseUri.AbsoluteUri } else { $r.BaseResponse.RequestMessage.RequestUri.AbsoluteUri }
    if ($final -notmatch '/tag/([^/]+)$') { throw 'install.ps1: no release is published yet' }
    $tag = $Matches[1]
  }
  $name = "cook-router-$($tag.TrimStart('v'))-x86_64-pc-windows-msvc"

  # Stage the new image next to the old one and check it before anything existing changes.
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("cook-router-" + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $zip = Join-Path $tmp "$name.zip"
    try {
      Invoke-Retry { Invoke-WebRequest -Uri "$releases/download/$tag/$name.zip" -OutFile $zip -UseBasicParsing }
      Invoke-Retry { Invoke-WebRequest -Uri "$releases/download/$tag/SHA256SUMS" -OutFile (Join-Path $tmp 'SHA256SUMS') -UseBasicParsing }
    } catch { throw "install.ps1: could not download $name.zip and SHA256SUMS from release $tag ($($_.Exception.Message))" }
    $expected = Get-Content (Join-Path $tmp 'SHA256SUMS') | ForEach-Object {
      $hash, $file = $_ -split '\s+', 2
      if ($file -eq "$name.zip" -or $file -eq "*$name.zip") { $hash }
    } | Select-Object -First 1
    if (-not $expected) { throw "install.ps1: $name.zip is not listed in SHA256SUMS" }
    if ((Get-FileHash $zip -Algorithm SHA256).Hash -ne $expected) { throw "install.ps1: checksum mismatch for $name.zip; nothing was installed" }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Copy-Item -LiteralPath (Join-Path $tmp "$name\cook-router.exe") -Destination $staged -Force
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }

  $pidfile = Join-Path $data 'cook-router.pid'
  $config = Join-Path $data 'config.yaml'
  $keys = Join-Path $data 'keys.env'
  $log = Join-Path $data 'cook-router.log'
  try {
    $help = Get-CookRouterHelp $staged
    if ($help -notmatch '--log-file' -or $help -notmatch '--working-dir') {
      throw "install.ps1: release $tag is too old for this installer (its cook-router.exe has no --log-file or --working-dir option); install a newer release, or unset COOK_ROUTER_VERSION for the latest. Nothing was changed."
    }
    $version = & $staged --version | Select-Object -Last 1
    if (-not $BinaryOnly) { $probe = Initialize-CookRouterHome $data $config $keys }
  } catch {
    Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
    throw
  }

  # A binary-only upgrade can leave the healthy server running from an older image.
  # Use that image for rollback, not the untested cook-router.exe already on disk.
  $runningPrevious = $null
  if (-not $BinaryOnly) {
    $runningPrevious = Get-CookRouterServers $dir $config | ForEach-Object {
      $image = Get-CookRouterImage $_.ProcessId $dir
      if ($image -and [IO.Path]::GetFileName($image) -like 'cook-router.prev-*.exe') { $image }
    } | Select-Object -First 1
  }
  # The previous image's flags decide how a rollback restarts it.
  $previousArguments = $null
  $previous = if ($runningPrevious) { $runningPrevious } else { $exe }
  if (Test-Path -LiteralPath $previous) {
    $previousHelp = ''
    # An image that cannot print its help is restarted, if needed, with --config only.
    try { $previousHelp = Get-CookRouterHelp $previous } catch { $previousHelp = '' }
    $previousArguments = New-CookRouterArguments $previousHelp $config $log $data
  } else { $previous = $null }
  # Windows permits renaming a running image, so a running server keeps serving from
  # this run's cook-router.prev-<guid>.exe until it is stopped.
  $displaced = $null
  if (Test-Path -LiteralPath $exe) {
    $displaced = Join-Path $dir ("cook-router.prev-" + [guid]::NewGuid() + '.exe')
    Invoke-Retry { [IO.File]::Move($exe, $displaced) }
    if (-not $runningPrevious) { $previous = $displaced }
  }
  try { Invoke-Retry { [IO.File]::Move($staged, $exe) } } catch {
    $why = $_.Exception.Message
    if ($displaced) { [IO.File]::Move($displaced, $exe) }
    throw "install.ps1: could not put the new cook-router.exe in place ($why); the previous one is unchanged"
  }
  # Older images from earlier runs, unless a server still runs from them (then they are locked).
  # -BinaryOnly is done here, and its running server keeps its image locked.
  Remove-CookRouterImages $dir $(if ($BinaryOnly) { $null } else { $previous })
  Write-Host "Installed $version at $exe"
  if (($env:Path -split ';') -notcontains $dir) { Write-Host "Add $dir to your PATH to run cook-router by name." }
  if ($BinaryOnly) { Write-OldBinaryNote $oldDirs; return }

  # Direct process launch and in-process logging; no persistent shell or WMI host.
  $arguments = New-CookRouterArguments $help $config $log $data
  try { Stop-CookRouter $pidfile $dir $config $oldDirs } catch {
    $why = $_.Exception.Message
    if ($previous) { Restore-CookRouterImage $exe $previous }
    throw "install.ps1: could not stop the running cook-router ($why); the previous binary is back in place"
  }
  $proc = $null
  $problem = $null
  try {
    $proc = Start-CookRouter $exe $arguments $data $pidfile
    $problem = Wait-CookRouter $proc $probe
  } catch { $problem = "cook-router could not be started ($($_.Exception.Message))" }
  if ($problem) {
    $tail = Get-Content -LiteralPath $log -Tail 20 -ErrorAction SilentlyContinue | Out-String
    $stopped = $true
    if ($proc) { try { Stop-CookRouterId $proc.Id } catch { $stopped = $false } }
    Remove-Item -LiteralPath $pidfile -Force -ErrorAction SilentlyContinue
    if (-not $previous) { throw "install.ps1: $problem. The end of $log says:`n$tail" }
    $rollback = $null
    try {
      if (-not $stopped) { throw "the new process $($proc.Id) did not stop" }
      Restore-CookRouterImage $exe $previous
      $old = $null
      try {
        $old = Start-CookRouter $exe $previousArguments $data $pidfile
        $oldProblem = Wait-CookRouter $old $probe
      } catch { $oldProblem = "it could not be started ($($_.Exception.Message))" }
      if ($oldProblem) {
        if ($old) { Stop-CookRouterId $old.Id }
        Remove-Item -LiteralPath $pidfile -Force -ErrorAction SilentlyContinue
        throw "the restored previous version failed too: $oldProblem"
      }
    } catch { $rollback = $_.Exception.Message }
    if ($rollback) {
      throw "install.ps1: the upgrade failed: $problem. ROLLBACK FAILED: $rollback. cook-router may not be running; see $log. The end of $log said:`n$tail"
    }
    throw "install.ps1: the upgrade failed: $problem. Rolled back: the previous binary is in place and answers again at $($probe.Base). The end of $log said:`n$tail"
  }

  # Only a healthy new server replaces the sign-in entry or this run's previous image.
  if ($Service) {
    # A new profile may have no Run key yet. Only create it then: New-Item -Force on an existing key
    # would replace it and drop the other programs' entries.
    if (-not (Test-Path $runKey)) { New-Item -Path $runKey | Out-Null }
    Set-ItemProperty -Path $runKey -Name 'cook-router' -Value "`"$exe`" $arguments"
    Remove-Item (Join-Path $data 'start.ps1') -Force -ErrorAction SilentlyContinue
    if ($oldRun) {
      Remove-ItemProperty -Path $runKey -Name $oldRunName
      Write-Host "Replaced the $oldRunName sign-in entry from before the rename with cook-router."
    }
  }
  Remove-CookRouterImages $dir $null
  Write-OldBinaryNote $oldDirs

  $base = $probe.Base
  $url = "$base/management.html"
  $configText = $config -replace "'", "''"
  Write-Host ''
  Write-Host "cook-router is running at $base"
  Write-Host "  Dashboard  $url"
  if (Test-Path $keys) { Write-Host "  Keys       $keys (show them with: Get-Content `"$keys`")" }
  Write-Host "  Config     $config"
  Write-Host "  Log        $log"
  Write-Host "  Stop       Get-CimInstance Win32_Process -Filter `"Name LIKE 'cook-router%.exe'`" | Where-Object { `$_.CommandLine -and `$_.CommandLine.Contains('$configText') } | ForEach-Object { Stop-Process -Id `$_.ProcessId }"
  if ($Service) {
    Write-Host "It starts when you sign in to Windows. To stop that: Remove-ItemProperty $runKey -Name cook-router"
  } else {
    Write-Host 'It runs until you sign out or restart. Run this again with -Service to start it when you sign in.'
  }
  if ($env:SSH_CONNECTION) {
    $port = $probe.Port
    Write-Host ''
    Write-Host 'No browser on this machine? Keep the server on 127.0.0.1 and reach it from your own computer'
    Write-Host 'through an SSH tunnel, then open the dashboard address there:'
    Write-Host "  ssh -L ${port}:127.0.0.1:${port} $env:USERNAME@$env:COMPUTERNAME"
    Write-Host 'Tailscale works too; see docs/MULTI-ACCOUNT.md.'
  } elseif (-not (Get-InstallSetting 'NO_OPEN') -and [Environment]::UserInteractive) {
    Start-Process $url
  }
  Write-Host ''
  if (Test-Path $keys) {
    # keys.env from before the rename names the key CLIPROXY_MANAGEMENT_KEY.
    $keyName = 'COOK_ROUTER_MANAGEMENT_KEY'
    $keyLines = Get-Content -LiteralPath $keys
    if (-not ($keyLines -match '^COOK_ROUTER_MANAGEMENT_KEY=') -and ($keyLines -match '^CLIPROXY_MANAGEMENT_KEY=')) { $keyName = 'CLIPROXY_MANAGEMENT_KEY' }
    Write-Host "Next: open the dashboard, sign in with $keyName from keys.env, and choose Connect account."
  } else {
    Write-Host 'Next: open the dashboard, sign in with your management key, and choose Connect account.'
  }
  Write-Host ''
  Write-Host 'If cook-router helps, a star helps others find it: https://github.com/prep-cook/cook-router'
}

# A COOK_ROUTER_* setting, or its CLIPROXY_* name from before the rename while the new one is unset.
function Get-InstallSetting([string]$name) {
  $value = [Environment]::GetEnvironmentVariable("COOK_ROUTER_$name")
  if ($value) { $value } else { [Environment]::GetEnvironmentVariable("CLIPROXY_$name") }
}

function Write-OldBinaryNote($oldDirs) {
  foreach ($old in $oldDirs) {
    $image = Join-Path $old 'cliproxy.exe'
    if (Test-Path -LiteralPath $image) { Write-Host "$image from before the rename is no longer used; you can delete it." }
  }
}

# Runs an action up to three times: a download, for a brief network or server error, or
# a rename of an image another process holds for a moment (an antivirus scan of a file
# this run has just executed).
function Invoke-Retry([scriptblock]$Action) {
  for ($i = 1; ; $i++) {
    try { return & $Action } catch { if ($i -ge 3) { throw } }
    Start-Sleep -Seconds (2 * $i)
  }
}

function New-Hex {
  $bytes = New-Object byte[] 24
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  -join ($bytes | ForEach-Object { $_.ToString('x2') })
}

# Writes config.yaml and keys.env on a first run, then returns where the server answers.
function Initialize-CookRouterHome($data, $config, $keys) {
  if (-not (Test-Path -LiteralPath $config)) {
    if (Test-Path -LiteralPath $keys) { throw "install.ps1: $keys exists but $config does not; restore config.yaml, or move keys.env away to make new keys" }
    New-Item -ItemType Directory -Force -Path (Join-Path $data 'auth') | Out-Null
    # Only you, SYSTEM and Administrators can read the folder, wherever COOK_ROUTER_HOME points.
    # Replace the DACL, including explicit grants on an existing folder, rather than
    # only removing inherited grants. keys.env inherits exactly these three trustees.
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $me = [Security.Principal.WindowsIdentity]::GetCurrent().User
    foreach ($sid in @($me, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')), (New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))) {
      $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
      $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $data -AclObject $acl
    $listening = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners().Port
    $port = 8317..8336 | Where-Object { $listening -notcontains $_ } | Select-Object -First 1
    if (-not $port) { throw 'install.ps1: ports 8317 to 8336 are all in use; free one and run this again' }
    $client = 'sk-' + (New-Hex)
    $management = New-Hex
    $authDir = (Join-Path $data 'auth') -replace "'", "''"
    [IO.File]::WriteAllText($keys, (@(
          '# cook-router keys. Sign in to the dashboard with COOK_ROUTER_MANAGEMENT_KEY;'
          '# your tools send COOK_ROUTER_CLIENT_KEY. Keep this file private.'
          "COOK_ROUTER_PORT=$port"
          "COOK_ROUTER_CLIENT_KEY=$client"
          "COOK_ROUTER_MANAGEMENT_KEY=$management"
        ) -join "`n") + "`n")
    [IO.File]::WriteAllText($config, (@(
          '# Written by install.ps1. The plain keys are in keys.env next to this file.'
          'config-version: 8'
          'server:'
          '  host: "127.0.0.1"'
          "  port: $port"
          'access:'
          '  api-keys:'
          "    - `"$client`""
          'management:'
          "  secret-key: `"$management`""
          'oauth:'
          "  auth-dir: '$authDir'"
          'routing:'
          '  session-affinity: true'
        ) -join "`n") + "`n")
    Write-Host "Wrote $config, with new keys in $keys"
  }
  Get-CookRouterProbe $config
}

function Get-CookRouterHelp($image) {
  try { $text = & $image --help | Out-String } catch { throw "install.ps1: $image does not run ($($_.Exception.Message)); nothing was changed" }
  if ($LASTEXITCODE -ne 0) { throw "install.ps1: $image --help failed with exit code $LASTEXITCODE; nothing was changed" }
  $text
}

# A quoted Windows argument; a trailing backslash would otherwise escape the closing quote.
function ConvertTo-Argument([string]$value) { '"' + ($value -replace '(\\+)$', '$1$1') + '"' }

# The same options for the direct start and the Run entry. An older previous image restarted
# by a rollback gets only the options its --help lists.
function New-CookRouterArguments($help, $config, $log, $data) {
  $arguments = "--config $(ConvertTo-Argument $config)"
  if ($help -match '--log-file') { $arguments += " --log-file $(ConvertTo-Argument $log)" }
  if ($help -match '--working-dir') { $arguments += " --working-dir $(ConvertTo-Argument $data)" }
  $arguments
}

function Start-CookRouter($image, $arguments, $data, $pidfile) {
  $proc = Start-Process -FilePath $image -ArgumentList $arguments -WorkingDirectory $data -WindowStyle Hidden -PassThru
  $null = $proc.Handle # keeps ExitCode readable after the process ends
  Set-Content -LiteralPath $pidfile -Value $proc.Id
  $proc
}

# Address, port and scheme from server.host/port/tls.enable, or the older top-level
# host/port/tls keys. Wildcards are probed on their family's loopback address.
# ponytail: block-style YAML only; a flow mapping such as `server: {port: 9000}` falls back to
# the defaults. Parse with the binary itself if configs start using that form.
function Get-CookRouterProbe($config) {
  $values = @{}
  $stack = New-Object System.Collections.ArrayList
  foreach ($line in Get-Content -LiteralPath $config) {
    if ($line -notmatch '^( *)([A-Za-z0-9_.-]+) *:(.*)$') { continue }
    $indent = $Matches[1].Length
    $key = $Matches[2]
    $value = ($Matches[3] -replace '(^|\s+)#.*$', '').Trim()
    while ($stack.Count -and $stack[$stack.Count - 1].Indent -ge $indent) { $stack.RemoveAt($stack.Count - 1) }
    $path = (@($stack | ForEach-Object { $_.Key }) + $key) -join '.'
    if ($value -eq '') { [void]$stack.Add([pscustomobject]@{ Indent = $indent; Key = $key }) }
    if ($value -match '^"(.*)"$' -or $value -match "^'(.*)'$") { $value = $Matches[1] }
    if (-not $values.ContainsKey($path)) { $values[$path] = $value }
  }
  $pick = { param($new, $old) if ($values.ContainsKey($new)) { $values[$new] } elseif ($values.ContainsKey($old)) { $values[$old] } else { $null } }
  $address = [string](& $pick 'server.host' 'host')
  $address = $address.Trim().TrimStart('[').TrimEnd(']')
  if ($address -in '', '0.0.0.0') { $address = '127.0.0.1' }
  if ($address -eq '::') { $address = '::1' }
  $port = 0
  if (-not [int]::TryParse([string](& $pick 'server.port' 'port'), [ref]$port) -or $port -le 0) { $port = 8317 }
  $tls = [string](& $pick 'server.tls.enable' 'tls.enable') -match '^(?i:true|y|yes|on)$'
  $urlHost = if ($address.Contains(':')) { "[$address]" } else { $address }
  $scheme = if ($tls) { 'https' } else { 'http' }
  [pscustomobject]@{ Address = $address; Port = $port; Tls = $tls; Base = "${scheme}://${urlHost}:$port" }
}

# Both schemes must answer GET /healthz. The certificate exception is confined
# to this local HTTPS request, including on Windows PowerShell 5.1.
function Test-CookRouterUp($probe) {
  if (-not $probe.Tls) {
    try { return (Invoke-WebRequest -Uri "$($probe.Base)/healthz" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { return $false }
  }
  if (-not ('CookRouterInstallerLocalCertificate' -as [type])) {
    # A PowerShell scriptblock delegate needs a runspace on the TLS callback
    # thread. A managed delegate works on both Windows PowerShell and pwsh.
    Add-Type @'
using System.Net.Security;
public static class CookRouterInstallerLocalCertificate {
  public static readonly RemoteCertificateValidationCallback Accept = (sender, certificate, chain, errors) => true;
}
'@
  }
  $request = [Net.HttpWebRequest]::Create("$($probe.Base)/healthz")
  $callback = $request.ServerCertificateValidationCallback
  $response = $null
  try {
    $request.ServerCertificateValidationCallback = [CookRouterInstallerLocalCertificate]::Accept
    $request.Timeout = 2000
    $request.ReadWriteTimeout = 2000
    $request.AllowAutoRedirect = $false
    $request.KeepAlive = $false # do not reuse this certificate-exempt connection
    $response = $request.GetResponse()
    return [int]$response.StatusCode -eq 200
  } catch { return $false } finally {
    if ($response) { $response.Close() }
    $request.ServerCertificateValidationCallback = $callback
    $request.Abort()
  }
}

# $null once the process answers and is still alive after about 20 s at most; otherwise why not.
function Wait-CookRouter($proc, $probe) {
  Start-Sleep -Seconds 1
  for ($i = 0; $i -lt 20; $i++) {
    if (Test-CookRouterUp $probe) {
      # A server that lost the port to another program exits right after binding fails.
      Start-Sleep -Seconds 1
      if ($proc.HasExited) { return "another program already answers at $($probe.Base), so cook-router could not start there" }
      return $null
    }
    if ($proc.HasExited) { return "cook-router stopped right after starting (exit code $($proc.ExitCode))" }
    Start-Sleep -Seconds 1
  }
  "cook-router did not answer at $($probe.Base)"
}

function Stop-CookRouterId([int]$id) {
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if (-not $p) { return }
  try { Stop-Process -Id $id -Force } catch { if (Get-Process -Id $id -ErrorAction SilentlyContinue) { throw } }
  if (-not $p.WaitForExit(10000)) { throw "install.ps1: cook-router process $id did not stop" }
}

# Puts this run's previous image back as cook-router.exe; the failed one is removed when unlocked.
function Restore-CookRouterImage($exe, $previous) {
  $failed = Join-Path ([IO.Path]::GetDirectoryName($exe)) ("cook-router.prev-" + [guid]::NewGuid() + '.exe')
  [IO.File]::Move($exe, $failed)
  [IO.File]::Move($previous, $exe)
  Remove-Item -LiteralPath $failed -Force -ErrorAction SilentlyContinue
}

# Removes previous images no process holds open, except $keep.
function Remove-CookRouterImages($dir, $keep) {
  # Enumeration can expand an 8.3 directory alias while $keep retains it. All
  # candidates are in this directory, so compare their unique image filenames.
  $keepName = if ($keep) { [IO.Path]::GetFileName($keep) } else { $null }
  Get-ChildItem -LiteralPath $dir -Filter 'cook-router.prev-*.exe' | Where-Object { $_.Name -ne $keepName } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
}

# WMI retains the launch path after a running image is renamed. Query the actual
# mapped file; only installer processes use this API.
function Get-CookRouterImage([int]$id, $dir) {
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if (-not $p) { return $null }
  try {
    if (-not ('CookRouterInstallerMappedImage' -as [type])) {
      Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class CookRouterInstallerMappedImage {
  [DllImport("psapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern uint GetMappedFileName(IntPtr process, IntPtr address, StringBuilder name, uint size);
}
'@
    }
    $name = New-Object Text.StringBuilder 32768
    if ([CookRouterInstallerMappedImage]::GetMappedFileName($p.Handle, $p.MainModule.BaseAddress, $name, $name.Capacity) -eq 0) {
      throw "install.ps1: could not read the running image for process $id (Windows error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())); nothing was replaced"
    }
    # The API returns a device path. Process selection already checked the
    # install directory, and joining its filename avoids drive/8.3 aliases.
    $image = Join-Path $dir ([IO.Path]::GetFileName($name.ToString()))
    if (-not (Test-Path -LiteralPath $image)) { throw "install.ps1: the running image $image is missing; nothing was replaced" }
    $image
  } finally { $p.Dispose() }
}

# Finds this install's server: a cook-router image from the install directory started with this
# config, including Run-entry launches without a pid file. A reused pid must not
# select a server for another config sharing the binary. With $prefix 'cliproxy' and the
# directories an install from before the rename used, it finds that install's server.
function Get-CookRouterServers($dir, $config, $prefix = 'cook-router') {
  $directories = @($dir) | ForEach-Object { $_.TrimEnd('\') }
  try { $all = @(Get-CimInstance Win32_Process -Filter "Name LIKE '$prefix%.exe'" -OperationTimeoutSec 10) }
  catch { throw "install.ps1: could not list running processes ($($_.Exception.Message))" }
  $all | Where-Object {
    ($_.Name -eq "$prefix.exe" -or $_.Name -like "$prefix.prev-*.exe") -and
      $_.ExecutablePath -and [IO.Path]::GetDirectoryName($_.ExecutablePath) -in $directories -and
      $_.CommandLine -and $_.CommandLine.IndexOf($config, [StringComparison]::OrdinalIgnoreCase) -ge 0
  }
}

# Stops this install's server, and the cliproxy server of the same config from before the rename,
# which would otherwise keep the port.
function Stop-CookRouter($pidfile, $dir, $config, $oldDirs) {
  foreach ($p in (Get-CookRouterServers $dir $config)) { Stop-CookRouterId $p.ProcessId }
  foreach ($p in (Get-CookRouterServers $oldDirs $config 'cliproxy')) { Stop-CookRouterId $p.ProcessId }
  Remove-Item -LiteralPath $pidfile -Force -ErrorAction SilentlyContinue
}

Install-CookRouter -Service $Service.IsPresent -BinaryOnly $BinaryOnly.IsPresent
