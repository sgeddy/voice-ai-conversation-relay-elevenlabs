#!/usr/bin/env bash
# infra/tail-logs.sh — stream journalctl from the running instance.
#
# Usage:
#   ./infra/tail-logs.sh                  # voice-ai (default)
#   ./infra/tail-logs.sh caddy            # Caddy access/error logs
#   ./infra/tail-logs.sh cloud-init       # cloud-init / bootstrap log
#
# Ctrl-C to exit.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$SCRIPT_DIR/_common.sh"

TARGET="${1:-voice-ai}"

ensure_ssh_key
PUBLIC_IP=$(resolve_public_ip)

case "$TARGET" in
  cloud-init|bootstrap)
    log "Tailing /var/log/cloud-init-output.log on $PUBLIC_IP (Ctrl-C to exit)..."
    exec ssh -i "$SSH_KEY_PATH" -t -o StrictHostKeyChecking=accept-new \
      "$INSTANCE_USER@$PUBLIC_IP" \
      'sudo tail -F /var/log/cloud-init-output.log'
    ;;
  *)
    log "Tailing systemd unit '$TARGET' on $PUBLIC_IP (Ctrl-C to exit)..."
    exec ssh -i "$SSH_KEY_PATH" -t -o StrictHostKeyChecking=accept-new \
      "$INSTANCE_USER@$PUBLIC_IP" \
      "sudo journalctl -u $TARGET -f --no-pager -o short-iso"
    ;;
esac
