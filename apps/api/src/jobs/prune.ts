/**
 * The retention pass as a one-shot command, for a platform cron or an operator:
 *
 *   npm run prune
 *
 * The running server already does this daily. This exists so the schedule can be moved
 * out of the process the moment there is more than one of them, without new code.
 */
import { loadEnv } from '../config/env.js';
import { loadDotEnv } from '../config/load-dotenv.js';
import { closeDatabases } from '../db/index.js';
import { describeUnknown } from '../lib/errors.js';
import { runRetention } from './retention.js';

loadDotEnv();
loadEnv();

try {
  const result = await runRetention();
  console.error(
    `prune: removed ${result.eventsDeleted} event(s) across ${result.tenantsVisited} tenant(s) ` +
      `and ${result.sessionsDeleted} expired session(s)`,
  );
} catch (error) {
  console.error(`prune: failed — ${describeUnknown(error)}`);
  await closeDatabases();
  process.exit(1);
}

await closeDatabases();
