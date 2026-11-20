#!/usr/bin/env bash
set -euo pipefail

project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$project_dir"

docker compose version >/dev/null

if [[ ! -f .env ]]; then
  if [[ -e .env ]]; then
    printf '%s\n' '.env 경로에 일반 파일을 만들 수 없습니다.' >&2
    exit 1
  fi

  env_file=$(mktemp .env.tmp.XXXXXX)
  trap 'rm -f -- "$env_file"' EXIT

  docker run --rm -i \
    --mount "type=bind,source=$project_dir/backend/src/auth/password.ts,target=/tmp/password.ts,readonly" \
    node:24-bookworm-slim node --input-type=module - > "$env_file" <<'JS'
import { randomBytes } from 'node:crypto';
import { hashPassword } from '/tmp/password.ts';

const password = randomBytes(24).toString('base64url');
console.log(`AUTH_EMAIL=operator@hackathon.local
AUTH_PASSWORD_HASH=${await hashPassword(password)}
COMPOSE_AUTH_PASSWORD=${password}
MYSQL_ROOT_PASSWORD=${randomBytes(32).toString('hex')}
MYSQL_PASSWORD=${randomBytes(32).toString('hex')}`);
JS

  if ! ln "$env_file" .env 2>/dev/null && [[ ! -f .env ]]; then
    printf '%s\n' '.env 파일을 만들 수 없습니다.' >&2
    exit 1
  fi
  rm -f -- "$env_file"
  trap - EXIT
fi

docker compose up --build --wait
