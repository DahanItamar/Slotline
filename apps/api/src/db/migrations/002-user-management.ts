import { type Kysely, sql } from 'kysely';

/**
 * Lets the tenant-scoped role create users.
 *
 * M1 granted `app_tenant` only SELECT and UPDATE on `users`, because nothing yet created
 * one outside signup — and signup runs on the auth connection, which has no tenant
 * context to scope by. Adding a colleague does have one, so it belongs on the RLS-enforced
 * path: the policy's WITH CHECK then guarantees the new row lands in the caller's own
 * tenant, rather than a hand-written `tenant_id` in the insert being the only thing
 * standing between two organisations. SPEC §9.
 *
 * Still no DELETE: users are deactivated, never removed, so their bookings stay
 * attributable (`bookings.created_by_user_id` is ON DELETE RESTRICT).
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- Kysely migrations are schema-generic by design */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`GRANT INSERT ON users TO app_tenant`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`REVOKE INSERT ON users FROM app_tenant`.execute(db);
}
