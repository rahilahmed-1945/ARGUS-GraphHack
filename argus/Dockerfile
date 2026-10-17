# ARGUS — single-container image for a ₹0 public demo (docs/DEPLOY_RENDER.md).
# One container runs FalkorDB (the pinned 6.0.1 image, bound to localhost only) and the ARGUS command-center server
# (Node 22, copied from the official image; both are Debian/glibc so the binary runs as-is). The runtime, the agent
# safety mechanisms and the ACL boundary are exactly those of the local demo: the entrypoint starts FalkorDB, waits for
# PING, runs the same ACL bootstrap (graph/acl.js) and then exec's app/ui-server.js, which binds ARGUS_UI_HOST:PORT.
# Nothing is persisted: every start resets TWIN/WORLD, as the local demo does.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM falkordb/falkordb:6.0.1@sha256:e2765e207e5ba4ee90e47ed31eb7491ad6dd3d42241c326e429375c02ad9882f
ENV NODE_ENV=production \
    BROWSER=0 \
    ARGUS_FALKORDB_HOST=127.0.0.1 \
    ARGUS_FALKORDB_PORT=6379 \
    ARGUS_UI_HOST=0.0.0.0 \
    ARGUS_UI_MODE=replay \
    ARGUS_UI_CASSETTE=cassettes/public-live-replay.json
COPY --from=deps /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN chmod +x docker/entrypoint.sh
EXPOSE 10000
ENTRYPOINT ["/app/docker/entrypoint.sh"]
