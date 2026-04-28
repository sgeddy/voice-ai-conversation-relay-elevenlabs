import Fastify from 'fastify';
import websocketPlugin from '@fastify/websocket';
import formbodyPlugin from '@fastify/formbody';
import { config } from './config.js';
import { logger } from './logger.js';
import { conversationRelayTwiml, crWebsocketUrl } from './twiml.js';
import { handleConversationRelayConnection } from './cr-handler.js';
import { verifyTwilioRequest } from './twilio-auth.js';
import { VERSION } from './version.js';

async function buildServer() {
  const app = Fastify({ loggerInstance: logger });

  // Twilio webhooks are application/x-www-form-urlencoded. Fastify doesn't
  // parse that content-type by default, so without this plugin /twiml returns
  // 415 Unsupported Media Type.
  await app.register(formbodyPlugin);
  await app.register(websocketPlugin);

  /** Liveness + version probe. Exposes git SHA + node version for deploys. */
  app.get('/healthz', async () => ({
    ok: true,
    serviceActive: config.service.active,
    ...VERSION,
  }));

  /**
   * Twilio webhook — returns TwiML that instructs Twilio to connect the call
   * to the Conversation Relay WebSocket endpoint below.
   *
   * Two gates run before the TwiML is generated:
   *   1. SERVICE_ACTIVE — soft-disable returns 503
   *   2. Twilio signature + AccountSid validation
   *
   * Point your Twilio phone number's Voice webhook at:
   *   POST ${PUBLIC_BASE_URL}/twiml
   */
  app.post('/twiml', async (req, reply) => {
    if (!config.service.active) {
      reply.code(503);
      void reply.header('Retry-After', '60');
      return { error: 'Voice AI service is currently disabled.' };
    }

    if (!verifyTwilioRequest(req, reply)) {
      return reply;
    }

    let wsUrl: string;
    try {
      wsUrl = crWebsocketUrl();
    } catch (err) {
      reply.code(500);
      return { error: (err as Error).message };
    }
    reply.header('Content-Type', 'text/xml');
    return conversationRelayTwiml({ wsUrl });
  });

  /**
   * WebSocket endpoint that Twilio Conversation Relay connects to.
   * Each caller gets a new WebSocket; see cr-handler.ts for message handling.
   *
   * The /twiml gate above is the primary defense. CR will only connect here
   * after a successful TwiML response. As a belt-and-suspenders measure we
   * also check SERVICE_ACTIVE here so a stale CR session can't keep flowing
   * after the soft-disable kicks in.
   */
  app.get('/cr', { websocket: true }, (socket) => {
    if (!config.service.active) {
      logger.warn(
        { event: 'cr.upgrade_rejected', reason: 'service_inactive' },
        'Refusing CR WebSocket upgrade — SERVICE_ACTIVE=false',
      );
      socket.close(1013, 'Service inactive');
      return;
    }
    handleConversationRelayConnection(socket);
  });

  return app;
}

async function main() {
  const app = await buildServer();
  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
    logger.info(
      {
        event: 'server.started',
        port: config.port,
        version: VERSION.version,
        gitSha: VERSION.gitSha,
        serviceActive: config.service.active,
        devBypassSignature: config.service.devBypassSignature,
      },
      `Voice AI ref arch listening on :${config.port}`,
    );
    if (config.service.devBypassSignature) {
      logger.warn(
        { event: 'server.dev_bypass_warning' },
        '⚠ DEV_BYPASS_SIGNATURE is enabled. Twilio webhook signatures are NOT being validated. Production deploys must NOT have this set.',
      );
    }
  } catch (err) {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  }
}

void main();
