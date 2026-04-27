# Failure-Mode Catalog

This catalog is the operations runbook for the reference architecture. Every entry documents:

- **Trigger** — what causes it
- **Symptom** — what the caller experiences
- **Detection** — how the system notices
- **Mitigation** — what the code does about it
- **Repro** — how to reproduce it for testing

## Status

14 failure modes scoped. Implementation status is tracked per entry — `[ ]` = not yet implemented, `[x]` = implemented + tested.

---

## 1. [ ] LLM provider timeout

- **Trigger:** Claude's streaming response exceeds the configured budget (default: 8s for first token, 30s total).
- **Symptom:** Agent falls silent mid-turn.
- **Detection:** Timeout on the Anthropic SDK stream. Log event `session.error` with `error_type: llm_timeout`.
- **Mitigation:** Fall back to a canned apology (`"Sorry, I had trouble with that — can you repeat?"`) spoken via TTS. Continue the session; don't drop the call.
- **Repro:** Inject a `setTimeout` in the LLM client that delays >budget.

## 2. [ ] LLM streaming stalls mid-response

- **Trigger:** LLM stream pauses for >2s between tokens (server issue, network blip).
- **Symptom:** TTS plays a partial phrase, then silence.
- **Detection:** Watchdog timer on inter-token gap.
- **Mitigation:** Flush remaining TTS, emit filler audio (`"let me think about that"`), either wait or cancel + apologize.
- **Repro:** Middleware that pauses the Anthropic stream artificially.

## 3. [ ] TTS provider failure / rate limit

- **Trigger:** ElevenLabs returns 429 or 5xx.
- **Symptom:** Agent silent or delayed badly.
- **Detection:** Non-2xx on TTS request; log `session.error`.
- **Mitigation:** Fall back to Conversation Relay's native TTS. Log which voice was used for the turn.
- **Repro:** Set invalid API key; or point to a mock endpoint that returns 429.

## 4. [ ] STT low-confidence final

- **Trigger:** Caller speech transcribed with confidence < 0.5.
- **Symptom:** LLM gets garbled input, responds to nonsense.
- **Detection:** Confidence field on CR's `final` event.
- **Mitigation:** Prompt for clarification (`"I didn't catch that — could you say it again?"`) rather than feed low-confidence text to the LLM.
- **Repro:** Play deliberately noisy audio into the call.

## 5. [ ] Barge-in during TTS

- **Trigger:** Caller begins speaking while agent is mid-response.
- **Symptom:** Caller's speech is ignored; they feel talked over.
- **Detection:** CR emits a barge-in / interruption event.
- **Mitigation:** Halt TTS immediately. Discard the rest of the LLM response. Start a new turn with the caller's new utterance.
- **Repro:** Speak over the agent during a long response.

## 6. [ ] DTMF mid-speech

- **Trigger:** Caller presses a digit during voice conversation.
- **Symptom:** Digit ignored or mishandled.
- **Detection:** CR emits a DTMF event.
- **Mitigation:** Route to IVR-style logic: either handle as explicit intent (e.g., `1` = "repeat that") or capture + treat as context for the LLM.
- **Repro:** Press any digit while speaking to the agent.

## 7. [ ] Silence / no input

- **Trigger:** Caller silent for >8s after agent finishes speaking.
- **Symptom:** Dead air.
- **Detection:** Inactivity timer.
- **Mitigation:** Prompt (`"Still there?"`). After a second silence, end the call gracefully.
- **Repro:** Stay silent after the agent's response.

## 8. [ ] LLM loop (same response repeated)

- **Trigger:** LLM produces the same or nearly identical response to the same question twice in a row.
- **Symptom:** Caller feels stuck; perceives the agent as broken.
- **Detection:** Normalized-response comparison against the last 3 turns; threshold-based similarity.
- **Mitigation:** Inject a system-message nudge (`"The user asked again; try a different angle"`) or escalate to a human-handoff prompt.
- **Repro:** Feed the agent a question it cannot answer, repeatedly.

## 9. [ ] Context window overflow

- **Trigger:** Conversation exceeds the LLM's context window over many turns.
- **Symptom:** LLM drops the earliest context; may become confused.
- **Detection:** Token count approaching model limit.
- **Mitigation:** Summarize the oldest N turns into a single system message; retain recent turns verbatim. Preserve the original system prompt.
- **Repro:** Long synthetic conversation >100 turns.

## 10. [ ] Call transfer request

- **Trigger:** Caller asks to be transferred to a human.
- **Symptom:** Agent tries to handle it conversationally instead of transferring.
- **Detection:** Intent classifier on LLM response, or explicit user-intent model.
- **Mitigation:** Use Conversation Relay's native transfer, or hand off to a Twilio Studio flow that queues to an agent.
- **Repro:** Say "transfer me to a human" during the call.

## 11. [ ] Hold / unhold

- **Trigger:** Caller (or call center) places the call on hold mid-conversation.
- **Symptom:** Agent continues talking to hold music.
- **Detection:** CR emits call-state events.
- **Mitigation:** Pause the session state machine; resume on unhold.
- **Repro:** Place the call on hold using the carrier's hold feature.

## 12. [ ] Carrier drop / reconnect

- **Trigger:** Call disconnects mid-conversation (carrier issue, bad signal).
- **Symptom:** Session state lost; if caller calls back, they start from scratch.
- **Detection:** WebSocket close event; no subsequent ping from CR.
- **Mitigation:** Persist session state keyed by caller ID; on reconnect, resume with context.
- **Repro:** Kill the carrier connection mid-call (airplane mode).

## 13. [ ] Clock skew on distributed metrics

- **Trigger:** Timestamps from different services (LLM provider, TTS provider, app server) drift.
- **Symptom:** Negative latencies in reports; impossible-to-interpret traces.
- **Detection:** Post-hoc validation in the benchmark harness.
- **Mitigation:** Use a single clock (app server) for all derived metrics. Treat provider timestamps as opaque identifiers, not measurement inputs.
- **Repro:** Deliberately skew a mock LLM's response timestamps.

## 14. [ ] High end-to-end latency (>3s)

- **Trigger:** Any combination of slow LLM, slow TTS, network blip.
- **Symptom:** Awkward silence; caller thinks the agent is dead.
- **Detection:** Running latency measurement; if projected response > 3s.
- **Mitigation:** Filler strategy — speak an acknowledgment (`"Let me check that for you"`) while generating the real response.
- **Repro:** Inject artificial latency into the LLM client.

## 15. [ ] User requests playback speed adjustment ("talk faster" / "slow down")

- **Trigger:** Caller asks the agent to change its speaking pace mid-conversation.
- **Symptom:** Agent verbally agrees ("sure, I'll ease up") but the actual TTS playback rate doesn't change. Caller perceives the agent as failing to follow a simple instruction.
- **Detection:** No automated detection — this is a UX limitation surfaced through caller behavior. Listen for repeated speed requests in transcripts.
- **Mitigation (real options):**
  - **Adjust verbosity, not pace.** Push the system prompt to bias toward shorter responses on "talk faster" and longer/more deliberate phrasing on "slow down". Verbosity is what callers actually feel.
  - **Swap voice on the fly.** Different ElevenLabs voices have different default speaking rates. Map "faster" / "slower" intents to a small set of pre-selected voices via CR's `language` / voice-config message at runtime.
  - **Surface the limitation honestly.** Have the agent acknowledge that it can't change speaking rate but offer to be more concise or more deliberate. Better than promising what it can't deliver.
- **Why this is hard:** Conversation Relay's text-mode interface doesn't expose SSML rate controls or runtime ElevenLabs `voice_settings.speed` overrides. To actually control playback rate per turn you'd need to swap to Media Streams and drive the ElevenLabs API directly with `voice_settings.speed` per request. That's the future companion repo.
- **Repro:** Make a real call. Ask "talk faster" mid-conversation. Observe the agent's response is the same speaking rate as before.
