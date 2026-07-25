import type { FastifyInstance } from 'fastify';
import {
  changePasswordRequestSchema,
  loginRequestSchema,
  SESSION_COOKIE_NAME,
  SESSION_TTL_DAYS,
  type SessionDto,
  signupRequestSchema,
} from '@slotline/shared';
import { unprocessable } from '../lib/errors.js';
import * as authService from '../services/auth-service.js';
import { clearSessionCookie, requireAuth, sessionOf, setSessionCookie } from './plugins/auth.js';

const COOKIE_MAX_AGE_SECONDS = SESSION_TTL_DAYS * 24 * 60 * 60;

/** HTTP layer only: parse, call a service, shape the response. No rules live here. */
export function registerAuthRoutes(app: FastifyInstance): void {
  app.post('/api/auth/signup', async (request, reply) => {
    const parsed = signupRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      // The password floor gets its own code so the client can point at the right field.
      const weak = parsed.error.issues.some((issue) => issue.path[0] === 'password');
      if (weak)
        throw unprocessable('WEAK_PASSWORD', 'Choose a password of at least 12 characters.');
      throw parsed.error;
    }

    const issued = await authService.signup(parsed.data);
    setSessionCookie(reply, issued.token, COOKIE_MAX_AGE_SECONDS);
    const body: SessionDto = { user: issued.user, tenant: issued.tenant };
    return reply.status(201).send(body);
  });

  app.post('/api/auth/login', async (request, reply) => {
    const parsed = loginRequestSchema.parse(request.body);
    const issued = await authService.login(parsed);
    setSessionCookie(reply, issued.token, COOKIE_MAX_AGE_SECONDS);
    const body: SessionDto = { user: issued.user, tenant: issued.tenant };
    return reply.send(body);
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE_NAME];
    if (token) await authService.destroySession(token);
    clearSessionCookie(reply);
    return reply.status(204).send();
  });

  app.post('/api/auth/password', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = changePasswordRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw unprocessable('WEAK_PASSWORD', 'Choose a password of at least 12 characters.');
    }
    await authService.changePassword(sessionOf(request).user.id, parsed.data);
    // Every session was just revoked, including this one.
    clearSessionCookie(reply);
    return reply.status(204).send();
  });

  app.get('/api/me', { preHandler: requireAuth }, (request, reply) => {
    const session = sessionOf(request);
    const body: SessionDto = { user: session.user, tenant: session.tenant };
    return reply.send(body);
  });
}
