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
    model: optional('ANTHROPIC_MODEL', 'claude-opus-4-7'),
  },

  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY ?? '',
    voiceId: process.env.ELEVENLABS_VOICE_ID ?? '',
  },

  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID ?? '',
    authToken: process.env.TWILIO_AUTH_TOKEN ?? '',
    phoneNumber: process.env.TWILIO_PHONE_NUMBER ?? '',
  },
} as const;

export { required };
