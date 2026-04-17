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
                     │   Conversation   │
                     │      Relay       │
                     └────────┬─────────┘
                              │  WebSocket (CR protocol)
                              ▼
                     ┌──────────────────┐
                     │   App Server     │ ───► Anthropic Claude (streaming)
                     │ (Node.js / TS)   │ ───► ElevenLabs TTS
                     └──────────────────┘
```

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
2. CR runs STT, emits partials to the app server over WebSocket.
3. On final utterance (CR emits `final`), app server:
   - Logs `turn.stt.final` with timestamp.
   - Sends the text + conversation history to Claude (streaming).
   - Logs `turn.llm.request_sent`.
4. On first Claude token: logs `turn.llm.first_token`. App begins streaming tokens to ElevenLabs.
5. On ElevenLabs first audio byte: logs `turn.tts.first_byte`. App forwards audio chunks back over the WebSocket to CR.
6. CR plays audio to the caller.
7. If caller speaks during playback, CR emits barge-in event → app halts TTS, logs `turn.interrupted`, begins new turn.
8. Turn completes: `turn.completed` with total latency.

## Failure-mode surface

See [failure-modes.md](./failure-modes.md).

## Instrumentation

See [latency-budget.md](./latency-budget.md) and the event schema in `src/instrumentation.ts`.
