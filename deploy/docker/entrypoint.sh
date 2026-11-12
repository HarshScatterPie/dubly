#!/usr/bin/env bash
# Starts the whole of Dubly in one container (deploy/docker/README.md):
#   1. its own MongoDB: a single-node replica set on 127.0.0.1 with access control on, data in /data/mongo (init-mongo.mjs sets it up).
#      Skipped when MONGODB_URI is set: the app then uses that database instead.
#   2. the app (server/index.ts): the built frontend, the API and the dub workers, on PORT.
#   3. with BACKUP_DIR set (compose.yaml sets /backups), a daily backup of the database into it (backup-loop.mjs).
#   4. with FRONT_DOOR_URL set, a Cloudflare quick tunnel behind that Worker address (front-door.mjs).
# tini (PID 1) hands Docker's stop signal to this script, which stops them in order: the app first, so it finishes or settles running
# dubs (SHUTDOWN_GRACE_MS), then MongoDB, cleanly. When the app or MongoDB stops by itself, the other is stopped too and the container
# exits non-zero, so Docker's restart policy starts it again.
set -uo pipefail

MONGO_DIR=/data/mongo
APP_DIR=/data/app
SECRETS_DIR=/data/secrets

# One JSON object per line, like the app's own log (server/lib/log.ts).
log() {
  printf '{"timestamp":"%s","severity":"%s","message":"%s","event":"container"}\n' "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" "$1" "$2"
}

is_root=false
[ "$(id -u)" -eq 0 ] && is_root=true

# Runs a command in a session of its own, so a Ctrl-C on an attached terminal reaches only this script (which then stops everything in
# order); as the given user when the container runs as root (the default), else as whoever it runs as (docker run --user).
run_as() {
  local user=$1
  shift
  if $is_root; then
    HOME=$(getent passwd "$user" | cut -d: -f6) exec setsid setpriv --reuid="$user" --regid="$user" --init-groups -- "$@"
  else
    exec setsid "$@"
  fi
}

mongo_pid=''
init_pid=''
app_pid=''
backup_pid=''
front_pid=''

stop_all() {
  trap '' TERM INT
  [ -n "$front_pid" ] && kill -TERM "$front_pid" 2>/dev/null
  [ -n "$backup_pid" ] && kill -TERM "$backup_pid" 2>/dev/null
  [ -n "$init_pid" ] && kill -TERM "$init_pid" 2>/dev/null
  if [ -n "$app_pid" ] && kill -0 "$app_pid" 2>/dev/null; then
    log INFO 'stopping the app; it finishes or settles running work first'
    kill -TERM "$app_pid"
    wait "$app_pid"
  fi
  if [ -n "$mongo_pid" ] && kill -0 "$mongo_pid" 2>/dev/null; then
    log INFO 'stopping MongoDB'
    kill -TERM "$mongo_pid"
    wait "$mongo_pid"
  fi
  log INFO "stopped (exit $1)"
  exit "$1"
}
trap 'stop_all 0' TERM INT

if [ -n "${MONGODB_URI:-}" ]; then
  log INFO 'MONGODB_URI is set, so the app uses that database and the container does not start its own MongoDB'
  case "$MONGODB_URI" in
    *@127.0.0.1[:/]* | *@localhost[:/]* | *//127.0.0.1[:/]* | *//localhost[:/]*)
      log WARNING 'MONGODB_URI points at localhost inside the container, where no other MongoDB runs; remove it to use the built-in one'
      ;;
  esac
else
  mkdir -p "$MONGO_DIR/db" "$SECRETS_DIR" "$APP_DIR" || stop_all 1
  chmod 700 "$SECRETS_DIR"
  keyfile=$MONGO_DIR/keyfile
  if [ ! -s "$keyfile" ]; then
    # The replica set's internal key, which MongoDB requires once access control is on, even with a single member.
    (umask 077 && head -c 756 /dev/urandom | base64 -w0 >"$keyfile.new" && mv "$keyfile.new" "$keyfile") || stop_all 1
  fi
  if $is_root; then
    chown -R mongodb:mongodb "$MONGO_DIR" || stop_all 1
    chown node:node "$APP_DIR"
  fi
  chmod 400 "$keyfile"
  bind=127.0.0.1
  # Only for opening the data in Compass through a port published on the host's loopback (README.md); access control stays on.
  [ "${MONGO_LISTEN_ALL:-false}" = true ] && bind=0.0.0.0
  log INFO "starting MongoDB $(mongod --version | sed -n 's/^db version //p') on $bind"
  (run_as mongodb mongod --dbpath "$MONGO_DIR/db" --port 27017 --bind_ip "$bind" --replSet rs0 --keyFile "$keyfile" \
    --wiredTigerCacheSizeGB "${MONGO_CACHE_GB:-1}" --quiet) &
  mongo_pid=$!
  MONGOD_PID=$mongo_pid node /app/deploy/docker/init-mongo.mjs &
  init_pid=$!
  if ! wait "$init_pid"; then
    init_pid=''
    log ERROR 'MongoDB could not be prepared; see the lines above'
    stop_all 1
  fi
  init_pid=''
  $is_root && chown node:node "$APP_DIR/dubly.env"
  MONGODB_URI=$(sed -n 's/^MONGODB_URI=//p' "$APP_DIR/dubly.env")
  export MONGODB_URI
  export MONGODB_DB=${MONGODB_DB:-dubly}
fi

# Inside a container the app must listen on every interface; the published port (compose.yaml) decides who can reach it.
case "${HOST:-}" in
  127.0.0.1 | localhost | ::1)
    log WARNING "HOST=$HOST would hide the app from the published port; listening on every interface instead"
    export HOST=
    ;;
esac

mkdir -p "$APP_DIR/cache" || stop_all 1
$is_root && chown node:node "$APP_DIR" "$APP_DIR/cache"
cd /app || stop_all 1
(run_as node node --import tsx server/index.ts) &
app_pid=$!

if [ -n "${BACKUP_DIR:-}" ]; then
  mkdir -p "$BACKUP_DIR"
  # A folder Docker has just created for the mount belongs to root: hand it to the app's user while it is still empty.
  if $is_root && [ "$(stat -c %u "$BACKUP_DIR")" != "$(id -u node)" ] && [ -z "$(ls -A "$BACKUP_DIR")" ]; then
    chown node:node "$BACKUP_DIR" 2>/dev/null
  fi
  (run_as node node /app/deploy/docker/backup-loop.mjs) &
  backup_pid=$!
fi

if [ -n "${FRONT_DOOR_URL:-}" ]; then
  (run_as node node /app/deploy/docker/front-door.mjs) &
  front_pid=$!
fi

wait -n "$app_pid" ${mongo_pid:+"$mongo_pid"}
code=$?
if kill -0 "$app_pid" 2>/dev/null; then
  log ERROR "MongoDB stopped by itself (exit $code); stopping the container so Docker restarts it"
else
  log ERROR "the app stopped by itself (exit $code); stopping the container so Docker restarts it"
fi
stop_all 1
