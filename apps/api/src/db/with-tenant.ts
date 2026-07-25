import { type Kysely, type Transaction, sql } from 'kysely';
import { tenantDb } from './index.js';
import type { Database } from './types.js';

export type TenantTransaction = Transaction<Database>;

/**
 * THE tenant isolation enforcement point. SPEC §9.
 *
 * Opens a transaction, sets `app.tenant_id` for its duration, and runs the callback.
 * Every RLS policy reads that setting, so a query that forgets `WHERE tenant_id = …`
 * returns zero rows rather than another tenant's rows.
 *
 * `set_config(name, value, is_local => true)` is used instead of `SET LOCAL` because
 * only the function form accepts a bound parameter — `SET LOCAL app.tenant_id = $1`
 * is a syntax error in Postgres, and string-interpolating a tenant id into DDL-ish
 * SQL is exactly the habit this function exists to remove.
 *
 * Nothing else may take a connection from the tenant pool.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (trx: TenantTransaction) => Promise<T>,
): Promise<T> {
  return tenantDb()
    .transaction()
    .execute(async (trx) => {
      await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
      return fn(trx);
    });
}

/**
 * Escape hatch for the one caller that legitimately holds its own transaction:
 * the realtime listener in M3, which reads `booking_events` per tenant. Kept separate
 * so `withTenant` stays the obvious path and this one stays greppable.
 */
export async function setTenantScope(
  trx: Kysely<Database> | TenantTransaction,
  tenantId: string,
): Promise<void> {
  await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
}
