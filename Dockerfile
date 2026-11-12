# syntax=docker/dockerfile:1
# The whole of Dubly in one image: the built frontend, the API and dub workers (Node 24), and its own MongoDB. One command starts it:
#   docker compose up -d --build        (compose.yaml; settings in deploy/docker/dubly.env; see deploy/docker/README.md)
# Pin NODE_IMAGE by digest for byte-for-byte rebuilds.
ARG NODE_IMAGE=node:24-trixie-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
# On a network that inspects TLS (an office antivirus or proxy), give the build its root certificate as a secret; it is only mounted
# while npm runs and never stored in the image. compose.yaml passes it from DUBLY_EXTRA_CA; by hand:
#   docker build --secret id=extra_ca,src=<root-ca.pem> -t dubly:latest .
RUN --mount=type=secret,id=extra_ca \
  if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; npm ci
COPY . .
# The frontend needs no build-time configuration: it talks only to this server, which holds the MongoDB connection.
RUN npm run build

# mongod from MongoDB's own Debian 13 build, the same version CI tests against (.github/scripts/start-mongo.sh), pinned by hash.
# The official mongo image can't be copied from: it is built on a newer glibc than Debian 13 has. To upgrade, change the version in the
# URL and the checksum together (MongoDB publishes it next to the file, as <file>.sha256).
FROM ${NODE_IMAGE} AS mongo
ADD --checksum=sha256:d1ab22e2aae1c01b939c44c74690bc75dc6d2a048cde950f1c84b6c89d744c6c \
  https://fastdl.mongodb.org/linux/mongodb-linux-x86_64-debian13-9.0.4.tgz /tmp/mongodb.tgz
RUN tar -xzf /tmp/mongodb.tgz -C /usr/local/bin --strip-components=2 --wildcards '*/bin/mongod'

FROM ${NODE_IMAGE} AS runtime
# ffmpeg comes from Debian so it receives distribution security updates; rebuild the image to pick them up.
# Noto fonts give burned-in captions glyphs for every script the app dubs into (Devanagari, Tamil, Bengali, Arabic, CJK...).
# libcurl is mongod's only library beyond the base image. MongoDB runs as its own user, apart from the app's (node).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini fontconfig fonts-noto-core fonts-noto-cjk libcurl4t64 \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 999 mongodb \
  && useradd --system --uid 999 --gid mongodb --home-dir /data/mongo --no-create-home --shell /usr/sbin/nologin mongodb
COPY --from=mongo /usr/local/bin/mongod /usr/local/bin/mongod
# Fails the build if mongod is missing a library.
RUN mongod --version
# cloudflared opens the quick tunnel behind the Worker front door when FRONT_DOOR_URL is set (deploy/docker/front-door.mjs). Cloudflare's
# own static build, pinned by the SHA-256 in its release notes; the same version as the PC's.
ADD --chmod=755 --checksum=sha256:1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872 \
  https://github.com/cloudflare/cloudflared/releases/download/2026.10.7/cloudflared-linux-amd64 /usr/local/bin/cloudflared
WORKDIR /app
# Everything that must outlive the container is under /data (MongoDB, its logins, the voice cache): mount a volume there.
# TZ only decides when the daily backup runs; the app itself shows every date in Asia/Kolkata whatever the container's zone.
ENV NODE_ENV=production \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe \
    PORT=8787 \
    WEB_ORIGIN=http://localhost:8787 \
    TZ=Asia/Kolkata \
    DUBLY_CACHE_DIR=/data/app/cache \
    DUBLY_ENV_FILE=/data/app/dubly.env
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=extra_ca \
  if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server ./server
# The server shares these with the frontend (plan maths, voice engines, caption cues, types); without them it cannot start.
COPY src/data ./src/data
COPY src/lib ./src/lib
COPY src/types.ts ./src/types.ts
COPY tsconfig.json ./
COPY deploy/mongo ./deploy/mongo
COPY deploy/docker/entrypoint.sh deploy/docker/init-mongo.mjs deploy/docker/backup-loop.mjs deploy/docker/front-door.mjs ./deploy/docker/
# A copy edited on Windows may have CRLF line endings, which bash refuses.
RUN sed -i 's/\r$//' deploy/docker/entrypoint.sh && chmod 755 deploy/docker/entrypoint.sh
# DeepFilterNet separates speech from the background (server/lib/audioSeparation.ts); a static binary, pinned by hash.
ADD --chmod=755 --checksum=sha256:70775e251eee44c0f2451a1e833326cf8bcbbe304d3e7cd12851e6fce72ef7da   https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/deep-filter-0.5.6-x86_64-unknown-linux-musl /app/server/bin/deep-filter
# Scratch space the app writes to; credentials and settings are mounted at runtime, never baked in (see deploy/docker/README.md).
RUN mkdir -p server/tmp server/cache server/credentials /data && chown -R node:node server/tmp server/cache
VOLUME ["/data"]
EXPOSE 8787
# The start period covers a first start, when MongoDB is initialised and its logins are created.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# The entrypoint starts as root only to fix the data folders' owners; it then runs MongoDB as `mongodb` and the app as `node`.
# tini forwards Docker's stop signal to it (the app drains first, then MongoDB stops cleanly) and reaps ffmpeg child processes.
# Allow at least 60 s to stop (compose.yaml's stop_grace_period, or docker run --stop-timeout 60).
ENTRYPOINT ["/usr/bin/tini", "--", "/app/deploy/docker/entrypoint.sh"]
