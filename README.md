# voice-ai-conversation-relay-elevenlabs

Low-latency real-time voice agent — **Twilio Conversation Relay** + **ElevenLabs** TTS — with latency instrumentation on every hop, a documented failure-mode catalog, and a benchmark harness that runs against real Twilio calls.

**Why this exists.** Most public voice-AI tutorials skip measurement and ignore the real-call surface area (barge-in, DTMF, silence, transfer, carrier drop). This one doesn't. Every hop has a timestamp; every failure mode has a repro.

## Status

**In progress.** Reference implementation is being built incrementally. See [the scope doc](./docs/scope.md) for milestones.

## Architecture

```
                     ┌──────────────────┐
  caller (PSTN/SIP)  │     Twilio       │
  ◄──────────────►   │  Voice Platform  │
                     └────────┬─────────┘
                              │  (Conversation Relay TwiML)
                              ▼
                     ┌──────────────────┐
                     │   Conversation   │
                     │      Relay       │
                     │  (STT, barge-in, │
                     │  partials, DTMF) │
                     └────────┬─────────┘
                              │  WebSocket (CR protocol)
                              ▼
                     ┌──────────────────┐      ┌──────────┐
                     │   App Server     │ ───► │  Claude  │ (streaming)
                     │ (Node.js / TS)   │ ◄─── │          │
                     │                  │      └──────────┘
                     │   - State mgmt   │
                     │   - Tool calls   │      ┌──────────┐
                     │   - Instrument.  │ ───► │ElevenLabs│
                     │                  │ ◄─── │   TTS    │
                     └──────────────────┘      └──────────┘
```

Full detail in [docs/architecture.md](./docs/architecture.md).

## Stack

- **Language:** TypeScript (Node.js 20+)
- **Framework:** Fastify + `@fastify/websocket`
- **Voice platform:** Twilio Conversation Relay (Voice + WebSocket)
- **LLM:** Anthropic Claude (default) — OpenAI included as swap-in example
- **TTS:** ElevenLabs (with Conversation Relay native TTS as comparison)
- **Instrumentation:** pino (structured logs) + OpenTelemetry SDK (optional)
- **Test harness:** Vitest + Twilio REST API for real synthetic calls

## Quickstart

```bash
cp .env.example .env
# Fill in Twilio, Anthropic, and ElevenLabs credentials
npm install
npm run dev
ngrok http 3000
# Point your Twilio phone number webhook at the ngrok URL
# Call the number
```

## Latency budget

**Target:** p50 < 1500 ms, p95 < 2500 ms (utterance-end → first audio byte returned to caller).

See [docs/latency-budget.md](./docs/latency-budget.md) for per-hop breakdown and measured results.

## Analyze a call

Capture a real call's structured logs, then run them through the analyzer:

```bash
# 1. Run the server in production mode so pino emits raw JSON
NODE_ENV=production npm run dev > /tmp/voice-ai.log 2>&1 &

# 2. Make a real call through your Twilio number
#    (have a 3-minute happy-path conversation; try a barge-in too)
# 3. Stop the server (Ctrl+C / kill)

# 4. Compute per-turn latencies + p50/p95
npm run analyze /tmp/voice-ai.log
```

The analyzer (`scripts/parse-logs.ts`) groups events by `turn_id`, computes LLM first-token latency, the app-measurable proxy for first-audio-byte-to-caller, and barge-in cancellation outcomes. Compares against the documented budget. Warns when sample size is too small for stable percentiles.

## Benchmark — synthetic 50-call run

The bench harness uses the Twilio REST API to place real calls against the agent and walk a scripted conversation via `<Say>` injected through `calls.update()`. Real Twilio audio, real STT, real LLM, real TTS — measurable latency at scale.

**Prereqs:**
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` in `.env`
- `TWILIO_PHONE_NUMBER` — the bench's "from" number (your test number)
- `BENCH_AGENT_NUMBER` — the agent's destination number (the one with the CR webhook)
- Agent server running with `NODE_ENV=production` so logs are JSONL

**Cost:** ~$0.04 per call (Twilio voice). 50 calls ≈ $2.

```bash
# 1. Capture agent logs
NODE_ENV=production npm run dev > /tmp/voice-ai.log 2>&1 &

# 2. Run the bench
npm run bench -- --calls 50 --concurrency 5
# → writes /tmp/bench-run-<timestamp>.json with all call SIDs

# 3. Filter agent logs to just the bench's calls and analyze
MANIFEST=/tmp/bench-run-<timestamp>.json
jq -r '.callSids[]' "$MANIFEST" | grep -F -f /dev/stdin /tmp/voice-ai.log | npm run analyze
```

The manifest captures call SIDs, script, and timing so individual runs are reproducible and comparable across regressions.

## Production / security

The `/twiml` webhook URL is going to be public if you deploy this. Two layers of validation gate every request:

**1. Twilio signature verification.** Every Twilio webhook is signed with HMAC-SHA1 over the request URL + sorted form params, using your `TWILIO_AUTH_TOKEN` as the key. The app validates the `X-Twilio-Signature` header on every `POST /twiml` and rejects invalid or missing signatures with `403`.

**2. AccountSid allow-list.** The form body's `AccountSid` must equal the configured `TWILIO_ACCOUNT_SID`, otherwise `403`. Prevents your URL from being repurposed as a webhook for a different Twilio account.

**Critical:** `PUBLIC_BASE_URL` must match the EXACT URL Twilio uses to call your webhook. Behind any TLS-terminating reverse proxy (Caddy, nginx, ALB, ngrok), the request reaches the app at `localhost:3000` but Twilio computed the signature against the public HTTPS URL. The signature won't match unless you set `PUBLIC_BASE_URL=https://your-public-domain.com`.

### Service gates

| Env var | Default | Effect |
|---|---|---|
| `SERVICE_ACTIVE` | `true` | When `false`, `/twiml` returns 503 and CR WebSocket upgrades are refused. Useful for soft-disabling on a long-running deploy without stopping the host. |
| `DEV_BYPASS_SIGNATURE` | `false` | When `true`, skips Twilio signature validation entirely. Logs a startup warning. ONLY use for local curl-based smoke testing. **Never set in production.** |

### Health probe

`GET /healthz` returns liveness + version info:

```json
{
  "ok": true,
  "serviceActive": true,
  "name": "voice-ai-conversation-relay-elevenlabs",
  "version": "0.1.0",
  "gitSha": "abc1234",
  "nodeVersion": "v20.x.x",
  "startedAt": "2026-04-27T..."
}
```

`gitSha` resolves at startup via `git rev-parse --short HEAD`, or falls back to the `GIT_SHA` env var (set this in CI/deploy scripts where the git directory isn't available).

## Failure modes

Cataloged in [docs/failure-modes.md](./docs/failure-modes.md) with trigger, symptom, detection, mitigation, and repro for each:

- LLM provider timeout
- LLM streaming stalls mid-response
- TTS provider failure / rate limit
- STT low-confidence final
- Barge-in during TTS
- DTMF mid-speech
- Silence / no input
- LLM loop
- Context window overflow
- Call transfer request
- Hold / unhold
- Carrier drop / reconnect
- Clock skew on distributed metrics
- High end-to-end latency (mitigation: filler strategy)

## Repo layout

```
/src           — application server (Node.js / TypeScript)
/bench         — benchmark harness (real Twilio calls)
/docs          — architecture, latency budget, failure modes, scope
/.github       — CI (lint + type-check on PR)
```

## Related

- **[RecallIQ](https://github.com/sgeddy/recalliq)** — an applied case study: this pattern running in a real product I built for practicing spaced-repetition study over live phone calls.
- **Long-form writing:** [samueleddy.com](https://samueleddy.com).

## License

[MIT](./LICENSE).

---

Built by [Sam Eddy](https://samueleddy.com). Reference architectures and failure-mode catalogs for voice AI and support systems at scale.
