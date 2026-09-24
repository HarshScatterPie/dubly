#!/usr/bin/env bash
# Run by dubly-autodeploy.timer: deploys main's new commit once its CI run passed (pull-based: no inbound access, no keys in GitHub).
set -euo pipefail

BASE="${DUBLY_BASE:-$HOME}"
CURRENT="$BASE/dubly"
REPO="${DUBLY_REPO:-HarshScatterPie/dubly}"
BRANCH="${DUBLY_BRANCH:-main}"
STATE="$BASE/.dubly-autodeploy"
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
NODE=/opt/node-24/bin/node

log() { echo "[autodeploy $(date -u +%FT%TZ)] $*"; }
mkdir -p "$STATE"

HEAD=$(git ls-remote "https://github.com/$REPO.git" "refs/heads/$BRANCH" | cut -f1)
[ -n "$HEAD" ] || { log "could not read $BRANCH from GitHub"; exit 0; }
LIVE=$(cat "$CURRENT/REVISION" 2>/dev/null || true)
[ "$HEAD" = "$LIVE" ] && exit 0
# A commit whose CI failed, or whose deploy failed its health check, is not retried; the next push is.
[ -e "$STATE/skip-$HEAD" ] && exit 0

# CI gate: only the "CI" workflow's run for exactly this commit counts.
RESULT=$(curl -fsS -H 'Accept: application/vnd.github+json' \
  "https://api.github.com/repos/$REPO/actions/runs?head_sha=$HEAD&per_page=20" |
  "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=(JSON.parse(s).workflow_runs||[]).find(w=>w.name==="CI");console.log(r?`${r.status}/${r.conclusion}`:"none")})') || { log "GitHub API unavailable"; exit 0; }

case "$RESULT" in
  completed/success) ;;
  completed/*)
    log "CI did not pass for $HEAD ($RESULT); not deploying it"
    touch "$STATE/skip-$HEAD"
    exit 0
    ;;
  *) exit 0 ;; # CI still running (or not started yet): check again next tick
esac

log "CI passed for $HEAD; deploying (live: ${LIVE:-none})"
status=0
"$HERE/deploy.sh" "$HEAD" || status=$?
if [ "$status" -eq 75 ]; then
  log "another deploy is in progress; will check again next tick"
elif [ "$status" -ne 0 ]; then
  log "deploy of $HEAD failed; staying on ${LIVE:-previous release}"
  touch "$STATE/skip-$HEAD"
  exit 1
fi
