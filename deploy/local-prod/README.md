# Running production on this PC

Dubly runs on `127.0.0.1:8787` (built frontend + API, `NODE_ENV=production`, sign-up closed), next to the local MongoDB. It starts 2 processes sharing that port and adds one at a time, up to one fewer than the cores, while they are busy and memory allows, retiring idle ones when quiet (`MIN_PROCESSES` / `MAX_PROCESSES`, docs/DEPLOYMENT.md). Nothing listens on the network; people reach it through a tunnel. Everything lives in `%USERPROFILE%\dubly-prod`: `work\` (scratch files and the voice cache, kept out of the OneDrive folder), `log\` (launcher, app, tunnel, backup), `CURRENT_URL.txt` (the address in use).

| Script | What it does |
|---|---|
| `run.ps1` | Starts MongoDB, the tunnel (if set up) and the app; checks every 15 s and restarts whatever stopped |
| `install.ps1 -BackupDir <folder> [-Keep 3]` | Starts `run.ps1` hidden at every sign-in, and backs the database up daily at 03:00 |
| `stop.ps1` | Stops the launcher, the app and the tunnel (MongoDB keeps running) |

```powershell
powershell -ExecutionPolicy Bypass -File deploy\local-prod\install.ps1 -BackupDir "C:\Users\<you>\OneDrive - <company>\dubly-backups"
```

## A public address

Download `cloudflared-windows-amd64.exe` from Cloudflare's GitHub releases (check its SHA-256 against the release page) and save it as `%USERPROFILE%\dubly-prod\bin\cloudflared.exe`. No admin rights are needed.

- **Fixed address on your own domain (recommended).** The domain's DNS must be on Cloudflare.
  ```powershell
  $cf = "$env:USERPROFILE\dubly-prod\bin\cloudflared.exe"
  & $cf tunnel login                          # browser: pick the domain
  & $cf tunnel create dubly
  & $cf tunnel route dns dubly dubly.example.com
  Set-Content "$env:USERPROFILE\dubly-prod\TUNNEL_NAME.txt" dubly
  Set-Content "$env:USERPROFILE\dubly-prod\PUBLIC_URL.txt" https://dubly.example.com
  ```
  Restart (`stop.ps1`, then `run.ps1`). The tunnel's credentials are in `%USERPROFILE%\.cloudflared`; keep them private.
- **Quick tunnel (testing).** With only `cloudflared.exe` in place, `run.ps1` opens a `https://<random>.trycloudflare.com` address. It changes on every start, which breaks links already emailed, so don't send password links on it.

With an `https://` address the session cookie is always marked Secure (`COOKIE_SECURE=true`).

## Once the address is fixed

Send everyone their "choose your new password" link (valid 72 h):

```powershell
$env:WEB_ORIGIN = (Get-Content "$env:USERPROFILE\dubly-prod\CURRENT_URL.txt")
npx tsx server/scripts/send_reset_links.ts            # dry run: lists who gets one
npx tsx server/scripts/send_reset_links.ts --send
```

## Keeping it up

It is down whenever the PC sleeps, shuts down or loses its connection. Keep it plugged in with the lid open, and stop it from sleeping on mains power: `powercfg /change standby-timeout-ac 0` (undo: `powercfg /change standby-timeout-ac 30`).
