#!/usr/bin/env bash
# infra/validate-deploy.sh — end-to-end smoke + 5-call latency validation.
#
# 1. GET https://$DOMAIN/healthz, assert 200 + JSON shape.
# 2. Run a small bench (5 calls by default, concurrency 2).
# 3. Pull voice-ai journal for the run window.
# 4. Pipe into `npm run analyze` and print the report.
#
# Run AFTER:
#   - setup-aws.sh succeeded
#   - bootstrap finished ("BOOTSTRAP COMPLETE" in cloud-init log)
#   - /etc/voice-ai.env populated (preflight.sh OK)
#   - voice-ai.service running (systemctl status voice-ai → active)
#   - Twilio number's Voice webhook points at https://$DOMAIN/twiml
#
# Usage:
#   ./infra/validate-deploy.sh                  # 5 calls, concurrency 2
#   CALLS=10 CONCURRENCY=3 ./infra/validate-deploy.sh
#   SKIP_BENCH=1 ./infra/validate-deploy.sh     # only the healthz + log dump
#
# Cost: ~$0.04/call ⇒ $0.20 for the default run.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=_common.sh
source "$SCRIPT_DIR/_common.sh"

CALLS="${CALLS:-5}"
CONCURRENCY="${CONCURRENCY:-2}"
SKIP_BENCH="${SKIP_BENCH:-0}"

# --- 1. healthz check --------------------------------------------------------

log "1/4 — GET https://$DOMAIN/healthz"
HEALTHZ=$(curl -fsS --max-time 10 "https://$DOMAIN/healthz") || {
  echo "FAIL: /healthz did not return 200." >&2
  echo "  - Is voice-ai.service running?       (./infra/preflight.sh)" >&2
  echo "  - Is Caddy serving the cert?         (./infra/tail-logs.sh caddy)" >&2
  echo "  - Is DNS pointing at the EIP?        (dig +short $DOMAIN)" >&2
  exit 1
}

echo "  $HEALTHZ"
GIT_SHA=$(echo "$HEALTHZ" | grep -oE '"gitSha":"[^"]*"' | cut -d'"' -f4 || echo "?")
log "  ✓ healthz green (gitSha=$GIT_SHA)"

if [[ "$SKIP_BENCH" == "1" ]]; then
  log "SKIP_BENCH=1 — stopping here."
  exit 0
fi

# --- 2. bench ---------------------------------------------------------------

T0=$(date -u +'%Y-%m-%d %H:%M:%S UTC')
log "2/4 — Running $CALLS-call bench (concurrency=$CONCURRENCY) at T0=$T0"
log "  estimated cost: \$$(awk "BEGIN{printf \"%.2f\", $CALLS * 0.04}")"

(cd "$REPO_ROOT" && npm run bench -- --calls "$CALLS" --concurrency "$CONCURRENCY")

# --- 3. log dump ------------------------------------------------------------

# Give the journal a moment to flush turn.completed events for late calls.
sleep 5
T1=$(date -u +'%Y-%m-%d %H:%M:%S UTC')
LOG_PATH="/tmp/voice-ai-aws-$(date -u +%Y%m%dT%H%M%SZ).log"

log "3/4 — Pulling journal from T0..T1 -> $LOG_PATH"
"$SCRIPT_DIR/fetch-logs.sh" --since "$T0" --until "$T1" --out "$LOG_PATH"

# --- 4. analyze -------------------------------------------------------------

log "4/4 — Analyzing log..."
echo
(cd "$REPO_ROOT" && npm run analyze --silent -- "$LOG_PATH")

cat <<EOF

================================================================
VALIDATION RUN COMPLETE
  gitSha:    $GIT_SHA
  T0..T1:    $T0  ..  $T1
  calls:     $CALLS @ concurrency $CONCURRENCY
  log:       $LOG_PATH

Compare the p50/p95 above to your M1e ngrok numbers.
Expected: AWS p50/p95 same or lower (no ngrok hop, real cloud network).
================================================================
EOF
