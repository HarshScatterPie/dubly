# Stops Dubly's production run on this PC: the launcher, the app and the tunnel. MongoDB keeps running (stop it from Task Manager,
# mongod.exe, if you need to); the data is safe either way.
$procs = Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq 'powershell.exe' -and $_.CommandLine -match 'local-prod\\run\.ps1') -or
  ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'server/index\.ts' -and $_.CommandLine -notmatch 'watch') -or
  ($_.Name -eq 'cloudflared.exe')
}
foreach ($p in $procs) {
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  "stopped $($p.Name) ($($p.ProcessId))"
}
if (-not $procs) { 'nothing was running' }
