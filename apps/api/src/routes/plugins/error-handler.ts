import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { ApiErrorBody } from '@slotline/shared';
import { AppError } from '../../lib/errors.js';

/**
 * One place converts a thrown thing into a response. Client-facing bodies carry a code
 * and a generic message; the detail goes to the log. A stack trace in a response hands
 * over the internals. SPEC §9.
 */
export function registerErrorHandler(
  app: FastifyInstance,
  options: { spaFallback: boolean } = { spaFallback: false },
): void {
  app.setErrorHandler(
    (error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply) => {
      if (error instanceof AppError) {
        request.log.info({ code: error.code, status: error.status }, 'request rejected');
        return reply.status(error.status).send(error.toBody());
      }

      if (error instanceof ZodError) {
        const body: ApiErrorBody = {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Some fields are not valid.',
            details: {
              issues: error.issues.map((issue) => ({
                path: issue.path.join('.'),
                message: issue.message,
              })),
            },
          },
        };
        return reply.status(422).send(body);
      }

      const status =
        'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
      if (status >= 500) {
        request.log.error({ err: error }, 'unhandled error');
        const body: ApiErrorBody = {
          error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' },
        };
        return reply.status(500).send(body);
      }

      // Fastify's own 4xx (malformed JSON, unsupported media type, payload too large).
      request.log.info({ err: error, status }, 'request rejected by framework');
      const body: ApiErrorBody = {
        error: { code: 'VALIDATION_FAILED', message: 'That request could not be processed.' },
      };
      return reply.status(status).send(body);
    },
  );

  /*
   * Client-side routing means /calendar and /people are not files, so anything that is
   * not an API path falls through to the SPA shell and the router takes it from there.
   * API paths keep their JSON 404: a shell answering a mistyped endpoint with 200 and
   * HTML is a debugging trap.
   */
  app.setNotFoundHandler((request, reply) => {
    const isApi = request.url.startsWith('/api/') || request.url === '/health';
    if (options.spaFallback && !isApi) return reply.sendFile('index.html');

    const body: ApiErrorBody = { error: { code: 'NOT_FOUND', message: 'No such endpoint.' } };
    return reply.status(404).send(body);
  });
}
