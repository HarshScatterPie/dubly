# syntax=docker/dockerfile:1
# Production image (API + built frontend in one container); pin NODE_IMAGE by digest for byte-for-byte rebuilds.
ARG NODE_IMAGE=node:24-trixie-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# The frontend needs no build-time configuration: it talks only to this server, which holds the MongoDB connection.
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
# ffmpeg comes from Debian so it receives distribution security updates; rebuild the image to pick them up.
# Noto fonts give burned-in captions glyphs for every script the app dubs into (Devanagari, Tamil, Bengali, Arabic, CJK...).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini fontconfig fonts-noto-core fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe \
    PORT=8787
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server ./server
COPY src/data ./src/data
COPY src/types.ts ./src/types.ts
COPY tsconfig.json ./
# DeepFilterNet separates speech from the background (server/lib/audioSeparation.ts); a static binary, pinned by hash.
ADD --chmod=755 --checksum=sha256:70775e251eee44c0f2451a1e833326cf8bcbbe304d3e7cd12851e6fce72ef7da   https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/deep-filter-0.5.6-x86_64-unknown-linux-musl /app/server/bin/deep-filter
# Scratch space the app writes to; credentials and server/.env are mounted at runtime, never baked in (see docs/DEPLOYMENT.md).
RUN mkdir -p server/tmp server/cache server/credentials && chown -R node:node server/tmp server/cache
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# tini forwards SIGTERM to Node (graceful drain, server/primary.ts and worker.ts) and reaps ffmpeg child processes.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--import", "tsx", "server/index.ts"]
