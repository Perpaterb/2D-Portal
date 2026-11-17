#!/usr/bin/env bash
# Source this: starts the local Supabase stack if needed, builds and serves the api
# function with a test admin password, and exports the env the tests and the app build use.
set -euo pipefail
export ADMIN_PASSWORD="${ADMIN_PASSWORD:-local-test-password}"
if ! npx supabase status >/dev/null 2>&1; then
  npx supabase start -x studio,imgproxy,mailpit,logflare,vector,supavisor,storage-api,realtime,postgres-meta >/dev/null
fi
eval "$(npx supabase status -o env 2>/dev/null | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY)=')"
export SUPABASE_URL="$API_URL" SUPABASE_ANON_KEY="$ANON_KEY" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"
export VITE_SUPABASE_URL="$API_URL" VITE_SUPABASE_ANON_KEY="$ANON_KEY"
npm run --silent build:sim >/dev/null
if ! curl -s -o /dev/null -X POST "$API_URL/functions/v1/api" -H "apikey: $ANON_KEY" -d '{}' --max-time 3 \
   || [[ "$(curl -s -X POST "$API_URL/functions/v1/api" -H "apikey: $ANON_KEY" -d '{}' --max-time 3)" != *"Unknown action"* ]]; then
  envfile="$(mktemp)"
  printf 'ADMIN_PASSWORD=%s\n' "$ADMIN_PASSWORD" > "$envfile"
  nohup npx supabase functions serve api --env-file "$envfile" >/tmp/2dholes-functions.log 2>&1 &
  for _ in $(seq 1 30); do
    [[ "$(curl -s -X POST "$API_URL/functions/v1/api" -H "apikey: $ANON_KEY" -d '{}' --max-time 3)" == *"Unknown action"* ]] && break
    sleep 2
  done
fi
