import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/**
 * Serves the built SPA from the same process as the API. SPEC §3, §9.
 *
 * This is what makes "same origin" true rather than aspirational: with one origin there
 * is no CORS allowlist to get wrong, no credentialed cross-origin request, and
 * `SameSite=Lax` on the session cookie is a complete answer rather than half of one. In
 * development the Vite proxy reproduces the same shape, so the cookie and `Origin` checks
 * behave identically in both.
 *
 * The fallback for client-side routes lives in the not-found handler — one owner, in
 * routes/plugins/error-handler.ts — because Fastify allows only one, and an API 404 and
 * a deep link into the SPA are the same event as far as routing is concerned.
 */

/** From dist/src/routes/ or src/routes/ up to the repository root, then into the web build. */
function resolveWebDist(): string | null {
  const candidates = [
    '../../../../web/dist', // running from apps/api/dist/src/routes
    '../../../web/dist', // running from apps/api/src/routes under tsx
  ];
  for (const candidate of candidates) {
    const path = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(path)) return path;
  }
  return null;
}

/** Returns true when a built SPA is present and its files are now being served. */
export async function registerSpaStatic(app: FastifyInstance): Promise<boolean> {
  const root = resolveWebDist();
  if (!root) {
    // Expected in development and in the test suite, where Vite serves the SPA or it is
    // not needed at all. Saying so beats a silent 404 on every page load in production.
    app.log.info('no built SPA found; serving the API only');
    return false;
  }

  // `wildcard: false` registers a route per real file rather than a catch-all, so static
  // serving cannot shadow an API route.
  await app.register(fastifyStatic, { root, wildcard: false });
  app.log.info({ root }, 'serving the built SPA');
  return true;
}
