# Scope & Milestones

## Goal

A public, inspectable reference implementation of a low-latency real-time voice agent on **Twilio Conversation Relay** + **ElevenLabs** TTS — with latency instrumentation on every hop, documented failure modes, and a benchmark harness against real Twilio calls.

## Milestones

### M1 — Happy-path conversation + instrumentation (week 1–2)

- [ ] Repo scaffold, TypeScript + Fastify setup
- [ ] WebSocket server accepts Conversation Relay connections
- [ ] Claude integration — streaming responses
- [ ] ElevenLabs integration — streaming TTS
- [ ] Structured logging via pino with the full event schema ([see latency-budget.md](./latency-budget.md))
- [ ] 3-minute happy-path conversation works end-to-end over a real phone call

### M2 — Benchmark harness + first numbers (week 2–3)

- [ ] Synthetic-call harness using Twilio REST
- [ ] Harness initiates 50 calls with canned utterances
- [ ] Report generator: p50, p95, p99 per metric; per-turn breakdown
- [ ] First published benchmark numbers added to [latency-budget.md](./latency-budget.md)

### M3 — Failure-mode coverage (week 3–5)

- [ ] Implement 10 of the 14 failure modes listed in [failure-modes.md](./failure-modes.md)
- [ ] Each implemented mode has a documented repro + test

### M4 — Publish (week 5)

- [ ] README polished
- [ ] Project page published at [samueleddy.com/work/voice-ai-conversation-relay-elevenlabs](https://samueleddy.com/work)
- [ ] Cross-link to RecallIQ case study
- [ ] LinkedIn + Twilio-internal share

## In scope (v1)

- Conversation Relay as the voice orchestration layer
- ElevenLabs as primary TTS (with CR native TTS comparison)
- Anthropic Claude as default LLM; OpenAI example swap-in
- Instrumentation + benchmark harness
- 14-item failure-mode catalog (10 implemented for v1)

## Out of scope (v1)

- Raw Media Streams pipeline (future companion repo)
- Application-specific features (RecallIQ is the applied case study elsewhere)
- Cloud-specific IaC
- Multi-language TTS matrix

## Future companion repos

- `voice-ai-stt-benchmarks` — Deepgram vs Google vs CR built-in
- `voice-ai-media-streams-custom-stt-tts` — lower-level pattern
- `voice-ai-failover-patterns` — multi-provider failover

## Resolved design decisions (2026-04-17)

1. **Default LLM:** Anthropic Claude. OpenAI as swap-in alternate.
2. **Real-time monitoring UI:** Deferred. Structured logs + benchmark report cover v1.
3. **IaC example:** No for v1. Cloud-agnostic.
4. **License:** MIT.
5. **Conversation state store:** In-memory `Map` with adapter-shaped interface.
6. **Benchmark harness:** Real Twilio calls. Cost documented (~$2 / 50-call run).
7. **CI:** GitHub Actions — lint + type-check on PR. Benchmark run manual.
