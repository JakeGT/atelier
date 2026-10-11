# syntax=docker/dockerfile:1
# Four images from one source tree (ADR-0006, ADR-0012):
#   docker build --target server      -t atelier-server:<tag> .       # control plane (internet-facing; no agent, no git, no socket)
#   docker build --target runtime     -t atelier-runtime:<tag> .      # one per project: workspace daemon + opencode + git
#   docker build --target provisioner -t atelier-provisioner:<tag> .  # the only holder of the Docker socket
#   docker build --target egress      -t atelier-egress:<tag> .       # allow-listing proxy: the workspaces' only way out
#   docker build --target deployer    -t atelier-deployer:<tag> .     # publishes websites; the only holder of the Cloudflare token
# Node runs the TypeScript directly (type stripping), so only the web app is compiled.

ARG NODE_IMAGE=node:24.19.0-alpine3.24

# ---- dependencies, from the lockfile -----------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

# ---- the web app ---------------------------------------------------------------------------------
FROM deps AS web
COPY tsconfig.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @atelier/web build

# ---- the server's production dependencies only -------------------------------------------------------
FROM ${NODE_IMAGE} AS server-deps
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --prod --filter @atelier/server...

# ---- shared application layer ----------------------------------------------------------------------
FROM ${NODE_IMAGE} AS app
WORKDIR /app
ENV NODE_ENV=production
COPY --from=server-deps /src/node_modules ./node_modules
COPY --from=server-deps /src/apps/server/node_modules ./apps/server/node_modules
COPY --from=server-deps /src/packages/shared/node_modules ./packages/shared/node_modules
COPY package.json pnpm-workspace.yaml ./
COPY packages/shared packages/shared
COPY apps/server/package.json apps/server/
COPY apps/server/src apps/server/src
COPY apps/server/db apps/server/db
COPY apps/server/templates apps/server/templates
COPY apps/server/assets apps/server/assets

# ---- server (control plane) ----------------------------------------------------------------------------
FROM app AS server
# ffmpeg: a still picture is taken from each uploaded video (services/media.ts).
RUN apk add --no-cache ffmpeg
ENV HOST=0.0.0.0 PORT=8080 WEB_DIST_DIR=/app/web RUNTIME_MODE=container
COPY --from=web /src/apps/web/dist /app/web
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "apps/server/src/main.ts"]

# ---- runtime (per-project agent workspace) --------------------------------------------------------------
FROM app AS runtime
ARG OPENCODE_VERSION=1.18.35
# ripgrep: the assistant's engine searches files with it, and downloads it from GitHub if it is
# not here; having it here is what lets github.com stay off the workspaces' allow-list.
# Chromium and a few fonts: the assistant looks at the pages it builds (mcp/look.ts).
# curl stays: the assistant downloads fonts, pictures and libraries into the website (ADR-0022).
# Media tools: the assistant edits and converts pictures and clips itself (resize, crop, JPEG to
# WebP, video to GIF, contact sheets): ffmpeg, ImageMagick, cwebp/gif2webp, gifsicle, pngquant, jpegoptim.
RUN apk add --no-cache git curl ripgrep chromium font-liberation font-dejavu font-noto-emoji \
        ffmpeg imagemagick imagemagick-jpeg imagemagick-webp imagemagick-svg imagemagick-tiff imagemagick-heic \
        libwebp-tools gifsicle pngquant jpegoptim && \
    ARCH=$([ "$(uname -m)" = "aarch64" ] && echo arm64 || echo x64) && \
    curl -fsSL "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-${ARCH}-musl.tar.gz" -o /tmp/opencode.tgz && \
    tar -xzf /tmp/opencode.tgz -C /tmp && \
    mv /tmp/opencode /usr/local/bin/opencode && \
    chmod +x /usr/local/bin/opencode && \
    rm /tmp/opencode.tgz && \
    # The project volume is mounted here; a new named volume copies this ownership.
    mkdir -p /workspace && chown node:node /workspace
ENV WORKSPACE_DIR=/workspace AGENT_STATE_DIR=/tmp/agent PORT=8090 HOME=/tmp/agent CHROMIUM_PATH=/usr/bin/chromium
USER node
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8090/healthz >/dev/null || exit 1
CMD ["node", "apps/server/src/runtime/daemon.ts"]

# ---- provisioner (Docker socket holder) --------------------------------------------------------------
# Runs as uid 0 only because the mounted socket is root:root 0660; compose drops
# every capability, so root here can open the socket and nothing more.
FROM app AS provisioner
ENV PORT=8091
EXPOSE 8091
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8091/healthz >/dev/null || exit 1
CMD ["node", "apps/server/src/runtime/provisioner-main.ts"]

# ---- egress (the workspaces' only way out) ---------------------------------------------------------
FROM app AS egress
ENV PORT=8888
USER node
EXPOSE 8888
CMD ["node", "apps/server/src/runtime/egress-main.ts"]

# ---- deployer (the only holder of the hosting credential) ------------------------------------------
# Takes an archive of a website's files from the control plane, checks it, and
# uploads it to Cloudflare Pages. Runs no project code (ADR-0010).
FROM app AS deployer
ENV PORT=8092
USER node
EXPOSE 8092
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8092/healthz >/dev/null || exit 1
CMD ["node", "apps/server/src/runtime/deployer-main.ts"]
