import type { FastifyServerOptions } from 'fastify';
import { env, isProduction } from '../config/env.js';

/**
 * Redaction is not optional. A request log carrying a session cookie hands over sessions
 * to anyone who can read it. SPEC §9.
 *
 * Options are handed to Fastify rather than a pre-built pino instance on purpose: a
 * concrete `Logger` instance specialises `FastifyInstance`'s logger generic, and every
 * function taking a `FastifyInstance` would then need the same specialisation.
 */
export const REDACTED_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  'password',
  'newPassword',
  'currentPassword',
  'passwordHash',
  'password_hash',
  'temporaryPassword',
  '*.password',
  '*.passwordHash',
  '*.temporaryPassword',
];

export function loggerOptions(): FastifyServerOptions['logger'] {
  if (env().APP_LOG_LEVEL === 'silent') return false;

  return {
    level: env().APP_LOG_LEVEL,
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    ...(isProduction()
      ? {}
      : { transport: { target: 'pino-pretty', options: { colorize: true } } }),
  };
}
