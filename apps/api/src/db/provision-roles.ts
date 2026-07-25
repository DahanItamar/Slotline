/**
 * One-time, per-database setup. Run before the first `npm run migrate`.
 *
 *   APP_TENANT_ROLE_PASSWORD=... APP_AUTH_ROLE_PASSWORD=... npm run provision
 *
 * Connects with APP_MIGRATION_DATABASE_URL, which must be a superuser or hold CREATEROLE.
 */
import pg from 'pg';
import { provisionRoles } from './provision.js';

function fail(message: string): never {
  console.error(`provision: ${message}`);
  process.exit(1);
}

const connectionString = process.env.APP_MIGRATION_DATABASE_URL;
const tenantPassword = process.env.APP_TENANT_ROLE_PASSWORD;
const authPassword = process.env.APP_AUTH_ROLE_PASSWORD;

if (!connectionString) fail('APP_MIGRATION_DATABASE_URL is not set.');
if (!tenantPassword) fail('APP_TENANT_ROLE_PASSWORD is not set.');
if (!authPassword) fail('APP_AUTH_ROLE_PASSWORD is not set.');

const client = new pg.Client({ connectionString });
await client.connect();

try {
  const migrationRole = await provisionRoles(client, { tenantPassword, authPassword });
  console.error('provision: roles app_tenant and app_auth are ready');
  console.error(`provision: granted app_auth to ${migrationRole}`);
  console.error('provision: done. Next: npm run migrate');
} finally {
  await client.end();
}
