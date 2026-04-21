import type { WebSocket } from 'ws';
import { logger } from './logger.js';
import { config } from './config.js';
import { sessionStore } from './state/session.js';
import { streamClaudeResponse } from './llm/anthropic.js';

/**
 * Conversation Relay inbound message types.
 * Protocol reference:
 *   https://www.twilio.com/docs/voice/twiml/connect/conversationrelay
 */
type CRInboundMessage =
  | {
      type: 'setup';
      sessionId?: string;
      callSid?: string;
      accountSid?: string;
      from?: string;
      to?: string;
      direction?: string;
      [k: string]: unknown;
    }
  | {
      type: 'prompt';
      voicePrompt?: string;
      lang?: string;
      last?: boolean;
      [k: string]: unknown;
    }
  | {
      type: 'interrupt';
      utteranceUntilInterrupt?: string;
      [k: string]: unknown;
    }
  | { type: 'dtmf'; digit?: string; [k: string]: unknown }
  | { type: 'info'; [k: string]: unknown }
  | { type: 'error'; description?: string; [k: string]: unknown };

/**
 * Conversation Relay outbound message types.
 * For M1b we only send `text` messages — CR uses its native TTS to speak them.
 * M1c swaps to ElevenLabs-provided audio chunks.
 */
type CROutboundMessage =
  | { type: 'text'; token: string; last: boolean }
  | { type: 'end' };

export function handleConversationRelayConnection(socket: WebSocket): void {
  let sessionId = tempId();
  let log = logger.child({ session_id: sessionId });
  let turnInFlight = false;

  log.info({ event: 'session.opened' }, 'Conversation Relay connected');

  const send = (msg: CROutboundMessage) => {
    socket.send(JSON.stringify(msg));
  };

  const handleFinalPrompt = async (userText: string) => {
    if (turnInFlight) {
      log.warn(
        { event: 'turn.rejected', reason: 'already_in_flight' },
        'Ignoring prompt — turn already in flight',
      );
      return;
    }
    turnInFlight = true;

    const turnId = tempId();
    const turnLog = log.child({ turn_id: turnId });
    const turnStartedAt = Date.now();

    const session = sessionStore.getOrCreate(sessionId);
    session.messages.push({ role: 'user', content: userText });

    turnLog.info(
      { event: 'turn.started', text: userText, ts: turnStartedAt },
      'Turn started',
    );

    const llmRequestSentAt = Date.now();
    turnLog.info({
      event: 'turn.llm.request_sent',
      model: config.anthropic.model,
      prompt_messages: session.messages.length,
      ts: llmRequestSentAt,
    });

    let firstTokenSeen = false;
    let audioFirstByteOutLogged = false;
    let assistantText = '';

    try {
      for await (const ev of streamClaudeResponse(session.messages)) {
        if (ev.type === 'text' && ev.text) {
          const now = Date.now();
          if (!firstTokenSeen) {
            firstTokenSeen = true;
            turnLog.info({
              event: 'turn.llm.first_token',
              latency_from_turn_start_ms: now - turnStartedAt,
              ts: now,
            });
          }
          assistantText += ev.text;
          send({ type: 'text', token: ev.text, last: false });
          if (!audioFirstByteOutLogged) {
            // For M1b we treat "first text sent to CR" as the first-audio-out
            // signal — CR's native TTS handles actual audio generation.
            // M1c swaps this for the real ElevenLabs first-byte timestamp.
            audioFirstByteOutLogged = true;
            turnLog.info({
              event: 'turn.audio.first_byte_out',
              latency_from_turn_start_ms: now - turnStartedAt,
              ts: now,
              note: 'CR native TTS — ElevenLabs swap is M1c',
            });
          }
        } else if (ev.type === 'done') {
          send({ type: 'text', token: '', last: true });
          const now = Date.now();
          turnLog.info({
            event: 'turn.llm.stream_complete',
            latency_from_turn_start_ms: now - turnStartedAt,
            response_length: assistantText.length,
            ts: now,
          });
        }
      }

      session.messages.push({ role: 'assistant', content: assistantText });
      turnLog.info({
        event: 'turn.completed',
        total_latency_ms: Date.now() - turnStartedAt,
        response: assistantText,
      });
    } catch (err) {
      turnLog.error({ event: 'session.error', err }, 'LLM stream failed');
      const fallback = "Sorry, I'm having trouble on my end. Could you say that again?";
      send({ type: 'text', token: fallback, last: true });
    } finally {
      turnInFlight = false;
    }
  };

  socket.on('message', (raw) => {
    let msg: CRInboundMessage;
    try {
      msg = JSON.parse(raw.toString()) as CRInboundMessage;
    } catch (err) {
      log.error({ err, raw: raw.toString() }, 'Failed to parse CR message');
      return;
    }

    switch (msg.type) {
      case 'setup': {
        const id = msg.sessionId ?? msg.callSid;
        if (id) {
          sessionId = id;
          log = logger.child({ session_id: sessionId });
          sessionStore.getOrCreate(sessionId, { from: msg.from, to: msg.to });
        }
        log.info(
          { event: 'cr.setup', from: msg.from, to: msg.to, direction: msg.direction },
          'Setup received',
        );
        break;
      }
      case 'prompt': {
        log.info(
          { event: 'cr.prompt', text: msg.voicePrompt, last: msg.last, lang: msg.lang },
          'User utterance',
        );
        if (msg.last && msg.voicePrompt) {
          void handleFinalPrompt(msg.voicePrompt);
        }
        break;
      }
      case 'interrupt':
        // TODO (M1d): cancel in-flight LLM stream + discard buffered tokens.
        // For M1b we just log the event; CR still halts its own TTS natively.
        log.info(
          { event: 'turn.interrupted', utteranceUntilInterrupt: msg.utteranceUntilInterrupt },
          'Barge-in detected',
        );
        break;
      case 'dtmf':
        log.info({ event: 'cr.dtmf', digit: msg.digit }, 'DTMF received');
        break;
      case 'info':
        log.debug({ event: 'cr.info', payload: msg }, 'Info message');
        break;
      case 'error':
        log.error(
          { event: 'cr.error', description: msg.description },
          'CR reported error',
        );
        break;
      default:
        log.warn({ event: 'cr.unknown', payload: msg }, 'Unhandled CR message type');
    }
  });

  socket.on('close', (code, reason) => {
    sessionStore.delete(sessionId);
    log.info({ event: 'session.closed', code, reason: reason.toString() });
  });

  socket.on('error', (err) => {
    log.error({ event: 'session.error', err });
  });
}

function tempId(): string {
  return Math.random().toString(36).slice(2, 10);
}
