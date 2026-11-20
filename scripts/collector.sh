#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../backend"
if [[ ! -x node_modules/.bin/tsc || package-lock.json -nt node_modules/.package-lock.json ]]; then
  npm ci --include=dev --prefer-offline
fi
npm run build
exec node dist/main.js
