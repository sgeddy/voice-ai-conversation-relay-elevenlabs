import type { WebSocket } from 'ws';
import { logger } from './logger.js';
import { sessionStore } from './state/session.js';
import { TurnManager, type CROutboundMessage } from './turn.js';

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

export function handleConversationRelayConnection(socket: WebSocket): void {
  let sessionId = tempId();
  let log = logger.child({ session_id: sessionId });
  let turnManager: TurnManager | null = null;

  log.info({ event: 'session.opened' }, 'Conversation Relay connected');

  const send = (msg: CROutboundMessage) => {
    socket.send(JSON.stringify(msg));
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
          const session = sessionStore.getOrCreate(sessionId, {
            from: msg.from,
            to: msg.to,
          });
          turnManager = new TurnManager(session, log, send);
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
        if (msg.last && msg.voicePrompt && turnManager) {
          void turnManager.handleFinalPrompt(msg.voicePrompt);
        }
        break;
      }
      case 'interrupt':
        log.info(
          { event: 'turn.interrupted', utteranceUntilInterrupt: msg.utteranceUntilInterrupt },
          'Barge-in detected',
        );
        turnManager?.interrupt('cr.interrupt');
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
    turnManager?.interrupt('session.close');
    sessionStore.delete(sessionId);
    log.info({ event: 'session.closed', code, reason: reason.toString() });
  });

  socket.on('error', (err) => {
    turnManager?.interrupt('session.error');
    log.error({ event: 'session.error', err });
  });
}

function tempId(): string {
  return Math.random().toString(36).slice(2, 10);
}
