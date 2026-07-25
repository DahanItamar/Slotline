import type { FastifyInstance } from 'fastify';

/**
 * One line per request, carrying who it was. SPEC §9.
 *
 * Fastify's own request/response pair is replaced with a single line because the useful
 * question in production is "what did this workspace do, and how slowly" — and that
 * needs the tenant and user on the same line as the path and the status, not spread
 * across two entries that have to be joined by request id.
 *
 * `tenantId` and `userId` are ids, never names or addresses: a log line should be enough
 * to find a record, not enough to be a record. Redaction of headers and password fields
 * is configured in lib/logger.ts.
 */
export function registerRequestLogging(app: FastifyInstance): void {
  app.addHook('onResponse', (request, reply, done) => {
    // Health checks would otherwise dominate the log with nothing to say.
    if (request.url === '/health') {
      done();
      return;
    }

    request.log.info(
      {
        method: request.method,
        path: request.url.split('?')[0],
        status: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
        tenantId: request.session?.tenant.id,
        userId: request.session?.user.id,
      },
      'request',
    );
    done();
  });
}
