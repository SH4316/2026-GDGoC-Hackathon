#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
mkdir -p -- "${RECORDINGS_DIR:-./data/recordings}"
export COLLECTOR_UID="${COLLECTOR_UID:-$(id -u)}" COLLECTOR_GID="${COLLECTOR_GID:-$(id -g)}"
exec docker compose up --build --wait --remove-orphans
