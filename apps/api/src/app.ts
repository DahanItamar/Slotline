import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { isProduction } from './config/env.js';
import { authDb } from './db/index.js';
import { startRetentionSchedule, stopRetentionSchedule } from './jobs/scheduler.js';
import { loggerOptions } from './lib/logger.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAvailabilityRoutes } from './routes/availability.js';
import { registerBookingRoutes } from './routes/bookings.js';
import { registerResourceRoutes } from './routes/resources.js';
import { registerStreamRoutes } from './routes/stream.js';
import { registerUserRoutes } from './routes/users.js';
import { startEventListener, stopEventListener } from './realtime/listener.js';
import {
  attachSession,
  requirePasswordChangeSettled,
  requireSameOrigin,
} from './routes/plugins/auth.js';
import { registerErrorHandler } from './routes/plugins/error-handler.js';
import { registerRateLimits } from './routes/plugins/rate-limit.js';
import { registerRequestLogging } from './routes/plugins/request-log.js';
import { registerSpaStatic } from './routes/static-spa.js';

/**
 * One process, one origin: the API and the built SPA are served together, so there is no
 * CORS allowlist to get wrong and no credentialed cross-origin path at all. SPEC §9.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions(),
    // Fastify's own request/response pair is replaced by one line carrying the tenant
    // and user — see routes/plugins/request-log.ts.
    disableRequestLogging: true,
    bodyLimit: 256 * 1024,
    trustProxy: true,
  });

  await app.register(cookie);

  app.decorateRequest('session', null);
  app.addHook('onRequest', attachSession);
  app.addHook('onRequest', (request, _reply, done) => {
    requireSameOrigin(request);
    requirePasswordChangeSettled(request);
    done();
  });

  await registerRateLimits(app);
  registerRequestLogging(app);

  // Static files first, so `reply.sendFile` exists by the time the not-found handler
  // that uses it is installed.
  const spaFallback = await registerSpaStatic(app);
  registerErrorHandler(app, { spaFallback });

  app.get('/health', async (_request, reply) => {
    await sql`SELECT 1`.execute(authDb());
    return reply.send({ status: 'ok' });
  });

  registerAuthRoutes(app);
  registerResourceRoutes(app);
  registerUserRoutes(app);
  registerAvailabilityRoutes(app);
  registerBookingRoutes(app);
  registerStreamRoutes(app);

  // Started after the routes are in place so a notification can never arrive before the
  // hub can dispatch it.
  app.addHook('onReady', async () => {
    await startEventListener(app.log);
    if (isProduction()) startRetentionSchedule(app.log);
  });
  app.addHook('onClose', async () => {
    stopRetentionSchedule();
    await stopEventListener();
  });

  return app;
}
