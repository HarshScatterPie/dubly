# One-time setup for running Dubly in production on this PC, for the signed-in Windows user (no admin rights needed):
#   - starts deploy/local-prod/run.ps1 hidden at every sign-in (a Startup-folder entry),
#   - backs the database up every day at 03:00 (a scheduled task), keeping the newest few.
#   powershell -ExecutionPolicy Bypass -File deploy\local-prod\install.ps1 -BackupDir "D:\dubly-backups" [-Keep 3]
# Undo: delete "Dubly.vbs" from the Startup folder (shell:startup) and run: schtasks /delete /tn "Dubly backup" /f
param(
  [Parameter(Mandatory = $true)][string]$BackupDir,
  [int]$Keep = 3
)
$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Prod = Join-Path $env:USERPROFILE 'dubly-prod'
New-Item -ItemType Directory -Force (Join-Path $Prod 'log'), $BackupDir | Out-Null

# 1. Start at sign-in, with no window.
$runner = Join-Path $Repo 'deploy\local-prod\run.ps1'
$vbs = Join-Path ([Environment]::GetFolderPath('Startup')) 'Dubly.vbs'
$line = 'CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""' + $runner + '""", 0, False'
Set-Content -Encoding ascii $vbs $line
"start at sign-in: $vbs"

# 2. Daily backup. The task runs a short wrapper, because a task's command line is limited to 261 characters.
$wrapper = Join-Path $Prod 'backup.cmd'
$backupLog = Join-Path $Prod 'log\backup.log'
Set-Content -Encoding ascii $wrapper @(
  '@echo off',
  "cd /d `"$Repo`"",
  "node deploy\mongo\backup.mjs `"$BackupDir`" --keep $Keep >> `"$backupLog`" 2>&1"
)
& schtasks.exe /create /tn 'Dubly backup' /sc daily /st 03:00 /tr "`"$wrapper`"" /f | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not create the backup task' }
"daily backup at 03:00 to $BackupDir (newest $Keep kept), log $backupLog"
