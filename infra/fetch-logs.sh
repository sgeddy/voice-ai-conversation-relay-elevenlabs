#!/usr/bin/env bash
# infra/fetch-logs.sh — pull voice-ai journal logs from the box as JSONL.
#
# `journalctl -o cat` extracts the MESSAGE field, which is the raw pino JSON
# line the app emitted to stdout. Output is suitable for piping into
# `npm run analyze`.
#
# Usage:
#   ./infra/fetch-logs.sh                       # last 15 minutes -> /tmp/voice-ai-aws.log
#   ./infra/fetch-logs.sh --since '10 min ago'  # custom window
#   ./infra/fetch-logs.sh --since '...' --until '...' --out /tmp/foo.log

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$SCRIPT_DIR/_common.sh"

SINCE='15 min ago'
UNTIL=''
OUT="/tmp/voice-ai-aws.log"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --since) SINCE="$2"; shift 2 ;;
    --until) UNTIL="$2"; shift 2 ;;
    --out)   OUT="$2";   shift 2 ;;
    -h|--help)
      sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

ensure_ssh_key
PUBLIC_IP=$(resolve_public_ip)

UNTIL_ARG=""
[[ -n "$UNTIL" ]] && UNTIL_ARG="--until '$UNTIL'"

log "Fetching voice-ai journal since=[$SINCE] until=[${UNTIL:-now}] from $PUBLIC_IP -> $OUT"

# shellcheck disable=SC2029  # SINCE/UNTIL must expand on the local side
ssh -i "$SSH_KEY_PATH" -T -o StrictHostKeyChecking=accept-new \
    "$INSTANCE_USER@$PUBLIC_IP" \
    "sudo journalctl -u voice-ai --since '$SINCE' $UNTIL_ARG -o cat --no-pager" \
    > "$OUT"

LINES=$(wc -l < "$OUT" | tr -d ' ')
JSON_LINES=$(grep -c '^{' "$OUT" || true)

log "Wrote $LINES lines ($JSON_LINES JSON entries) to $OUT"

if [[ "$JSON_LINES" -eq 0 ]]; then
  echo "WARN: no JSON log lines in window. Was the service running and receiving calls?" >&2
  exit 2
fi

echo
echo "Analyze with:"
echo "  npm run analyze $OUT"
