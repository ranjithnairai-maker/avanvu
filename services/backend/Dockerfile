# syntax=docker/dockerfile:1.7
# One image, two Cloud Run services (D-01). Build context is the repository root:
#   docker build -f services/backend/Dockerfile -t avanvu-backend .
# The base image is pinned by digest and ffmpeg by version and SHA-256 (SPEC §9.1, CLAUDE.md non-negotiable 10).

ARG NODE_IMAGE=node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
RUN npm install -g pnpm@10.18.3
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/core/package.json packages/core/package.json
COPY services/backend/package.json services/backend/package.json
# Only the backend and core workspaces are installed; the mobile app and web site are not part of this image.
RUN pnpm install --frozen-lockfile --filter @avanvu/backend... --ignore-scripts
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY services/backend services/backend
RUN pnpm --filter @avanvu/backend build

FROM ${NODE_IMAGE} AS runtime
ARG FFMPEG_VERSION=7.0.2
ARG FFMPEG_URL=https://johnvansickle.com/ffmpeg/releases/ffmpeg-7.0.2-amd64-static.tar.xz
# First-seen hash of the archive above (recorded 2026-10-11, D-40). Re-verify against the vendor before release.
ARG FFMPEG_SHA256=abda8d77ce8309141f83ab8edf0596834087c52467f6badf376a6a2a4c87cf67
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
 && curl -fsSL "$FFMPEG_URL" -o /tmp/ffmpeg.tar.xz \
 && echo "$FFMPEG_SHA256  /tmp/ffmpeg.tar.xz" | sha256sum -c - \
 && mkdir /tmp/ffmpeg && tar -xJf /tmp/ffmpeg.tar.xz -C /tmp/ffmpeg --strip-components=1 \
 && install -m 0755 /tmp/ffmpeg/ffmpeg /usr/local/bin/ffmpeg \
 && rm -rf /tmp/ffmpeg /tmp/ffmpeg.tar.xz \
 && apt-get purge -y curl xz-utils && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* \
 && ffmpeg -version | head -1
WORKDIR /app
COPY --from=build /repo/services/backend/dist ./dist
ENV NODE_ENV=production \
    FFMPEG_PATH=/usr/local/bin/ffmpeg \
    AVANVU_ROLE=api \
    PORT=8080
USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist/main.mjs"]
