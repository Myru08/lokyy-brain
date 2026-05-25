# lokyy-brain — multi-stage Dockerfile (Phase D / Coolify deploy).
# Build server + PWA + MCP; ship a slim runtime image.
#
# Image layout (runtime):
#   /app/server/dist        — API entrypoint  (node dist/index.js)
#   /app/mcp/dist           — MCP HTTP entry  (node /app/mcp/dist/binHttp.js)
#   /app/pwa/dist           — built PWA static (served by server on /, fallback)
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

# ─── Runtime ────────────────────────────────────────────────────────────
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
