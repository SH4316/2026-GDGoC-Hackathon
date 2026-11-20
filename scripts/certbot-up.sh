#!/usr/bin/env bash
set -euo pipefail
umask 022
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

domain=home.soohyuk.dev
email=${1:?Usage: ./scripts/certbot-up.sh CERTBOT_EMAIL}
web_root=/var/www/2026-hackathon-2
site=/etc/nginx/conf.d/2026-hackathon-2.conf
api_snippet=/etc/nginx/snippets/2026-hackathon-2-recordings.conf
marker='# Managed by scripts/certbot-up.sh and Certbot.'

for command in npm nginx certbot sudo systemctl; do
  if ! command -v "$command" >/dev/null; then
    printf 'Required command missing: %s\n' "$command" >&2
    exit 1
  fi
done

sudo -v
if sudo test -e "$site" && [[ "$(sudo head -n 1 "$site")" != "$marker" ]]; then
  printf 'Existing Nginx configuration at %s.\n' "$site" >&2
  exit 1
fi

npm --prefix frontend ci --include=dev --prefer-offline
npm --prefix frontend run build
sudo install -d -m 0755 "$web_root"
sudo cp -R -- frontend/dist/. "$web_root/"

sudo install -D -m 0644 deploy/nginx/recordings-location.conf "$api_snippet"
if sudo test -e "$site" && ! sudo grep -Fq "include $api_snippet;" "$site" && ! sudo grep -Fq 'location /api/' "$site"; then
  # Upgrade the app server block in place, preserving Certbot's existing TLS settings.
  previous=$(mktemp)
  candidate=$(mktemp)
  trap 'rm -f -- "$previous" "$candidate"' EXIT
  sudo cat "$site" > "$previous"
  awk -v snippet="$api_snippet" '
    !inserted && /^[[:space:]]*location \/[[:space:]]*\{/ { print "    include " snippet ";"; inserted=1 }
    { print }
    END { if (!inserted) exit 1 }
  ' "$previous" > "$candidate"
  sudo install -m 0644 "$candidate" "$site"
  if ! sudo nginx -t; then
    sudo install -m 0644 "$previous" "$site"
    exit 1
  fi
fi
if ! sudo test -e "$site"; then
  sudo install -m 0644 "deploy/nginx/$domain.conf" "$site"
  if ! check=$(sudo nginx -t 2>&1) || [[ "$check" == *"conflicting server name \"$domain\""* ]]; then
    sudo rm -- "$site"
    printf '%s\n' "$check" >&2
    exit 1
  fi
fi

sudo nginx -t
sudo systemctl reload-or-restart nginx

sudo certbot --nginx --non-interactive --agree-tos --email "$email" \
  --redirect --keep-until-expiring --cert-name "2026-hackathon-2-$domain" -d "$domain"
