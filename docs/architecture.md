# Architecture

## System overview

```
                     ┌──────────────────┐
  caller (PSTN/SIP)  │     Twilio       │
  ◄──────────────►   │  Voice Platform  │
                     └────────┬─────────┘
                              │  Conversation Relay TwiML
                              ▼
                     ┌──────────────────┐
                     │   Conversation   │ ── STT (Deepgram or Google)
                     │      Relay       │ ── TTS (ElevenLabs)
                     └────────┬─────────┘
                              │  WebSocket (CR protocol — text only)
                              ▼
                     ┌──────────────────┐
                     │   App Server     │ ───► Anthropic Claude (streaming)
                     │ (Node.js / TS)   │      (text responses sent back to CR;
                     └──────────────────┘       CR renders audio via ElevenLabs)
```

**Important:** In CR mode, the app exchanges TEXT over the WebSocket. STT and TTS both run inside Conversation Relay. ElevenLabs is configured via TwiML attributes (`ttsProvider`, `voice`) and CR handles the integration. For raw audio handoff from app to caller, use Media Streams (future companion repo).

## Components

| Component | Role | Chosen because |
|---|---|---|
| **Twilio Voice** | PSTN/SIP ingress + outbound audio | Broad carrier coverage; mature SDK |
| **Conversation Relay** | STT, speech partials, barge-in, DTMF handling | Handles the hard real-time parts; saves ~400 LOC of custom WebSocket buffering versus raw Media Streams |
| **WebSocket (CR protocol)** | App ⇄ CR transport | Bidirectional, low overhead |
| **Node.js / TypeScript** | Application server | Strong ecosystem for CR; matches RecallIQ's stack |
| **Anthropic Claude** | Response generation (default) | Streaming API, reasoning quality, brand alignment |
| **ElevenLabs** | Voice output | Benchmark-leading latency + quality at time of writing |

## Key architectural decisions

### Why Conversation Relay, not raw Media Streams?

Raw Media Streams gives you full control over the audio pipeline — custom STT, custom VAD, custom TTS pipeline, custom barge-in detection. The cost is 400+ lines of WebSocket protocol handling, audio buffering, silence detection, and interrupt logic that Conversation Relay gives you for free.

For a reference architecture focused on the **pattern** of voice AI at the application level, CR is the right layer. A companion repo (`voice-ai-media-streams-custom-stt-tts`, future) will cover the lower-level case.

### Why Anthropic Claude as the default?

Streaming responsiveness, reasoning quality under ambiguity (common in support-style conversations), and Sam's brand alignment around Anthropic's positioning. OpenAI is included as a swap-in example in `src/llm/openai.ts` to show the interface is clean.

### Why in-memory conversation state?

Single-node, single-session simplicity. A production deployment would swap the state adapter for Redis — `src/state/Store.ts` is the interface, `src/state/MemoryStore.ts` is the v1 implementation. A Redis adapter can drop in without touching the rest of the code.

### Why real Twilio calls in the benchmark (not mocks)?

For a repo whose credibility rests on latency numbers, mocks destroy the point. Real calls cost ~$0.04 each; a 50-call benchmark run is roughly $2. Transparency about cost > simulated numbers.

## Data flow (one turn)

1. Caller speaks. Twilio streams audio to Conversation Relay.
2. CR runs STT (configured provider: Deepgram by default), emits partials to the app over WebSocket.
3. On final utterance (CR emits `prompt` with `last: true`), the app:
   - Starts a new turn, logs `turn.started`.
   - Pushes the user text onto the session's message history.
   - Calls Anthropic Claude with streaming enabled, logs `turn.llm.request_sent`.
4. On first Claude token: logs `turn.llm.first_token`. App forwards each token to CR as a `{ type: "text", token, last: false }` message.
5. On first text sent to CR: logs `turn.tts.first_token_sent`. CR begins its internal ElevenLabs round-trip.
6. CR renders audio via ElevenLabs and streams it to the caller. Timing inside CR is opaque to the app.
7. Claude stream ends: app sends terminal `{ type: "text", token: "", last: true }` to flush CR's TTS, logs `turn.llm.stream_complete`.
8. If the caller speaks during playback, CR emits `interrupt` → app logs `turn.interrupted`. In-flight LLM cancellation is a TODO for M1d.
9. Turn completes: `turn.completed` with total latency.

## Failure-mode surface

See [failure-modes.md](./failure-modes.md).

## Observability boundaries

**What the app can measure directly:**
- `turn.llm.request_sent` → `turn.llm.first_token`: Claude's first-token latency.
- `turn.llm.first_token` → `turn.tts.first_token_sent`: the app's local handoff (typically < 5ms).
- `turn.llm.request_sent` → `turn.llm.stream_complete`: Claude's full-response latency.
- Total `turn.completed.ts − turn.started.ts`.

**What the app cannot measure in CR mode:**
- CR's internal `text → ElevenLabs API → audio-to-caller` path. Once text leaves the app's WebSocket, the rest of the pipeline is inside Conversation Relay.
- STT inner timing (CR emits finals but not its own internal time-to-STT).
- Actual first-audio-byte-arriving-at-caller timestamp.

This is an inherent limitation of CR: the app-to-CR interface is text, so app-level instrumentation ends at the WebSocket. For full pipeline instrumentation down to the audio level, use raw Media Streams (future companion repo `voice-ai-media-streams-custom-stt-tts`).

**For the benchmark harness (M2):** out-of-band direct calls to the ElevenLabs API will produce a TTS-first-byte baseline independent of CR, giving a reasonable proxy for CR's ElevenLabs hop cost.

See [latency-budget.md](./latency-budget.md) for event schema and measured metrics.
