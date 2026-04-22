import type { Logger } from 'pino';
import { config } from './config.js';
import { streamClaudeResponse } from './llm/anthropic.js';
import type { SessionState } from './state/session.js';

/**
 * Outbound Conversation Relay message types this app sends.
 * For M1d we only emit `text` messages (CR renders TTS internally).
 */
export type CROutboundMessage =
  | { type: 'text'; token: string; last: boolean }
  | { type: 'end' };

/**
 * Orchestrates a single conversation turn: user utterance → Claude stream →
 * text forwarded to Conversation Relay for TTS → turn events emitted.
 *
 * One TurnManager per active CR session. Handles cancellation (barge-in)
 * by aborting the in-flight LLM stream. Preserves history-alternation
 * invariants — every user message is followed by exactly one assistant
 * message, even when a turn is interrupted (partial response is persisted
 * with a truncation marker).
 */
export class TurnManager {
  private inFlight = false;
  private abortController: AbortController | null = null;
  private currentTurnId: string | null = null;

  constructor(
    private readonly session: SessionState,
    private readonly log: Logger,
    private readonly send: (msg: CROutboundMessage) => void,
  ) {}

  isInFlight(): boolean {
    return this.inFlight;
  }

  /**
   * Abort the in-flight LLM stream and stop forwarding tokens to CR.
   * CR halts its own TTS playback natively when barge-in is detected —
   * this method stops the app from generating new tokens to send after
   * that point.
   *
   * Safe to call when no turn is in flight (no-op).
   */
  interrupt(reason: string): void {
    if (!this.inFlight || !this.abortController) return;
    this.log.info(
      {
        event: 'turn.cancellation_requested',
        turn_id: this.currentTurnId,
        reason,
      },
      'Cancelling in-flight turn',
    );
    this.abortController.abort();
  }

  async handleFinalPrompt(userText: string): Promise<void> {
    if (this.inFlight) {
      this.log.warn(
        { event: 'turn.rejected', reason: 'already_in_flight' },
        'Ignoring prompt — turn already in flight',
      );
      return;
    }

    this.inFlight = true;
    const turnId = randomId();
    this.currentTurnId = turnId;
    this.abortController = new AbortController();
    const abort = this.abortController;
    const turnLog = this.log.child({ turn_id: turnId });
    const turnStartedAt = Date.now();

    this.session.messages.push({ role: 'user', content: userText });

    turnLog.info(
      { event: 'turn.started', text: userText, ts: turnStartedAt },
      'Turn started',
    );

    const llmRequestSentAt = Date.now();
    turnLog.info({
      event: 'turn.llm.request_sent',
      model: config.anthropic.model,
      prompt_messages: this.session.messages.length,
      ts: llmRequestSentAt,
    });

    let firstTokenSeen = false;
    let firstTextSentToCr = false;
    let assistantText = '';
    let cancelled = false;
    let streamError: unknown = null;

    try {
      for await (const ev of streamClaudeResponse(this.session.messages, {
        signal: abort.signal,
      })) {
        if (abort.signal.aborted) {
          cancelled = true;
          break;
        }
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
          this.send({ type: 'text', token: ev.text, last: false });
          if (!firstTextSentToCr) {
            firstTextSentToCr = true;
            turnLog.info({
              event: 'turn.tts.first_token_sent',
              latency_from_turn_start_ms: now - turnStartedAt,
              ts: now,
              provider: 'ElevenLabs (via CR)',
            });
          }
        } else if (ev.type === 'done') {
          if (!cancelled) {
            this.send({ type: 'text', token: '', last: true });
          }
          const now = Date.now();
          turnLog.info({
            event: 'turn.llm.stream_complete',
            latency_from_turn_start_ms: now - turnStartedAt,
            response_length: assistantText.length,
            ts: now,
          });
        }
      }
    } catch (err) {
      if (abort.signal.aborted) {
        cancelled = true;
      } else {
        streamError = err;
      }
    }

    try {
      if (streamError) {
        turnLog.error({ event: 'session.error', err: streamError }, 'LLM stream failed');
        const fallback = "Sorry, I'm having trouble on my end. Could you say that again?";
        this.send({ type: 'text', token: fallback, last: true });
        // Persist fallback as assistant message to preserve role alternation.
        this.session.messages.push({ role: 'assistant', content: fallback });
      } else if (cancelled) {
        const persisted = assistantText.length > 0 ? assistantText : '(interrupted)';
        this.session.messages.push({ role: 'assistant', content: persisted });
        turnLog.info(
          {
            event: 'turn.cancelled',
            partial_response_length: assistantText.length,
            total_latency_ms: Date.now() - turnStartedAt,
          },
          'Turn cancelled by interrupt',
        );
      } else {
        this.session.messages.push({ role: 'assistant', content: assistantText });
        turnLog.info({
          event: 'turn.completed',
          total_latency_ms: Date.now() - turnStartedAt,
          response: assistantText,
        });
      }
    } finally {
      this.inFlight = false;
      this.abortController = null;
      this.currentTurnId = null;
    }
  }
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}
