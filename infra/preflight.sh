#!/usr/bin/env bash
# infra/preflight.sh — sanity-check /etc/voice-ai.env before first start.
#
# SSHes to the instance, reads /etc/voice-ai.env, and reports any required
# keys whose values are empty. Catches the "I forgot to paste a secret" mistake
# before systemctl restart whoops you.
#
# Usage:
#   ./infra/preflight.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$SCRIPT_DIR/_common.sh"

ensure_ssh_key
PUBLIC_IP=$(resolve_public_ip)

REQUIRED=(
  TWILIO_ACCOUNT_SID
  TWILIO_AUTH_TOKEN
  ANTHROPIC_API_KEY
  ELEVENLABS_API_KEY
  ELEVENLABS_VOICE_ID
  PUBLIC_BASE_URL
)

log "Reading /etc/voice-ai.env on $PUBLIC_IP..."

# Stream the env file (root-only readable) and grep for required keys with
# empty RHS. Exit non-zero from the remote side so we surface failure cleanly.
ssh -i "$SSH_KEY_PATH" -T -o StrictHostKeyChecking=accept-new \
    "$INSTANCE_USER@$PUBLIC_IP" \
    "REQUIRED='${REQUIRED[*]}' bash -s" <<'REMOTE'
set -euo pipefail

if ! sudo test -f /etc/voice-ai.env; then
  echo "FAIL: /etc/voice-ai.env does not exist. Run bootstrap or create it."
  exit 1
fi

ENV_CONTENT=$(sudo cat /etc/voice-ai.env)
missing=()
for key in $REQUIRED; do
  # Match KEY= or KEY="" or KEY='' with no value.
  line=$(echo "$ENV_CONTENT" | grep -E "^${key}=" || true)
  if [[ -z "$line" ]]; then
    missing+=("$key (not present)")
    continue
  fi
  # strip key=, surrounding quotes, and whitespace
  value=$(echo "$line" | sed -E "s/^${key}=//; s/^['\"]//; s/['\"]$//; s/[[:space:]]*$//")
  if [[ -z "$value" ]]; then
    missing+=("$key (empty)")
  fi
done

echo
if [[ ${#missing[@]} -eq 0 ]]; then
  echo "OK — all required env vars populated:"
  for key in $REQUIRED; do echo "  $key"; done
  echo
  echo "Service status:"
  systemctl is-active voice-ai && echo "  voice-ai: running" || echo "  voice-ai: NOT running (sudo systemctl enable --now voice-ai to start)"
  systemctl is-active caddy    && echo "  caddy:    running" || echo "  caddy:    NOT running"
else
  echo "FAIL — required keys missing or empty:"
  for entry in "${missing[@]}"; do echo "  - $entry"; done
  echo
  echo "Edit with:  sudo vim /etc/voice-ai.env"
  exit 1
fi
REMOTE
