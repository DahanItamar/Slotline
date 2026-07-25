import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { env } from '../config/env.js';
import type { Database } from './types.js';

/**
 * `date` columns stay plain calendar strings.
 *
 * node-postgres otherwise parses DATE into a JavaScript Date at local midnight in the
 * *server process's* zone. `availability_exceptions.local_date` is deliberately a date
 * and not an instant — a holiday has no timezone — and that conversion would quietly
 * give it one, shifting a closure onto the wrong day for any server not running in the
 * resource's zone. Set once, at the driver, so no query site has to remember.
 */
pg.types.setTypeParser(pg.types.builtins.DATE, (value: string) => value);

/**
 * Two pools, two database roles, two very different privilege sets. SPEC §9.
 *
 * `tenantPool` is deliberately NOT exported. The only way to reach it is `withTenant()`,
 * which sets `app.tenant_id` for the transaction — so no query can run unscoped.
 */
let tenantDbInstance: Kysely<Database> | undefined;
let authDbInstance: Kysely<Database> | undefined;
const pools: pg.Pool[] = [];

function createDb(connectionString: string, applicationName: string): Kysely<Database> {
  const pool = new pg.Pool({
    connectionString,
    application_name: applicationName,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  pools.push(pool);
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/** Internal. Use `withTenant()` — see db/with-tenant.ts. */
export function tenantDb(): Kysely<Database> {
  tenantDbInstance ??= createDb(env().APP_DATABASE_URL, 'slotline-tenant');
  return tenantDbInstance;
}

/**
 * The pre-authentication connection. Reaches `tenants`, `users` and `sessions` only —
 * the grants make anything else a permission error rather than a silent tenant leak.
 * Must be used by services/auth-service.ts and nothing else.
 */
export function authDb(): Kysely<Database> {
  authDbInstance ??= createDb(env().APP_AUTH_DATABASE_URL, 'slotline-auth');
  return authDbInstance;
}

export async function closeDatabases(): Promise<void> {
  await Promise.all([tenantDbInstance?.destroy(), authDbInstance?.destroy()]);
  tenantDbInstance = undefined;
  authDbInstance = undefined;
  pools.length = 0;
}

export type { Database };
