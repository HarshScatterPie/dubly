#!/usr/bin/env bash
# Re-runnable VM setup (run as the app user): Node 24 in /opt/node-24, swap, ~/dubly-shared + ~/dubly-releases layout, systemd units and timer.
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-v24.21.0}"
APP_USER="$(whoami)"
BASE="$HOME"
SHARED="$BASE/dubly-shared"
RELEASES="$BASE/dubly-releases"
CURRENT="$BASE/dubly"
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"

log() { echo "[install] $*"; }

# 1. Node 24, verified against the published SHA-256 sums.
if [ "$(/opt/node-24/bin/node -v 2>/dev/null || true)" != "$NODE_VERSION" ]; then
  tmp=$(mktemp -d)
  tarball="node-$NODE_VERSION-linux-x64.tar.xz"
  log "installing Node $NODE_VERSION"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$tarball" -o "$tmp/$tarball"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  (cd "$tmp" && grep " $tarball\$" SHASUMS256.txt | sha256sum -c -)
  sudo mkdir -p "/opt/node-$NODE_VERSION"
  sudo tar -xJf "$tmp/$tarball" -C "/opt/node-$NODE_VERSION" --strip-components=1
  sudo ln -sfn "/opt/node-$NODE_VERSION" /opt/node-24
  rm -rf "$tmp"
fi

# A 2 GB machine building a release while a dub renders can run out of memory; swap turns that into slowness instead of a kill.
if ! swapon --show | grep -q /swapfile; then
  log "adding a 2 GB swapfile"
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

# 2. Shared files, taken once from the existing hand-copied install.
mkdir -p "$SHARED/credentials" "$SHARED/cache" "$RELEASES"
chmod 700 "$SHARED/credentials"
if [ -d "$CURRENT" ] && [ ! -L "$CURRENT" ]; then
  legacy="$RELEASES/legacy-$(date -u +%Y%m%dT%H%M%SZ)"
  log "adopting the existing $CURRENT as release $(basename "$legacy")"
  [ -e "$SHARED/web.env" ] || cp -a "$CURRENT/.env" "$SHARED/web.env"
  [ -e "$SHARED/server.env" ] || cp -a "$CURRENT/server/.env" "$SHARED/server.env"
  cp -an "$CURRENT/server/credentials/." "$SHARED/credentials/" 2>/dev/null || true
  cp -an "$CURRENT/server/cache/." "$SHARED/cache/" 2>/dev/null || true
  # The running service keeps working: its directory moves, and ~/dubly points at it until the first deploy.
  mv "$CURRENT" "$legacy"
  echo "legacy" > "$legacy/REVISION"
  ln -sfn "$legacy" "$CURRENT"
fi
chmod 600 "$SHARED/web.env" "$SHARED/server.env" 2>/dev/null || true
chmod 600 "$SHARED"/credentials/* 2>/dev/null || true

# Operational settings for this VM (not secrets); read by dubly.service. Existing values are never overwritten.
if [ ! -e "$SHARED/runtime.env" ]; then
  cat > "$SHARED/runtime.env" <<'ENV'
# nginx on this VM is one proxy hop in front of Dubly.
TRUST_PROXY=1
# Sized for a 2 vCPU / 2 GB machine; raise with the machine size.
MAX_ACTIVE_DUBS=2
MAX_DUBS_PER_WORKSPACE=2
MAX_HEAVY_REQUESTS=2
ENV
fi

# 3. systemd units, rendered for this user.
render() { sed -e "s#__USER__#$APP_USER#g" -e "s#__HOME__#$BASE#g" "$HERE/$1" | sudo tee "/etc/systemd/system/$1" >/dev/null; }
render dubly.service
render dubly-autodeploy.service
render dubly-autodeploy.timer
sudo systemctl daemon-reload
sudo systemctl enable dubly.service >/dev/null
sudo systemctl enable --now dubly-autodeploy.timer >/dev/null
log "done. Deploy a commit now with: bash $HERE/deploy.sh <sha>  (the timer deploys main by itself once CI passes)"
