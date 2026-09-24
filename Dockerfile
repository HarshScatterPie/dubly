# syntax=docker/dockerfile:1
# Production image (API + built frontend in one container); pin NODE_IMAGE by digest for byte-for-byte rebuilds.
ARG NODE_IMAGE=node:24-trixie-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Firebase *client* config is baked into the frontend bundle at build time; these values are public by design.
ARG VITE_FIREBASE_API_KEY
ARG VITE_FIREBASE_AUTH_DOMAIN
ARG VITE_FIREBASE_PROJECT_ID
ARG VITE_FIREBASE_STORAGE_BUCKET
ARG VITE_FIREBASE_MESSAGING_SENDER_ID
ARG VITE_FIREBASE_APP_ID
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
# ffmpeg comes from Debian so it receives distribution security updates; rebuild the image to pick them up.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
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
# Scratch space the app writes to; credentials and server/.env are mounted at runtime, never baked in (see docs/DEPLOYMENT.md).
RUN mkdir -p server/tmp server/cache server/credentials && chown -R node:node server/tmp server/cache
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# tini forwards SIGTERM to Node (graceful drain, server/index.ts) and reaps ffmpeg child processes.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--import", "tsx", "server/index.ts"]
