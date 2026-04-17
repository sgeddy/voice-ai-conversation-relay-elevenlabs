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

Every turn emits timestamped structured events. Correlation via `turn_id`:

```json
{
  "event": "turn.started",         "turn_id": "…", "session_id": "…", "ts": 0 }
{ "event": "turn.stt.partial",     "turn_id": "…", "text": "…", "confidence": 0.91, "ts": 120 }
{ "event": "turn.stt.final",       "turn_id": "…", "text": "…", "confidence": 0.95, "utterance_duration_ms": 1400, "ts": 340 }
{ "event": "turn.llm.request_sent","turn_id": "…", "model": "claude-opus-4-7", "prompt_tokens": 820, "ts": 345 }
{ "event": "turn.llm.first_token", "turn_id": "…", "latency_from_final_ms": 420, "ts": 765 }
{ "event": "turn.tts.request_sent","turn_id": "…", "provider": "elevenlabs", "ts": 765 }
{ "event": "turn.tts.first_byte",  "turn_id": "…", "provider": "elevenlabs", "latency_ms": 280, "ts": 1045 }
{ "event": "turn.audio.first_byte_out", "turn_id": "…", "latency_from_final_ms": 720, "ts": 1065 }
{ "event": "turn.completed",       "turn_id": "…", "total_latency_ms": 720, "ts": 1065 }
```

## Derived metrics

- `response_latency_ms` = `audio.first_byte_out.ts − stt.final.ts`
- `llm_latency_ms` = `llm.first_token.ts − llm.request_sent.ts`
- `tts_latency_ms` = `tts.first_byte.ts − tts.request_sent.ts`
- `interrupt_response_ms` = time between caller speech detected and agent audio halt

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
