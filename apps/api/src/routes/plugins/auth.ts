import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { type MembershipRole, SESSION_COOKIE_NAME } from '@slotline/shared';
import { env, isProduction } from '../../config/env.js';
import { AppError, forbidden, unauthenticated } from '../../lib/errors.js';
import { type ResolvedSession, resolveSession } from '../../services/auth-service.js';

declare module 'fastify' {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- declaration merging needs an interface
  interface FastifyRequest {
    /** Present once `attachSession` has run. Null for an anonymous request. */
    session: ResolvedSession | null;
  }
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** onRequest: resolve the cookie into a session, or leave it null. Never rejects. */
export async function attachSession(request: FastifyRequest): Promise<void> {
  const token = request.cookies[SESSION_COOKIE_NAME];
  request.session = token ? await resolveSession(token) : null;
}

/**
 * onRequest: CSRF defence, layer two. `SameSite=Lax` already stops a cross-site POST
 * from carrying the cookie; this rejects a mismatched `Origin` outright so the check
 * does not rest on one browser behaviour alone. Requests with no `Origin` at all are
 * allowed through — that is a non-browser client, which has no ambient cookie to abuse.
 */
export function requireSameOrigin(request: FastifyRequest): void {
  if (!MUTATING_METHODS.has(request.method)) return;
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== env().APP_ORIGIN) {
    throw forbidden('Request origin is not allowed.');
  }
}

/**
 * An account created by an admin holds a temporary password that was read out loud or
 * pasted into a chat. Until it is replaced, that account can do nothing but replace it.
 *
 * Enforced server-side rather than by routing the UI to a form: hiding the rest of the
 * app is a convenience, never a control. SPEC §10 M4.
 */
const PASSWORD_CHANGE_EXEMPT = new Set(['/api/auth/password', '/api/auth/logout', '/api/me']);

export function requirePasswordChangeSettled(request: FastifyRequest): void {
  if (!request.session?.user.mustChangePassword) return;
  const path = request.url.split('?')[0] ?? '';
  if (PASSWORD_CHANGE_EXEMPT.has(path)) return;
  throw new AppError(
    'PASSWORD_CHANGE_REQUIRED',
    403,
    'Set a password of your own before using the workspace.',
  );
}

/**
 * Callback style (arity 3) deliberately. Fastify considers a hook finished either when
 * its arity is 3 or when it returns a thenable; a plain synchronous one-argument hook is
 * neither, so every *authenticated* request through it hangs until the client gives up.
 * It even looks like it works, because the unauthenticated path throws and short-circuits.
 */
export const requireAuth: preHandlerHookHandler = (request, _reply, done) => {
  if (!request.session) {
    done(unauthenticated());
    return;
  }
  done();
};

/**
 * Role enforcement, declared on the route so the requirement is visible where the route
 * is defined. Ownership checks that depend on the row itself (a member editing their own
 * booking) belong in the service, after the row is loaded. SPEC §9.
 */
export function requireRole(...allowed: MembershipRole[]): preHandlerHookHandler {
  const permitted = new Set(allowed);
  return function enforceRole(request, _reply, done) {
    if (!request.session) {
      done(unauthenticated());
      return;
    }
    if (!permitted.has(request.session.user.role)) {
      done(forbidden('This action needs an administrator.'));
      return;
    }
    done();
  };
}

/** `owner` can do everything an `admin` can. */
export const requireAdmin = (): preHandlerHookHandler => requireRole('owner', 'admin');

export function setSessionCookie(reply: FastifyReply, token: string, maxAgeSeconds: number): void {
  reply.setCookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProduction(),
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
}

/** Narrows away the null after `requireAuth` has run on the route. */
export function sessionOf(request: FastifyRequest): ResolvedSession {
  if (!request.session) throw unauthenticated();
  return request.session;
}
