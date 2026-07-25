import { authDb } from '../db/index.js';
import { withTenant } from '../db/with-tenant.js';

/**
 * Retention. SPEC §9.
 *
 * Two jobs with different reasons to exist:
 *   - `booking_events` is pruned at 30 days because that is how far back SSE replay can
 *     usefully reach. A client further behind is told to resync, so older rows serve
 *     nobody. If an audit requirement ever lands (Open Question 2), this becomes an
 *     archival step rather than a delete.
 *   - Expired sessions are removed because a table of dead rows is a table someone will
 *     eventually query and a leak waiting for a bug. The rows are already useless: the
 *     expiry is checked on every request.
 */

export const BOOKING_EVENT_RETENTION_DAYS = 30;

export type RetentionResult = {
  eventsDeleted: number;
  sessionsDeleted: number;
  tenantsVisited: number;
};

/**
 * Events are pruned tenant by tenant.
 *
 * `booking_events` is FORCE ROW LEVEL SECURITY, so there is no connection that can see
 * every tenant's rows at once — which is the point, and worth the loop. At the stated
 * scale (Assumption 10: ≤200 tenants) this is a few hundred small deletes once a day.
 * Past a few thousand tenants it would want batching or a partition drop instead.
 */
export async function runRetention(now = new Date()): Promise<RetentionResult> {
  const cutoff = new Date(now.getTime() - BOOKING_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  // Sessions live on the auth connection, which owns the table, so one statement does.
  const sessions = await authDb()
    .deleteFrom('sessions')
    .where('expires_at', '<', now)
    .executeTakeFirst();

  const tenants = await authDb().selectFrom('tenants').select('id').execute();

  let eventsDeleted = 0;
  for (const tenant of tenants) {
    const result = await withTenant(tenant.id, (trx) =>
      trx.deleteFrom('booking_events').where('created_at', '<', cutoff).executeTakeFirst(),
    );
    eventsDeleted += Number(result.numDeletedRows);
  }

  return {
    eventsDeleted,
    sessionsDeleted: Number(sessions.numDeletedRows),
    tenantsVisited: tenants.length,
  };
}
