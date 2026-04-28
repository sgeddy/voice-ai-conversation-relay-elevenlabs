#!/usr/bin/env bash
# infra/deploy-aws.sh — push code updates to the running instance.
#
# Flow: SSH in, git pull --ff-only, npm ci, npm run build, restart voice-ai.
# The app reads its git SHA at startup via `git rev-parse`, so /healthz will
# report the new SHA on its own — no env-file edit needed.
#
# Usage:
#   ./infra/deploy-aws.sh                     # deploy main
#   REF=feature/foo ./infra/deploy-aws.sh     # deploy a branch / tag / SHA
#
# Env overrides (via _common.sh): AWS_PROFILE, AWS_REGION, KEY_NAME,
# SSH_KEY_PATH, INSTANCE_ID, PUBLIC_IP, DOMAIN.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$SCRIPT_DIR/_common.sh"

REF="${REF:-main}"

ensure_ssh_key
PUBLIC_IP=$(resolve_public_ip)

log "Deploying ref=$REF to $PUBLIC_IP ($DOMAIN)"

ssh -i "$SSH_KEY_PATH" -T -o StrictHostKeyChecking=accept-new \
    "$INSTANCE_USER@$PUBLIC_IP" \
    "REF=$REF bash -s" <<'REMOTE'
set -euo pipefail
APP_DIR=/opt/voice-ai
APP_USER=voiceai

echo "[remote] before: $(sudo -u $APP_USER git -C $APP_DIR rev-parse --short HEAD) ($(sudo -u $APP_USER git -C $APP_DIR rev-parse --abbrev-ref HEAD))"

echo "[remote] git fetch + checkout $REF..."
sudo -u $APP_USER git -C $APP_DIR fetch --all --tags --prune
sudo -u $APP_USER git -C $APP_DIR checkout "$REF"
# Fast-forward only if we're on a tracking branch; harmless on detached HEAD.
sudo -u $APP_USER git -C $APP_DIR pull --ff-only || true

echo "[remote] npm ci..."
sudo -u $APP_USER bash -c "cd $APP_DIR && npm ci"

echo "[remote] npm run build..."
sudo -u $APP_USER bash -c "cd $APP_DIR && NODE_OPTIONS='--max-old-space-size=768' npm run build"

echo "[remote] systemctl restart voice-ai..."
sudo systemctl restart voice-ai

NEW_SHA=$(sudo -u $APP_USER git -C $APP_DIR rev-parse --short HEAD)
echo "[remote] after: $NEW_SHA"
REMOTE

log "Deploy complete. Verify:"
log "  curl -s https://$DOMAIN/healthz | jq"
log "  ./infra/tail-logs.sh"
