#!/bin/sh
# ARGUS single-container entrypoint (docs/DEPLOY_RENDER.md).
#   1. FalkorDB on localhost only (no persistence; the demo resets the graphs on every start and run)
#   2. the same ACL bootstrap as `npm run db:up` (admin password on `default`, restricted `agent` user)
#   3. the command-center server, exec'd so the platform's SIGTERM reaches it and it shuts down cleanly
# Required environment: ARGUS_ADMIN_PASSWORD, ARGUS_AGENT_PASSWORD (any random strings; never logged).
# Live mode additionally needs OPENROUTER_API_KEY and ARGUS_LLM_MODEL, and should set ARGUS_OPERATOR_TOKEN.
set -eu

: "${ARGUS_ADMIN_PASSWORD:?ARGUS_ADMIN_PASSWORD is required}"
: "${ARGUS_AGENT_PASSWORD:?ARGUS_AGENT_PASSWORD is required}"
: "${FALKORDB_BIN_PATH:=/var/lib/falkordb/bin}"
: "${FALKORDB_DATA_PATH:=/var/lib/falkordb/data}"
: "${ARGUS_REDIS_MAXMEMORY:=160mb}"
mkdir -p "$FALKORDB_DATA_PATH"

redis-server --bind 127.0.0.1 --port 6379 --protected-mode no \
  --save "" --appendonly no --dir "$FALKORDB_DATA_PATH" \
  --maxmemory "$ARGUS_REDIS_MAXMEMORY" --maxmemory-policy noeviction \
  --loadmodule "$FALKORDB_BIN_PATH/falkordb.so" ${FALKORDB_ARGS:-} \
  --loglevel warning &
REDIS_PID=$!

i=0
until redis-cli -h 127.0.0.1 -p 6379 ping 2>/dev/null | grep -q PONG; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then echo "FalkorDB did not answer PING within 60 s" >&2; kill "$REDIS_PID" 2>/dev/null || true; exit 1; fi
  sleep 1
done
echo "FalkorDB up (localhost:6379, no persistence)"

node graph/acl.js

# stop FalkorDB when the server exits (the platform sends SIGTERM to PID 1 = this script until exec; afterwards to node)
trap 'kill "$REDIS_PID" 2>/dev/null || true' EXIT
exec node app/ui-server.js
