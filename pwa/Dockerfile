# lokyy-brain PWA — multi-stage build, nginx static serve.
#
# Build stage uses the full workspace (PWA imports @lokyy/shared via pnpm).
# Runtime stage is plain nginx:alpine serving /usr/share/nginx/html with
# SPA fallback (history-mode routing → index.html).

FROM node:22-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY server/package.json server/
COPY pwa/package.json pwa/
COPY mcp/package.json mcp/
RUN pnpm install --frozen-lockfile

COPY packages ./packages
COPY pwa ./pwa
# shared must be built first since PWA imports from @lokyy/shared/dist
RUN pnpm --filter @lokyy/shared build && pnpm --filter pwa build

# ─── Runtime ────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/pwa/dist /usr/share/nginx/html
COPY pwa/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD wget -qO- http://localhost:80/ >/dev/null || exit 1
