# syntax=docker/dockerfile:1

# --- go2rtc (live video engine), cross-compiled for the target platform -------------------
FROM --platform=$BUILDPLATFORM golang:1.24-alpine AS go2rtc
ARG TARGETOS TARGETARCH
ARG GO2RTC_VERSION=v1.9.15
ENV CGO_ENABLED=0
RUN GOOS=$TARGETOS GOARCH=$TARGETARCH go install -trimpath -ldflags "-s -w" github.com/AlexxIT/go2rtc@${GO2RTC_VERSION} \
 && mkdir -p /out \
 && find /go/bin -name go2rtc -type f -exec cp {} /out/go2rtc \;

# --- Build the hub and the web app (platform independent output) ---------------------------
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY hub/package.json hub/
COPY web/package.json web/
RUN npm ci
COPY tsconfig.base.json ./
COPY shared shared
COPY hub hub
COPY web web
RUN npm run build -w web && npm run build -w hub

# --- Runtime dependencies only (pure JavaScript, so any platform can install them) ---------
FROM --platform=$BUILDPLATFORM node:24-alpine AS deps
WORKDIR /src
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY hub/package.json hub/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace=@home-hub/hub --include-workspace-root=false

# --- Runtime image ------------------------------------------------------------------------------
FROM node:24-alpine
RUN apk add --no-cache ffmpeg tini \
 && mkdir -p /data && chown node:node /data
WORKDIR /app
COPY --from=go2rtc /out/go2rtc /usr/local/bin/go2rtc
COPY --from=deps /src/node_modules ./node_modules
COPY --from=build /src/hub/package.json ./package.json
COPY --from=build /src/hub/dist ./dist
COPY --from=build /src/web/dist ./web

ENV NODE_ENV=production \
    HUB_DATA_DIR=/data \
    HUB_HOST=0.0.0.0 \
    HUB_PORT=8080 \
    HUB_WEB_DIR=/app/web

# The hub never needs root: it runs as the unprivileged "node" user.
USER node
VOLUME /data
# 8080: web app + API (put a TLS proxy in front) · 8555: live video (WebRTC, TCP and UDP)
EXPOSE 8080 8555/tcp 8555/udp

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${HUB_PORT}/api/health" || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
