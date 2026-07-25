/**
 * Forward-only migrations, run as the schema owner via APP_MIGRATION_DATABASE_URL.
 *
 *   npm run migrate        # apply everything pending
 *   npm run migrate:down   # roll back the most recent migration
 *
 * Migrations are imported explicitly rather than globbed from disk: the same list works
 * from `tsx` in development and from compiled `dist/` in production, with no path
 * resolution differences between the two (or between Windows and Linux).
 */
import { Kysely, type Migration, type MigrationProvider, Migrator, PostgresDialect } from 'kysely';
import pg from 'pg';
import { describeUnknown } from '../lib/errors.js';
import * as initialSchema from './migrations/001-initial-schema.js';
import * as userManagement from './migrations/002-user-management.js';
import type { Database } from './types.js';

const MIGRATIONS: Record<string, Migration> = {
  '001-initial-schema': initialSchema,
  '002-user-management': userManagement,
};

class StaticMigrationProvider implements MigrationProvider {
  getMigrations(): Promise<Record<string, Migration>> {
    return Promise.resolve(MIGRATIONS);
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.APP_MIGRATION_DATABASE_URL;
  if (!connectionString) {
    console.error('migrate: APP_MIGRATION_DATABASE_URL is not set.');
    process.exit(1);
  }

  const direction = process.argv[2] === 'down' ? 'down' : 'up';
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
  });
  const migrator = new Migrator({ db, provider: new StaticMigrationProvider() });

  const { error, results } = await (direction === 'up'
    ? migrator.migrateToLatest()
    : migrator.migrateDown());

  for (const result of results ?? []) {
    const verb = direction === 'up' ? 'applied' : 'reverted';
    console.error(
      result.status === 'Success'
        ? `migrate: ${verb} ${result.migrationName}`
        : `migrate: FAILED ${result.migrationName} (${result.status})`,
    );
  }

  await db.destroy();

  if (error) {
    console.error('migrate: failed —', describeUnknown(error));
    process.exit(1);
  }
  if ((results ?? []).length === 0) console.error('migrate: nothing to do');
}

await main();
