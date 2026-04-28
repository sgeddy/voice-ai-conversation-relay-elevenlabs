#!/usr/bin/env bash
# infra/start-aws.sh — start the voice-ai EC2 instance.
#
# EIP stays associated through stop/start, so DNS keeps pointing at the same
# public IP. systemd has voice-ai.service enabled, so the app auto-starts on
# boot once the operator has populated /etc/voice-ai.env post-bootstrap.
#
# Usage:
#   ./infra/start-aws.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$SCRIPT_DIR/_common.sh"

INSTANCE_ID=$(resolve_instance_id)
STATE=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].State.Name' --output text)

case "$STATE" in
  running)
    log "$INSTANCE_ID is already running."
    ;;
  pending)
    log "$INSTANCE_ID is starting (state=pending). Waiting..."
    aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"
    ;;
  stopping)
    log "$INSTANCE_ID is currently stopping. Waiting for stopped, then starting..."
    aws ec2 wait instance-stopped --instance-ids "$INSTANCE_ID"
    aws ec2 start-instances --instance-ids "$INSTANCE_ID" >/dev/null
    aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"
    ;;
  stopped)
    log "Starting $INSTANCE_ID..."
    aws ec2 start-instances --instance-ids "$INSTANCE_ID" >/dev/null
    aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"
    ;;
  *)
    echo "Unexpected state: $STATE — refusing to act." >&2
    exit 1
    ;;
esac

PUBLIC_IP=$(resolve_public_ip)
log "Instance $INSTANCE_ID is running at $PUBLIC_IP."
echo "Verify the app came up:"
echo "  curl -s https://$DOMAIN/healthz | jq"
echo "Or tail the logs:"
echo "  ./infra/tail-logs.sh"
