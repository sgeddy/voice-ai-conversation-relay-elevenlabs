import { config } from './config.js';

/**
 * Build the TwiML that connects an inbound Twilio Voice call to this app's
 * Conversation Relay WebSocket endpoint.
 *
 * Conversation Relay handles:
 *   - STT (via `transcriptionProvider` — Deepgram or Google)
 *   - Partial + final transcripts
 *   - Barge-in detection
 *   - DTMF capture
 *   - TTS (via `ttsProvider` — ElevenLabs is the default, configurable)
 *
 * The WebSocket protocol exchanges JSON messages. The app sends TEXT
 * responses; CR renders them through the configured TTS provider. Raw audio
 * chunks are NOT part of the CR protocol (that's Media Streams — covered in
 * a future companion repo).
 */
export function conversationRelayTwiml(opts: { wsUrl: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay
      url="${opts.wsUrl}"
      welcomeGreeting="Hi, I'm a voice AI assistant. How can I help you today?"
      language="en-US"
      ttsProvider="ElevenLabs"
      voice="${config.elevenlabs.voiceId}"
      transcriptionProvider="${config.transcription.provider}"
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
