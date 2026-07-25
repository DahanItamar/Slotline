import { buildApp } from './app.js';
import { env, loadEnv } from './config/env.js';
import { loadDotEnv } from './config/load-dotenv.js';
import { closeDatabases } from './db/index.js';

loadDotEnv();

// Parsed here, before anything else runs: a missing variable stops the boot rather than
// surfacing as a 500 on the first request that happens to need it. SPEC §9.
loadEnv();

const app = await buildApp();

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await closeDatabases();
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

try {
  await app.listen({ port: env().APP_PORT, host: '0.0.0.0' });
} catch (error) {
  app.log.error({ err: error }, 'failed to start');
  process.exit(1);
}
