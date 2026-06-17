# lokyy-brain — multi-stage Dockerfile (Phase D / Coolify deploy).
# Builds three runtime images out of the same monorepo build:
#   - target `server`   → API entrypoint  (node /app/server/dist/index.js)  :8787
#   - target `mcp`      → MCP HTTP entry  (node /app/mcp/dist/binHttp.js)   :8788
#   - target `runtime`  → legacy all-in-one image (server default CMD, MCP launchable
#                          via `command: ["node", "/app/mcp/dist/binHttp.js"]`)
#
# Image layout (runtime/server/mcp):
#   /app/server/dist        — API entrypoint
#   /app/mcp/dist           — MCP HTTP entry
#   /app/pwa/dist           — built PWA static (server falls back to it on /)
#   /app/packages/{shared,core}/dist
#
# Curl is included so docker-compose healthchecks can hit /health on 8787/8788.

FROM node:22-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates openssh-client curl \
    && rm -rf /var/lib/apt/lists/*

# ─── Build ──────────────────────────────────────────────────────────────
FROM base AS build
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY server/package.json server/
COPY pwa/package.json pwa/
COPY mcp/package.json mcp/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm -r build

# ─── Runtime (legacy all-in-one — used by docker-compose.coolify.yml) ────
FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/server ./server
COPY --from=build /app/pwa/dist ./pwa/dist
COPY --from=build /app/mcp ./mcp
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./

EXPOSE 8787 8788
WORKDIR /app/server
CMD ["node", "dist/index.js"]

# ─── Server-only target (Coolify Architektur B) ─────────────────────────
# Slim image that only carries what the Hono API needs at runtime. PWA dist
# is included because the server falls back to serving it on / when no
# separate PWA container is present.
FROM base AS server
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/server ./server
COPY --from=build /app/pwa/dist ./pwa/dist
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./

EXPOSE 8787
WORKDIR /app/server
CMD ["node", "dist/index.js"]

# ─── MCP-only target (Coolify Architektur B) ────────────────────────────
# Carries the compiled MCP HTTP transport and the core/shared packages it
# imports. No server dist needed — MCP talks to the API over HTTP via
# LOKYY_BRAIN_URL or directly to Postgres via LOKYY_DB_URL.
FROM base AS mcp
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/mcp ./mcp
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./

EXPOSE 8788
WORKDIR /app/mcp
CMD ["node", "dist/binHttp.js"]
