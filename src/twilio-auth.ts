import twilio from 'twilio';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { config } from './config.js';
import { logger } from './logger.js';

/**
 * Validate that an incoming POST /twiml request was sent by Twilio.
 *
 * Two layers of defense:
 *   1. HMAC-SHA1 signature check via the official `twilio.validateRequest()`
 *      helper. Twilio signs every webhook with the request URL + sorted
 *      form params using your auth token as the secret. Without this, anyone
 *      who finds your URL can forge webhook bodies and trigger Claude API
 *      spend.
 *   2. AccountSid match — the form body's `AccountSid` must equal the
 *      configured TWILIO_ACCOUNT_SID. Prevents your URL being used as a
 *      webhook target for a different Twilio account that happens to
 *      sign requests "correctly" with a leaked auth token.
 *
 * If `DEV_BYPASS_SIGNATURE=true` is set, both checks are skipped and a
 * warning is logged. Use ONLY for local curl-based smoke testing.
 *
 * Returns true if the request is allowed; otherwise writes the rejection
 * response and returns false.
 */
export function verifyTwilioRequest(req: FastifyRequest, reply: FastifyReply): boolean {
  if (config.service.devBypassSignature) {
    logger.warn(
      { event: 'twilio.signature_bypass' },
      'DEV_BYPASS_SIGNATURE=true — skipping Twilio signature validation. NEVER set in production.',
    );
    return true;
  }

  if (!config.twilio.authToken) {
    reply.code(503);
    void reply.send({
      error: 'Server is not configured to accept Twilio webhooks. TWILIO_AUTH_TOKEN is unset.',
    });
    logger.error(
      { event: 'twilio.auth_token_missing' },
      'Rejecting /twiml: TWILIO_AUTH_TOKEN is not set',
    );
    return false;
  }

  const signature = req.headers['x-twilio-signature'];
  if (!signature || typeof signature !== 'string') {
    reply.code(403);
    void reply.send({ error: 'Missing X-Twilio-Signature header.' });
    logger.warn(
      { event: 'twilio.signature_missing', remoteAddress: req.ip },
      'Rejecting /twiml: no X-Twilio-Signature header',
    );
    return false;
  }

  const url = reconstructWebhookUrl(req);
  const body = (req.body ?? {}) as Record<string, string>;

  const valid = twilio.validateRequest(config.twilio.authToken, signature, url, body);
  if (!valid) {
    reply.code(403);
    void reply.send({ error: 'Invalid Twilio signature.' });
    logger.warn(
      {
        event: 'twilio.signature_invalid',
        remoteAddress: req.ip,
        urlUsedForVerification: url,
      },
      'Rejecting /twiml: invalid Twilio signature',
    );
    return false;
  }

  if (config.twilio.accountSid) {
    const incomingSid = body.AccountSid;
    if (incomingSid && incomingSid !== config.twilio.accountSid) {
      reply.code(403);
      void reply.send({ error: 'AccountSid mismatch.' });
      logger.warn(
        {
          event: 'twilio.account_sid_mismatch',
          expected: config.twilio.accountSid,
          received: incomingSid,
        },
        'Rejecting /twiml: AccountSid does not match configured TWILIO_ACCOUNT_SID',
      );
      return false;
    }
  }

  return true;
}

/**
 * Twilio computes the signature using the EXACT URL it requested, including
 * scheme, host, and any query string. We need to reconstruct that here so
 * the HMAC matches.
 *
 * Behind a TLS-terminating reverse proxy (like Caddy on the EC2 host), the
 * incoming request reaches Fastify as `http://localhost:3000/twiml` even
 * though Twilio's signature was computed against `https://voice-ai...../twiml`.
 * Use PUBLIC_BASE_URL as the source of truth when set.
 */
function reconstructWebhookUrl(req: FastifyRequest): string {
  const publicBase = config.publicBaseUrl.replace(/\/$/, '');
  if (publicBase) {
    return `${publicBase}${req.url}`;
  }
  // Fallback for ngrok / local dev where headers reflect the real URL.
  const proto = (req.headers['x-forwarded-proto'] as string) ?? 'https';
  const host = (req.headers.host as string) ?? 'localhost';
  return `${proto}://${host}${req.url}`;
}
