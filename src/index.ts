import Fastify from 'fastify';
import websocketPlugin from '@fastify/websocket';
import { config } from './config.js';
import { logger } from './logger.js';
import { conversationRelayTwiml, crWebsocketUrl } from './twiml.js';
import { handleConversationRelayConnection } from './cr-handler.js';

async function buildServer() {
  const app = Fastify({ loggerInstance: logger });

  await app.register(websocketPlugin);

  app.get('/healthz', async () => ({ ok: true }));

  /**
   * Twilio webhook — returns TwiML that instructs Twilio to connect the call
   * to the Conversation Relay WebSocket endpoint below.
   *
   * Point your Twilio phone number's Voice webhook at:
   *   POST ${PUBLIC_BASE_URL}/twiml
   */
  app.post('/twiml', async (_req, reply) => {
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
   */
  app.get('/cr', { websocket: true }, (socket) => {
    handleConversationRelayConnection(socket);
  });

  return app;
}

async function main() {
  const app = await buildServer();
  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
    logger.info(
      { event: 'server.started', port: config.port },
      `Voice AI ref arch listening on :${config.port}`,
    );
  } catch (err) {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  }
}

void main();
