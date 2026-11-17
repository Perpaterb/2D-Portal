#!/usr/bin/env bash
# Runs the server tests against the local Supabase stack (starts it if needed).
# The function must be served with the same ADMIN_PASSWORD, see scripts/supabase-local.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/supabase-local.sh
npx vitest run --config vitest.server.config.ts "$@"
