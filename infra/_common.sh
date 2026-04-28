# shellcheck shell=bash
# infra/_common.sh — shared helpers for laptop-side ops scripts.
# SOURCE me from another script; do not execute directly.
#
# Sets AWS profile/region as env vars so plain `aws` calls pick them up.
# Provides instance/EIP lookups by Project tag with safe multi-match handling.

# shellcheck disable=SC2034  # exported for sourcing scripts

set -euo pipefail

export AWS_PROFILE="${AWS_PROFILE:-bedison}"
export AWS_DEFAULT_REGION="${AWS_REGION:-us-east-1}"
PROJECT="voice-ai-conversation-relay-elevenlabs"
DOMAIN="${DOMAIN:-voice-ai.samueleddy.com}"
INSTANCE_USER="${INSTANCE_USER:-ec2-user}"
KEY_NAME="${KEY_NAME:-voice-ai-aws}"
SSH_KEY_PATH="${SSH_KEY_PATH:-$HOME/.ssh/${KEY_NAME}.pem}"

log() { printf '\n[%s] %s\n' "${0##*/}" "$*" >&2; }

# Echo the single instance ID tagged Project=$PROJECT (any non-terminated state).
# Errors out on zero or multiple matches; override with INSTANCE_ID env var.
resolve_instance_id() {
  if [[ -n "${INSTANCE_ID:-}" ]]; then
    echo "$INSTANCE_ID"
    return
  fi
  local ids count
  ids=$(aws ec2 describe-instances \
    --filters "Name=tag:Project,Values=$PROJECT" \
              "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[].Instances[].InstanceId' --output text)
  count=$(echo "$ids" | wc -w | tr -d ' ')
  if [[ "$count" -eq 0 ]]; then
    echo "No instance tagged Project=$PROJECT found in $AWS_DEFAULT_REGION." >&2
    echo "Run infra/setup-aws.sh first, or set INSTANCE_ID env var." >&2
    exit 1
  elif [[ "$count" -gt 1 ]]; then
    echo "Multiple instances tagged Project=$PROJECT: $ids" >&2
    echo "Set INSTANCE_ID env var to pick one." >&2
    exit 1
  fi
  echo "$ids"
}

# Echo the single EIP public IP tagged Project=$PROJECT.
# Errors out on zero or multiple matches; override with PUBLIC_IP env var.
resolve_public_ip() {
  if [[ -n "${PUBLIC_IP:-}" ]]; then
    echo "$PUBLIC_IP"
    return
  fi
  local ips count
  ips=$(aws ec2 describe-addresses \
    --filters "Name=tag:Project,Values=$PROJECT" \
    --query 'Addresses[].PublicIp' --output text)
  count=$(echo "$ips" | wc -w | tr -d ' ')
  if [[ "$count" -eq 0 ]]; then
    echo "No EIP tagged Project=$PROJECT found." >&2
    exit 1
  elif [[ "$count" -gt 1 ]]; then
    echo "Multiple EIPs tagged Project=$PROJECT: $ips" >&2
    echo "Set PUBLIC_IP env var to pick one." >&2
    exit 1
  fi
  echo "$ips"
}

ensure_ssh_key() {
  [[ -f "$SSH_KEY_PATH" ]] || {
    echo "SSH key not found at $SSH_KEY_PATH" >&2
    echo "Set KEY_NAME (filename, no extension) or SSH_KEY_PATH env var." >&2
    exit 1
  }
}
