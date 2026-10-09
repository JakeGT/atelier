# syntax=docker/dockerfile:1
# P0 image:
#   docker build --target server -t atelier-server .
# The `runtime` (sandboxed agent workspace) and `worker` (deploy/build) targets
# arrive in P1/P3. Both run as the unprivileged `node` user; Node runs the
# TypeScript directly (type stripping), so only the web app is compiled.

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

# ---- server ----------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS server
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 WEB_DIST_DIR=/app/web
COPY --from=server-deps /src/node_modules ./node_modules
COPY --from=server-deps /src/apps/server/node_modules ./apps/server/node_modules
COPY --from=server-deps /src/packages/shared/node_modules ./packages/shared/node_modules
COPY package.json pnpm-workspace.yaml ./
COPY packages/shared packages/shared
COPY apps/server/package.json apps/server/
COPY apps/server/src apps/server/src
COPY apps/server/db apps/server/db
COPY --from=web /src/apps/web/dist /app/web

# Agent runtime: git (workspace) + the headless opencode binary (musl build).
ARG OPENCODE_VERSION=1.18.35
RUN apk add --no-cache git curl && \
    ARCH=$([ "$(uname -m)" = "aarch64" ] && echo arm64 || echo x64) && \
    curl -fsSL "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-${ARCH}-musl.tar.gz" -o /tmp/opencode.tgz && \
    tar -xzf /tmp/opencode.tgz -C /tmp && \
    mv /tmp/opencode /usr/local/bin/opencode && \
    chmod +x /usr/local/bin/opencode && \
    rm /tmp/opencode.tgz

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "apps/server/src/main.ts"]
