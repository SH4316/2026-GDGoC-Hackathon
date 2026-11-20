#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

if [[ ! -x frontend/node_modules/.bin/vite || frontend/package-lock.json -nt frontend/node_modules/.package-lock.json ]]; then
  npm --prefix frontend ci --include=dev --prefer-offline
fi

API_HOST=127.0.0.1 ./scripts/collector.sh &
collector_pid=$!
(cd frontend && exec ./node_modules/.bin/vite --port "${APP_PORT:-8080}" --strictPort) &
web_pid=$!
cleanup() {
  kill "$web_pid" "$collector_pid" 2>/dev/null || true
  wait "$web_pid" "$collector_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
wait -n "$collector_pid" "$web_pid"
