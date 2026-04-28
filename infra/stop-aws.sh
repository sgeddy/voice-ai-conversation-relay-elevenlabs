#!/usr/bin/env bash
# infra/stop-aws.sh — stop the voice-ai EC2 instance.
#
# Does NOT terminate, just stops. EIP stays associated (free while attached
# to a stopped instance). Compute stops billing. Restart with start-aws.sh.
# Confirmation prompt unless FORCE=1.
#
# Usage:
#   ./infra/stop-aws.sh
#   FORCE=1 ./infra/stop-aws.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$SCRIPT_DIR/_common.sh"

INSTANCE_ID=$(resolve_instance_id)
STATE=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].State.Name' --output text)

case "$STATE" in
  stopped)
    log "$INSTANCE_ID is already stopped."
    exit 0
    ;;
  stopping)
    log "$INSTANCE_ID is already stopping. Waiting for 'stopped'..."
    aws ec2 wait instance-stopped --instance-ids "$INSTANCE_ID"
    log "Stopped."
    exit 0
    ;;
  running|pending)
    : # fall through
    ;;
  *)
    echo "Unexpected state: $STATE — refusing to act." >&2
    exit 1
    ;;
esac

if [[ "${FORCE:-0}" != "1" ]]; then
  read -rp "Stop $INSTANCE_ID? $DOMAIN will go offline until restart. [y/N] " confirm
  [[ "$confirm" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }
fi

log "Stopping $INSTANCE_ID..."
aws ec2 stop-instances --instance-ids "$INSTANCE_ID" >/dev/null
aws ec2 wait instance-stopped --instance-ids "$INSTANCE_ID"
log "Stopped. EIP stays associated; compute is no longer billed."
