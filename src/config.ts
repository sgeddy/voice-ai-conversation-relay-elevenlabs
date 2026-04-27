import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  port: Number(optional('PORT', '3000')),
  publicBaseUrl: optional('PUBLIC_BASE_URL', ''),
  logLevel: optional('LOG_LEVEL', 'info'),

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    // Haiku 4.5 is the default — best cost/latency profile for real-time
    // voice. Swap ANTHROPIC_MODEL to claude-sonnet-4-6 or claude-opus-4-7
    // if you need more reasoning depth and can absorb the latency hit.
    model: optional('ANTHROPIC_MODEL', 'claude-haiku-4-5-20251001'),
  },

  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY ?? '',
    // ElevenLabs voice ID rendered by CR's internal TTS pipeline. Defaults
    // to Twilio's bundled ElevenLabs voice when unset. Override with any
    // voice available in your ElevenLabs / Twilio ElevenLabs integration.
    voiceId: process.env.ELEVENLABS_VOICE_ID || 'UgBBYS2sOqTuMpoF3BR0',
  },

  // Conversation Relay STT provider. "Deepgram" is CR's default for new
  // accounts and typically has lower latency than "Google".
  transcription: {
    provider: optional('TRANSCRIPTION_PROVIDER', 'Deepgram'),
  },

  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID ?? '',
    authToken: process.env.TWILIO_AUTH_TOKEN ?? '',
    phoneNumber: process.env.TWILIO_PHONE_NUMBER ?? '',
  },

  // Benchmark harness — used by `npm run bench` to place synthetic calls.
  // The bench's "from" is twilio.phoneNumber; "to" is bench.agentNumber.
  bench: {
    agentNumber: process.env.BENCH_AGENT_NUMBER ?? '',
  },
} as const;

export { required };
