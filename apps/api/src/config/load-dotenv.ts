import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Minimal `.env` reader for local development. Production sets real environment
 * variables, so pulling in `dotenv` would buy nothing but a dependency.
 *
 * It **searches upward** for the file rather than taking a relative path from the caller.
 * Two entry points at different depths (`src/index.ts` and `src/jobs/prune.ts`) previously
 * each carried their own `../../..` guess, which is the kind of duplication that fails
 * silently: the wrong one finds nothing, loads no variables, and the process carries on
 * against whatever happened to be in the ambient environment.
 */
const MAX_LEVELS = 6;

export function loadDotEnv(startFrom = import.meta.url): void {
  let directory = dirname(fileURLToPath(startFrom));

  for (let level = 0; level < MAX_LEVELS; level += 1) {
    const candidate = join(directory, '.env');
    if (existsSync(candidate)) {
      applyFile(candidate);
      return;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  // No .env anywhere above: expected in production, where the environment is populated.
}

function applyFile(path: string): void {
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    // A real environment variable always wins over the file.
    if (match?.[1] && !(match[1] in process.env)) process.env[match[1]] = match[2] ?? '';
  }
}
