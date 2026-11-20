#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../frontend"

if [[ ! -x node_modules/.bin/vite || package-lock.json -nt node_modules/.package-lock.json ]]; then
  npm ci --include=dev --prefer-offline
fi

exec ./node_modules/.bin/vite --port "${APP_PORT:-8080}" --strictPort
