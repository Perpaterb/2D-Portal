#!/usr/bin/env bash
# Source this: starts the local Supabase stack if needed with the api function and a test
# admin password, and exports the env the tests and the app build use.
set -euo pipefail
export ADMIN_PASSWORD="${ADMIN_PASSWORD:-local-test-password}"
# the stack loads the api function on start: its bundled physics and secrets must exist first
npm run --silent build:sim >/dev/null
umask 077
# a small verify budget locally, so the server tests can prove the time limit without a 2 s run
printf 'ADMIN_PASSWORD=%s\nVERIFY_BUDGET_MS=%s\n' "$ADMIN_PASSWORD" "${VERIFY_BUDGET_MS:-100}" > supabase/functions/.env
if ! npx supabase status >/dev/null 2>&1; then
  npx supabase start -x studio,imgproxy,mailpit,logflare,vector,supavisor,storage-api,realtime,postgres-meta >/dev/null
fi
eval "$(npx supabase status -o env 2>/dev/null | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY)=')"
export SUPABASE_URL="$API_URL" SUPABASE_ANON_KEY="$ANON_KEY" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"
export VITE_SUPABASE_URL="$API_URL" VITE_SUPABASE_ANON_KEY="$ANON_KEY"

# ready means: the function answers and accepts this password
probe() {
  curl -s -o /dev/null -w '%{http_code}' -X POST "$API_URL/functions/v1/api" -H "apikey: $ANON_KEY" \
    -H 'Content-Type: application/json' --max-time 5 -d "{\"action\":\"unlock\",\"password\":\"$ADMIN_PASSWORD\"}" || true
}
if [[ "$(probe)" != "200" ]]; then
  # stack was already running with other settings: serve the function with ours
  nohup npx supabase functions serve api --env-file supabase/functions/.env >/tmp/2dholes-functions.log 2>&1 &
  for _ in $(seq 1 40); do [[ "$(probe)" == "200" ]] && break; sleep 2; done
fi
[[ "$(probe)" == "200" ]] || { echo "api function is not ready (see /tmp/2dholes-functions.log)" >&2; return 1 2>/dev/null || exit 1; }
