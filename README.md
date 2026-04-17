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
