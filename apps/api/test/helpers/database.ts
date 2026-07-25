import {
  Kysely,
  type Migration,
  type MigrationProvider,
  Migrator,
  PostgresDialect,
  sql,
} from 'kysely';
import pg from 'pg';
import { describeUnknown } from '../../src/lib/errors.js';
import * as initialSchema from '../../src/db/migrations/001-initial-schema.js';
import * as userManagement from '../../src/db/migrations/002-user-management.js';
import { provisionRoles } from '../../src/db/provision.js';
import type { Database } from '../../src/db/types.js';

/**
 * Integration tests run against a real Postgres. There is no in-memory substitute that
 * has GiST exclusion constraints or row-level security, and those are the two things
 * most worth testing — a fake would assert that the fake works.
 */

export const hasDatabase = Boolean(
  process.env.APP_MIGRATION_DATABASE_URL && process.env.APP_DATABASE_URL,
);

const TEST_ROLE_PASSWORD = 'test_password';

class StaticMigrationProvider implements MigrationProvider {
  getMigrations(): Promise<Record<string, Migration>> {
    return Promise.resolve({
      '001-initial-schema': initialSchema,
      '002-user-management': userManagement,
    });
  }
}

let adminDb: Kysely<Database> | undefined;

function admin(): Kysely<Database> {
  adminDb ??= new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: process.env.APP_MIGRATION_DATABASE_URL }),
    }),
  });
  return adminDb;
}

/** Provisions roles and brings the schema to latest. Safe to call repeatedly. */
export async function setupDatabase(): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.APP_MIGRATION_DATABASE_URL });
  await client.connect();
  try {
    await provisionRoles(client, {
      tenantPassword: TEST_ROLE_PASSWORD,
      authPassword: TEST_ROLE_PASSWORD,
    });
  } finally {
    await client.end();
  }

  const migrator = new Migrator({ db: admin(), provider: new StaticMigrationProvider() });
  const { error } = await migrator.migrateToLatest();
  if (error) throw error instanceof Error ? error : new Error(describeUnknown(error));
}

/** Every table hangs off tenants, so one cascading truncate empties the whole schema. */
export async function resetDatabase(): Promise<void> {
  await sql`TRUNCATE TABLE tenants CASCADE`.execute(admin());
}

export async function closeTestDatabase(): Promise<void> {
  await adminDb?.destroy();
  adminDb = undefined;
}
