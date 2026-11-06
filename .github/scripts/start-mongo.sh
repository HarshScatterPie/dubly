#!/usr/bin/env bash
# Starts a throwaway single-node MongoDB replica set for CI (Dubly needs transactions, which only replica sets have) and waits until it
# accepts writes. Tests then use MONGODB_TEST_URI=mongodb://127.0.0.1:27017/dubly_test?directConnection=true.
set -euo pipefail
IMAGE="${MONGO_IMAGE:-mongo:9.0.4}"

docker run -d --name dubly-mongo -p 127.0.0.1:27017:27017 "$IMAGE" --replSet rs0 --bind_ip_all >/dev/null
for _ in $(seq 1 60); do
  if docker exec dubly-mongo mongosh --quiet --eval '
    try { rs.status().ok } catch (e) { rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "127.0.0.1:27017" }] }).ok }
  ' >/dev/null 2>&1 && docker exec dubly-mongo mongosh --quiet --eval 'quit(db.hello().isWritablePrimary ? 0 : 1)' >/dev/null 2>&1; then
    echo "MongoDB replica set ready ($IMAGE)"
    exit 0
  fi
  sleep 2
done
echo "MongoDB did not become ready" >&2
docker logs dubly-mongo | tail -40 >&2
exit 1
