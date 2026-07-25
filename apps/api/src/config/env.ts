import { z } from 'zod';

/**
 * Parsed once, at boot. A missing or malformed variable throws before the server
 * listens — a misconfigured deploy fails visibly rather than at 03:00. SPEC §9.
 */
const envSchema = z.object({
  APP_DATABASE_URL: z.string().url(),
  APP_AUTH_DATABASE_URL: z.string().url(),
  APP_MIGRATION_DATABASE_URL: z.string().url().optional(),
  APP_ORIGIN: z.string().url(),
  APP_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  APP_LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  APP_NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }
  return parsed.data;
}

export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

export function isProduction(): boolean {
  return env().APP_NODE_ENV === 'production';
}
