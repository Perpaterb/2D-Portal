#!/usr/bin/env bash
# Smoke suite: points the @smoke end-to-end tests at any running copy of the site.
#   ./scripts/smoke.sh --target <url>        run against <url>
#   ./scripts/smoke.sh --verify-fails        prove the suite goes red against a dead target
set -euo pipefail
cd "$(dirname "$0")/.."

target=""
verify_fails=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) target="$2"; shift 2 ;;
    --verify-fails) verify_fails=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ $verify_fails -eq 1 ]]; then
  echo "verify-fails: running the smoke suite against a target that cannot work"
  if TARGET_URL="http://127.0.0.1:9/" npx playwright test --grep @smoke --timeout 8000 >/tmp/smoke-verify.log 2>&1; then
    echo "FAIL: smoke suite passed against a dead target; it cannot catch anything" >&2
    exit 1
  fi
  echo "OK: smoke suite went red against a dead target, as it should"
  exit 0
fi

if [[ -z "$target" ]]; then
  echo "usage: $0 --target <url> | --verify-fails" >&2
  exit 2
fi
[[ "$target" == */ ]] || target="$target/"
TARGET_URL="$target" npx playwright test --grep @smoke
