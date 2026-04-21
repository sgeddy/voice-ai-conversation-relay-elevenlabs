import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

type MessageParam = Anthropic.Messages.MessageParam;

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

const DEFAULT_SYSTEM = `You are a concise voice AI assistant speaking with a caller over a live phone line. Keep responses to one to three short sentences. Do not use markdown, lists, code blocks, bullets, or other visual formatting — everything you produce will be spoken aloud by a text-to-speech engine. Speak naturally, like a real phone conversation. If a question is ambiguous, ask a clarifying question.`;

export interface LlmStreamEvent {
  type: 'text' | 'done';
  text?: string;
}

/**
 * Stream a Claude response for the given conversation history.
 * Yields text deltas as they arrive, followed by a single 'done' event.
 */
export async function* streamClaudeResponse(
  messages: MessageParam[],
  opts: { system?: string; maxTokens?: number } = {},
): AsyncGenerator<LlmStreamEvent, void, void> {
  const stream = client.messages.stream({
    model: config.anthropic.model,
    max_tokens: opts.maxTokens ?? 512,
    system: opts.system ?? DEFAULT_SYSTEM,
    messages,
  });

  for await (const event of stream) {
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta' &&
      event.delta.text
    ) {
      yield { type: 'text', text: event.delta.text };
    }
  }

  yield { type: 'done' };
}
