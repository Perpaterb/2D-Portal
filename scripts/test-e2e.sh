#!/usr/bin/env bash
# End-to-end tests against the real local stack: built site + Supabase + server function.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/supabase-local.sh
npx playwright test "$@"
