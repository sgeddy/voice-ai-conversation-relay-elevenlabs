import { config } from './config.js';

/**
 * Build the TwiML that connects an inbound Twilio Voice call to this app's
 * Conversation Relay WebSocket endpoint.
 *
 * Conversation Relay handles STT, speech partials, barge-in detection, DTMF,
 * and native TTS. The WebSocket protocol exchanges JSON messages; see
 * cr-handler.ts for the message types we handle.
 */
export function conversationRelayTwiml(opts: { wsUrl: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay
      url="${opts.wsUrl}"
      welcomeGreeting="Hi, I'm a voice AI assistant. How can I help you today?"
      language="en-US"
    />
  </Connect>
</Response>`;
}

/**
 * Derive the WebSocket URL for Conversation Relay.
 * In dev: relies on PUBLIC_BASE_URL pointing at your ngrok URL.
 * The path must match the route registered in index.ts.
 */
export function crWebsocketUrl(): string {
  const base = config.publicBaseUrl;
  if (!base) {
    throw new Error(
      'PUBLIC_BASE_URL is not set. Point it at your ngrok URL (e.g. https://abc123.ngrok.app)',
    );
  }
  const wsBase = base.replace(/^http/, 'ws').replace(/\/$/, '');
  return `${wsBase}/cr`;
}
