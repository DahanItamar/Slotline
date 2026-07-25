import type { Client } from 'pg';

/**
 * Creates the two application roles the schema grants to. Shared by the `provision` CLI
 * and the integration-test harness so the two can never drift apart.
 *
 * Roles are cluster-level, not database-level, which is why this sits outside the
 * migration sequence — a migration should not be creating roles on every environment.
 */
export type RolePasswords = {
  tenantPassword: string;
  authPassword: string;
};

/** Neither role names nor passwords can be bound as parameters in CREATE/ALTER ROLE. */
const quoteLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`;

export async function provisionRoles(client: Client, passwords: RolePasswords): Promise<string> {
  const { rows } = await client.query<{ current_user: string }>('SELECT current_user');
  const migrationRole = rows[0]?.current_user ?? 'postgres';

  for (const [role, password] of [
    ['app_tenant', passwords.tenantPassword],
    ['app_auth', passwords.authPassword],
  ] as const) {
    // CREATE ROLE has no IF NOT EXISTS, hence the DO block.
    await client.query(
      `DO $$
       BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(role)}) THEN
           CREATE ROLE ${role} LOGIN;
         END IF;
       END $$`,
    );
    await client.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD ${quoteLiteral(password)}`);
  }

  // The migration hands ownership of tenants/users/sessions to app_auth, which requires
  // the migrating role to be a member of app_auth.
  await client.query(`GRANT app_auth TO ${migrationRole}`);
  return migrationRole;
}
