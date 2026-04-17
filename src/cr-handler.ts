import type { WebSocket } from 'ws';
import { logger } from './logger.js';

/**
 * Conversation Relay inbound message types.
 * The protocol is documented at:
 *   https://www.twilio.com/docs/voice/twiml/connect/conversationrelay
 *
 * This scaffold logs every inbound message and does not yet send responses.
 * LLM + TTS integration ships in M1b / M1c.
 */
type CRInboundMessage =
  | { type: 'setup'; [k: string]: unknown }
  | { type: 'prompt'; voicePrompt?: string; lang?: string; last?: boolean; [k: string]: unknown }
  | { type: 'interrupt'; utteranceUntilInterrupt?: string; [k: string]: unknown }
  | { type: 'dtmf'; digit?: string; [k: string]: unknown }
  | { type: 'info'; [k: string]: unknown }
  | { type: 'error'; description?: string; [k: string]: unknown };

export function handleConversationRelayConnection(socket: WebSocket): void {
  const sessionId = cryptoRandom();
  const log = logger.child({ session_id: sessionId });

  log.info({ event: 'session.opened' }, 'Conversation Relay connected');

  socket.on('message', (raw) => {
    let msg: CRInboundMessage;
    try {
      msg = JSON.parse(raw.toString()) as CRInboundMessage;
    } catch (err) {
      log.error({ err, raw: raw.toString() }, 'Failed to parse CR message');
      return;
    }

    switch (msg.type) {
      case 'setup':
        log.info({ event: 'cr.setup', payload: msg }, 'Setup received');
        break;
      case 'prompt':
        log.info(
          { event: 'cr.prompt', text: msg.voicePrompt, last: msg.last, lang: msg.lang },
          'User utterance',
        );
        break;
      case 'interrupt':
        log.info({ event: 'cr.interrupt', payload: msg }, 'Barge-in detected');
        break;
      case 'dtmf':
        log.info({ event: 'cr.dtmf', digit: msg.digit }, 'DTMF received');
        break;
      case 'info':
        log.debug({ event: 'cr.info', payload: msg }, 'Info message');
        break;
      case 'error':
        log.error({ event: 'cr.error', description: msg.description }, 'CR error');
        break;
      default:
        log.warn({ event: 'cr.unknown', payload: msg }, 'Unhandled CR message type');
    }
  });

  socket.on('close', (code, reason) => {
    log.info({ event: 'session.closed', code, reason: reason.toString() });
  });

  socket.on('error', (err) => {
    log.error({ event: 'session.error', err });
  });
}

function cryptoRandom(): string {
  return Math.random().toString(36).slice(2, 10);
}
