# lokyy-updater — the only container in the stack that sees the host repo and
# the Docker socket.
#
# Build context is the repo root (`docker build -f updater/Dockerfile .`), which
# is what docker-compose.local.yml passes.
#
# The image deliberately carries nothing but node, git and the docker CLI plus
# the compose plugin. Whoever controls this container controls the Docker
# socket, and the socket is root on the host — so every additional tool in here
# is a tool attached to root. There are no runtime npm dependencies at all; the
# service uses node builtins only.

# ─── Build (TypeScript → JS) ────────────────────────────────────────────
# Standalone on purpose: the updater must not share a dependency tree with the
# application it updates, so this does not go through the pnpm workspace.
FROM node:22-alpine AS build
WORKDIR /src
# Pinned and installed locally — `types: ["node"]` resolves through node_modules,
# so a global install would not be found.
RUN npm install --no-fund --no-audit --no-package-lock typescript@5.5.4 @types/node@22.20.1
COPY updater/tsconfig.json ./tsconfig.json
COPY updater/src ./src
RUN ./node_modules/.bin/tsc -p tsconfig.json

# ─── Runtime ────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
# docker-cli-compose is the compose v2 plugin — `docker compose build` needs it.
# git is needed for the pull; the source tree lives on the host bind mount.
RUN apk add --no-cache docker-cli docker-cli-compose git ca-certificates

WORKDIR /app
ENV NODE_ENV=production \
    LOKYY_UPDATER_PORT=8799 \
    LOKYY_UPDATER_REPO=/repo
COPY --from=build /src/dist ./dist

# No EXPOSE/ports mapping by design: reachable on the compose network only.
CMD ["node", "dist/index.js"]
