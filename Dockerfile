# lokyy-brain — multi-stage Dockerfile (Story 1.9)
# Build the server + PWA, ship a slim runtime image.

FROM node:22-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates openssh-client \
    && rm -rf /var/lib/apt/lists/*

# ─── Build ──────────────────────────────────────────────────────────────
FROM base AS build
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY server/package.json server/
COPY pwa/package.json pwa/
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
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./

EXPOSE 8787
WORKDIR /app/server
CMD ["node", "dist/index.js"]
