#!/usr/bin/env bash
# Reproduce the Cloudflare end-to-end realtime smoke on a real workerd runtime + Durable Objects.
# Boots `wrangler dev`, runs cf-e2e-smoke.ts (client ↔ DO + server→DO publish bridge), tears down.
# Requires: wrangler (authed not needed for --local dev), node ≥22 (global fetch + WebSocket).
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8787}"
AUTH_PORT="${AUTH_PORT:-8790}"
export NIZHAL_JWT_SECRET="${NIZHAL_JWT_SECRET:-dev-secret}"
export NIZHAL_PUBLISH_SECRET="${NIZHAL_PUBLISH_SECRET:-pub-secret}"

pnpm --filter @nizhal/server build >/dev/null

log=$(mktemp)
wrangler dev -c src/adapters/cloudflare/wrangler.jsonc --port "$PORT" \
  --var "NIZHAL_JWT_SECRET:${NIZHAL_JWT_SECRET}" \
  --var "NIZHAL_PUBLISH_SECRET:${NIZHAL_PUBLISH_SECRET}" \
  --var "NIZHAL_AUTHORIZATION_URL:http://127.0.0.1:${AUTH_PORT}" \
  > "$log" 2>&1 &
WPID=$!
cleanup() { kill "$WPID" 2>/dev/null || true; pkill -f "wrangler dev" 2>/dev/null || true; pkill -f workerd 2>/dev/null || true; }
trap cleanup EXIT

for _ in $(seq 1 45); do
  grep -qiE "Ready on http" "$log" && break
  sleep 2
done

PORT="$PORT" AUTH_PORT="$AUTH_PORT" node --experimental-strip-types examples/cf-e2e-smoke.ts
