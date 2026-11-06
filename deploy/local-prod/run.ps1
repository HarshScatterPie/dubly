# Runs Dubly in production on this PC: MongoDB, the app (built frontend + API on 127.0.0.1:8787, never on the network) and, when one
# is set up, a tunnel that gives it a public HTTPS address. Checks every 15 s and restarts whatever stopped. Started at sign-in by the
# Startup entry that install.ps1 creates; logs and the current address are in %USERPROFILE%\dubly-prod. See README.md.
$ErrorActionPreference = 'Continue'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Prod = Join-Path $env:USERPROFILE 'dubly-prod'
$Logs = Join-Path $Prod 'log'
New-Item -ItemType Directory -Force $Logs | Out-Null
$Port = 8787
$LauncherLog = Join-Path $Logs 'launcher.log'
$Cloudflared = Join-Path $Prod 'bin\cloudflared.exe'
$TunnelLog = Join-Path $Logs 'cloudflared.log'
$Wrangler = Join-Path $Prod 'tools\node_modules\wrangler\bin\wrangler.js'
# Ways to have a fixed address, first match wins:
#   FRONT_DOOR.txt  line 1 the Worker's address (https://dubly.<account>.workers.dev), line 2 its KV namespace id: a quick tunnel
#                   runs behind it, and its changing address is written to KV on every start (no domain needed).
#   TUNNEL_NAME.txt a named Cloudflare tunnel on your own domain, with PUBLIC_URL.txt holding that address.
#   PUBLIC_URL.txt  alone: an address served some other way (Tailscale Funnel, a reverse proxy); no tunnel is started here.
$FrontDoorFile = Join-Path $Prod 'FRONT_DOOR.txt'
$TunnelNameFile = Join-Path $Prod 'TUNNEL_NAME.txt'
$FixedUrlFile = Join-Path $Prod 'PUBLIC_URL.txt'
# Shared with the Worker, so the app trusts the visitor address it forwards (EDGE_SHARED_SECRET).
$EdgeSecretFile = Join-Path $Prod 'EDGE_SECRET.txt'
# The address people use right now.
$CurrentUrlFile = Join-Path $Prod 'CURRENT_URL.txt'

function Log([string]$Message) { "$(Get-Date -Format s) $Message" | Out-File -Append -Encoding utf8 $LauncherLog }
function First-Line([string]$file, [int]$index = 0) { return ((Get-Content $file) | Select-Object -Index $index).Trim() }

# One launcher at a time.
$mutex = New-Object System.Threading.Mutex($false, 'Local\DublyProdLauncher')
if (-not $mutex.WaitOne(0)) { exit 0 }

Set-Location $Repo
Log "launcher started from $Repo"

function Ensure-Mongo {
  & node deploy/mongo/start-local.mjs 2>&1 | Out-File -Append -Encoding utf8 $LauncherLog
}

function Port-Open([int]$p) {
  return [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
}

function Start-Tunnel {
  if (-not (Test-Path $Cloudflared)) { return $null }
  Remove-Item $TunnelLog -ErrorAction SilentlyContinue
  if ((Test-Path $TunnelNameFile) -and -not (Test-Path $FrontDoorFile)) {
    return Start-Process -FilePath $Cloudflared -ArgumentList @('tunnel', '--no-autoupdate', '--logfile', "`"$TunnelLog`"", 'run', '--url', "http://127.0.0.1:$Port", (First-Line $TunnelNameFile)) -WindowStyle Hidden -PassThru
  }
  if ((Test-Path $FixedUrlFile) -and -not (Test-Path $FrontDoorFile)) { return $null }
  return Start-Process -FilePath $Cloudflared -ArgumentList @('tunnel', '--no-autoupdate', '--url', "http://127.0.0.1:$Port", '--logfile', "`"$TunnelLog`"") -WindowStyle Hidden -PassThru
}

# The quick tunnel's own address, read from its log; $null when there is none.
function Get-TunnelUrl($tunnel) {
  if (-not $tunnel) { return $null }
  for ($i = 0; $i -lt 90; $i++) {
    if (Test-Path $TunnelLog) {
      $hit = Select-String -Path $TunnelLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -Last 1
      if ($hit) { return $hit.Matches[0].Value }
    }
    if ($tunnel.HasExited) { break }
    Start-Sleep -Seconds 1
  }
  return $null
}

# Points the Worker at the tunnel's current address.
function Publish-Origin([string]$tunnelUrl) {
  if (-not (Test-Path $FrontDoorFile)) { return }
  if (-not $tunnelUrl) { Log 'no tunnel address to give the front door'; return }
  $namespace = First-Line $FrontDoorFile 1
  & node --use-system-ca $Wrangler kv key put origin $tunnelUrl --namespace-id $namespace --remote 2>&1 | Out-File -Append -Encoding utf8 $LauncherLog
  if ($LASTEXITCODE -eq 0) { Log "front door now forwards to $tunnelUrl (live within a minute)" } else { Log 'could not update the front door; see above' }
}

# The address the app is known by (emails, cookies, cross-site checks).
function Get-PublicUrl([string]$tunnelUrl) {
  if (Test-Path $FrontDoorFile) { return (First-Line $FrontDoorFile 0).TrimEnd('/') }
  if (Test-Path $FixedUrlFile) { return (First-Line $FixedUrlFile 0).TrimEnd('/') }
  if ($tunnelUrl) { return $tunnelUrl }
  return "http://localhost:$Port"
}

function Start-App([string]$url) {
  if (-not (Test-Path (Join-Path $Repo 'dist\index.html'))) {
    Log 'no built frontend; running npm run build'
    & npm run build 2>&1 | Out-File -Append -Encoding utf8 $LauncherLog
  }
  # Production settings; values set here win over server/.env (dotenv never overrides an existing variable).
  $env:NODE_ENV = 'production'
  $env:HOST = '127.0.0.1'
  $env:PORT = "$Port"
  $env:TRUST_PROXY = '1'
  $env:COOKIE_SECURE = if ($url.StartsWith('https://')) { 'true' } else { '' }
  $env:ALLOW_SIGNUP = 'false'
  $env:WEB_ORIGIN = $url
  $env:EDGE_SHARED_SECRET = if (Test-Path $EdgeSecretFile) { First-Line $EdgeSecretFile } else { '' }
  $out = Join-Path $Logs 'dubly.log'
  foreach ($f in @($out, "$out.err")) { if (Test-Path $f) { Move-Item -Force $f "$f.prev" } }
  return Start-Process -FilePath 'node' -ArgumentList @('--import', 'tsx', 'server/index.ts') -WorkingDirectory $Repo -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError "$out.err" -PassThru
}

Ensure-Mongo
$tunnel = Start-Tunnel
$tunnelUrl = Get-TunnelUrl $tunnel
Publish-Origin $tunnelUrl
$url = Get-PublicUrl $tunnelUrl
Set-Content -Encoding utf8 $CurrentUrlFile $url
Log "address: $url"
$app = Start-App $url

while ($true) {
  Start-Sleep -Seconds 15
  if (-not (Port-Open 27017)) {
    Log 'MongoDB is not answering; starting it'
    Ensure-Mongo
  }
  if ($tunnel -and $tunnel.HasExited) {
    Log "tunnel stopped (exit $($tunnel.ExitCode)); starting a new one"
    $tunnel = Start-Tunnel
    $tunnelUrl = Get-TunnelUrl $tunnel
    Publish-Origin $tunnelUrl
    $new = Get-PublicUrl $tunnelUrl
    if ($new -ne $url) {
      # Only without a fixed address: the app's links must follow the new one.
      $url = $new
      Set-Content -Encoding utf8 $CurrentUrlFile $url
      Log "new address: $url (restarting the app so its links use it)"
      if ($app -and -not $app.HasExited) { Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue }
      $app = $null
    }
  }
  if (-not $app -or $app.HasExited) {
    if ($app) { Log "app stopped (exit $($app.ExitCode)); restarting" }
    $app = Start-App $url
  }
}
