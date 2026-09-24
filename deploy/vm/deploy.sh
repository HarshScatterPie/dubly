#!/usr/bin/env bash
# Usage: deploy.sh <commit-sha>. Builds the commit in its own release folder, switches to it, restarts, and rolls back if unhealthy.
set -euo pipefail

SHA="${1:?usage: deploy.sh <commit-sha>}"
BASE="${DUBLY_BASE:-$HOME}"
SRC="$BASE/dubly-src"
RELEASES="$BASE/dubly-releases"
SHARED="$BASE/dubly-shared"
CURRENT="$BASE/dubly"
REPO_URL="${DUBLY_REPO_URL:-https://github.com/HarshScatterPie/dubly.git}"
export PATH="/opt/node-24/bin:$PATH"

log() { echo "[deploy $(date -u +%FT%TZ)] $*"; }

# One deploy at a time (the timer and a manual run must not overlap).
exec 9>"$BASE/.dubly-deploy.lock"
flock -n 9 || { log "another deploy is running"; exit 75; }

[ -d "$SRC/.git" ] || git clone --quiet "$REPO_URL" "$SRC"
git -C "$SRC" fetch --quiet origin
FULL=$(git -C "$SRC" rev-parse --verify "$SHA^{commit}")
REL="$RELEASES/$FULL"
PREV=$(readlink -f "$CURRENT" || true)
if [ "$PREV" = "$REL" ]; then
  log "$FULL is already live"
  exit 0
fi

log "building $FULL"
rm -rf "$REL"
mkdir -p "$REL"
git -C "$SRC" archive "$FULL" | tar -x -C "$REL"
# Files that never come from git: secrets, client config and the TTS cache are shared by every release.
ln -sfn "$SHARED/web.env" "$REL/.env"
ln -sfn "$SHARED/server.env" "$REL/server/.env"
rm -rf "$REL/server/credentials" "$REL/server/cache"
ln -sfn "$SHARED/credentials" "$REL/server/credentials"
ln -sfn "$SHARED/cache" "$REL/server/cache"
(
  cd "$REL"
  npm ci --no-audit --no-fund --loglevel=error
  npm run build --silent
  # The build needed dev dependencies; the running service does not.
  npm prune --omit=dev --no-audit --no-fund --loglevel=error
)
echo "$FULL" > "$REL/REVISION"

switch_to() { ln -sfn "$1" "$CURRENT.next" && mv -Tf "$CURRENT.next" "$CURRENT"; }
healthy() {
  for _ in $(seq 1 30); do
    curl -fsS -m 3 "http://127.0.0.1:${PORT:-8787}/api/healthz" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

# Installs the release's systemd units (placeholders filled in) when they differ from what is installed.
sync_units() {
  local changed=0 unit
  for unit in dubly.service dubly-autodeploy.service dubly-autodeploy.timer; do
    [ -f "$1/deploy/vm/$unit" ] || continue
    if ! sed -e "s#__USER__#$(whoami)#g" -e "s#__HOME__#$BASE#g" "$1/deploy/vm/$unit" | cmp -s - "/etc/systemd/system/$unit"; then
      sed -e "s#__USER__#$(whoami)#g" -e "s#__HOME__#$BASE#g" "$1/deploy/vm/$unit" | sudo tee "/etc/systemd/system/$unit" >/dev/null
      changed=1
    fi
  done
  if [ "$changed" = 1 ]; then sudo systemctl daemon-reload; fi
}

log "switching to $FULL"
switch_to "$REL"
sync_units "$REL"
# The service drains running dubs (up to SHUTDOWN_GRACE_MS) before it stops; queued dubs resume in the new release.
sudo systemctl restart dubly
if healthy; then
  log "live: $FULL"
else
  log "health check failed for $FULL; rolling back to $PREV"
  if [ -n "$PREV" ] && [ -d "$PREV" ]; then
    switch_to "$PREV"
    sync_units "$PREV"
    sudo systemctl restart dubly
  fi
  exit 1
fi

# Keep the three newest releases for quick rollback (the live one is never removed).
live=$(readlink -f "$CURRENT")
ls -1dt "$RELEASES"/*/ 2>/dev/null | tail -n +4 | while read -r old; do
  [ "$(readlink -f "$old")" = "$live" ] || rm -rf "$old"
done
