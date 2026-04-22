# Latency Budget

## Target

**p50 < 1500 ms** / **p95 < 2500 ms** — measured from utterance-end to first audio byte delivered back to caller.

## Per-hop budget (expected)

| Hop | Expected | Notes |
|---|---|---|
| Audio ingress (caller → Twilio → CR) | 50–100 ms | Network + Twilio path |
| STT partial emission | 100–200 ms | CR streams partials as speech arrives |
| STT final (end of utterance) | 200–400 ms | Voice activity detection window |
| App-server handoff | < 10 ms | Local; if >50 ms, investigate event loop |
| LLM (Claude) first-token latency | 300–800 ms | Model + prompt-size dependent |
| LLM streaming | incremental | Streamed to TTS as tokens arrive |
| TTS (ElevenLabs) first byte | 150–400 ms | Voice + model dependent |
| Audio egress (back to caller) | 50–100 ms | Network + Twilio path |
| **Total (utterance-end → first audio byte out)** | **850–2010 ms** | p50 target 1500 ms, p95 target 2500 ms |

## Measured results

*To be populated by the benchmark harness after first runs.*

| Run date | Calls | p50 | p95 | Notes |
|---|---|---|---|---|
| TBD | 50 | — | — | Initial baseline |

## Instrumentation

Every turn emits timestamped structured events. Correlation via `turn_id`. Events currently emitted in CR mode:

```json
{ "event": "turn.started",              "turn_id": "…", "session_id": "…", "text": "…", "ts": 0 }
{ "event": "turn.llm.request_sent",     "turn_id": "…", "model": "claude-haiku-4-5-20251001", "prompt_messages": 3, "ts": 5 }
{ "event": "turn.llm.first_token",      "turn_id": "…", "latency_from_turn_start_ms": 420, "ts": 425 }
{ "event": "turn.tts.first_token_sent", "turn_id": "…", "provider": "ElevenLabs (via CR)", "latency_from_turn_start_ms": 425, "ts": 425 }
{ "event": "turn.llm.stream_complete",  "turn_id": "…", "response_length": 142, "latency_from_turn_start_ms": 980, "ts": 985 }
{ "event": "turn.completed",            "turn_id": "…", "total_latency_ms": 985, "ts": 985 }
```

Additional events surfaced from CR and session lifecycle:

```json
{ "event": "session.opened", "session_id": "…" }
{ "event": "cr.setup",       "from": "…", "to": "…", "direction": "inbound" }
{ "event": "cr.prompt",      "text": "…", "last": true, "lang": "en-US" }
{ "event": "cr.dtmf",        "digit": "1" }
{ "event": "turn.interrupted", "utteranceUntilInterrupt": "…" }
{ "event": "session.closed", "code": 1000, "reason": "…" }
{ "event": "session.error",  "err": { "message": "…" } }
```

## Derived metrics (app-measurable in CR mode)

- `llm_first_token_latency_ms` = `turn.llm.first_token.ts − turn.llm.request_sent.ts`
- `llm_full_response_latency_ms` = `turn.llm.stream_complete.ts − turn.llm.request_sent.ts`
- `app_to_cr_handoff_ms` = `turn.tts.first_token_sent.ts − turn.llm.first_token.ts` (typically < 5ms — local WebSocket write)
- `total_turn_latency_ms` = `turn.completed.ts − turn.started.ts`

## Not directly measurable in CR mode

- `cr_tts_latency_ms` — CR → ElevenLabs → audio-to-caller is opaque. Approximate with out-of-band direct ElevenLabs API calls in the benchmark harness, or switch to Media Streams for full pipeline visibility.
- `actual_first_audio_byte_to_caller` — same reason.
- `stt_latency_ms` — CR emits `prompt` messages without internal STT timing.

See [architecture.md § Observability boundaries](./architecture.md) for the full explanation.

## Benchmark methodology

The harness in `/bench`:

1. Uses Twilio REST to initiate a call from a known test number to the app under test.
2. Plays a canned audio clip of a test utterance.
3. Records the agent's response.
4. Parses the structured log output from the app server.
5. Aggregates results: p50, p95, p99 per metric; per-turn breakdown.

Cost: real Twilio calls, ~$0.04/call. A 50-call run is ~$2.

## Regression detection

Nightly benchmark run (manually triggered — costs money) compared against a committed baseline. Report uploaded as a GitHub Actions artifact.
