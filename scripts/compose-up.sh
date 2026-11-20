#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
# Provision the private client credential once for both sides of the Compose network.
if [[ -z "${CLIPROXY_API_KEY:-}" ]] && ! grep -Eq "^[[:space:]]*(export[[:space:]]+)?CLIPROXY_API_KEY[[:space:]]*=[[:space:]]*['\"]?[^[:space:]'\"#]" .env 2>/dev/null; then
  (
    umask 077
    proxy_key="$(openssl rand -hex 32)"
    printf '\nCLIPROXY_API_KEY=%s\n' "$proxy_key" >> .env
  )
fi
mkdir -p -- "${RECORDINGS_DIR:-./data/recordings}" "${STATION_DIR:-./data/station}"
mkdir -p -m 700 -- "${DIRECTIONS_CACHE_DIR:-./data/directions-cache}"
export COLLECTOR_UID="${COLLECTOR_UID:-$(id -u)}" COLLECTOR_GID="${COLLECTOR_GID:-$(id -g)}"
exec docker compose up --build --wait --remove-orphans
