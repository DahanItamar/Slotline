import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../../lib/errors.js';

/**
 * Rate limits. SPEC §9.
 *
 * Two different jobs, so two different budgets:
 *   - Authentication is the credential-stuffing surface. Ten attempts per quarter hour,
 *     keyed on the *account being attacked* rather than the source, so moving between
 *     addresses does not reset an attacker's budget against one account.
 *   - Everything else that writes gets a generous per-user ceiling. It is there to stop a
 *     runaway client, not to police normal use — nobody books sixty rooms a minute.
 *
 * In-memory, deliberately: a shared store means Redis, and this codebase's rule is that
 * Redis needs a measured problem first. The cost is that budgets are per-process, which
 * only matters once there is a second process — recorded here so the trade-off is
 * visible rather than discovered.
 */

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const AUTH_PATHS = new Set(['/api/auth/login', '/api/auth/signup', '/api/auth/password']);

/** Authenticated callers are limited as themselves; everyone else by source address. */
function callerKey(request: FastifyRequest): string {
  return request.session ? `user:${request.session.user.id}` : `ip:${request.ip}`;
}

/**
 * For a sign-in attempt the interesting identity is the account under attack. Keying on
 * the source address alone would let an attacker spread attempts across accounts; keying
 * on the account alone would let anyone lock a colleague out, so the address is mixed in
 * as a fallback when there is no usable account in the body.
 */
function authAttemptKey(request: FastifyRequest): string {
  const body: unknown = request.body;
  if (typeof body === 'object' && body !== null && 'email' in body && 'tenantSlug' in body) {
    const { email, tenantSlug } = body;
    if (typeof email === 'string' && typeof tenantSlug === 'string') {
      return `auth:${tenantSlug}:${email.toLowerCase()}`;
    }
  }
  return `auth-ip:${request.ip}`;
}

export async function registerRateLimits(app: FastifyInstance): Promise<void> {
  await app.register(rateLimit, {
    // Applied by the hook below rather than to every route, so the long-lived SSE stream
    // is not counted against a per-minute budget — throttling reconnections is exactly
    // the wrong behaviour when a deploy has just dropped every stream. Its concurrency
    // is capped by the hub instead.
    global: false,
    /*
     * The plugin *throws* whatever this returns, so it must be an Error carrying a
     * status — returning a plain body object lands in the generic handler as an
     * unrecognised throw and becomes a 500. Returning an AppError means the existing
     * error handler renders it with no special case.
     */
    errorResponseBuilder: (_request, context) =>
      new AppError('RATE_LIMITED', 429, `Too many requests. Try again in ${context.after}.`),
  });

  const limitAuthAttempts = app.rateLimit({
    max: 10,
    timeWindow: '15 minutes',
    keyGenerator: authAttemptKey,
  });
  const limitWrites = app.rateLimit({
    max: 60,
    timeWindow: '1 minute',
    keyGenerator: callerKey,
  });

  /*
   * preHandler rather than onRequest, because the auth key is read out of the parsed
   * body. Registered as one hook on the shape of the request rather than per route, so a
   * future endpoint cannot arrive unprotected by someone forgetting to opt in.
   */
  app.addHook('preHandler', async (request, reply) => {
    const path = request.url.split('?')[0] ?? '';

    if (AUTH_PATHS.has(path) && request.method === 'POST') {
      await limitAuthAttempts.call(app, request, reply);
      return;
    }
    if (MUTATING_METHODS.has(request.method)) {
      await limitWrites.call(app, request, reply);
    }
  });
}
