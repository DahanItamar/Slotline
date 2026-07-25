import type { FastifyBaseLogger } from 'fastify';
import { describeUnknown } from '../lib/errors.js';
import { runRetention } from './retention.js';

/**
 * A daily timer, not a cron service. SPEC §3's rule about earning every moving part
 * applies: one process with one interval is enough for one delete pass a day, and a
 * scheduler would be infrastructure to install, monitor and page on.
 *
 * The trade-off, stated plainly: with more than one instance this runs on each of them.
 * The work is idempotent — deleting rows already deleted removes nothing — so the cost is
 * duplicated effort, not incorrect data. Past one instance, move it to a platform cron
 * calling `npm run prune` instead.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
/** A short delay after boot, so a crash loop cannot turn into a delete loop. */
const FIRST_RUN_DELAY_MS = 60_000;

let timer: NodeJS.Timeout | null = null;
let firstRun: NodeJS.Timeout | null = null;

async function runOnce(log: FastifyBaseLogger): Promise<void> {
  try {
    const result = await runRetention();
    log.info(result, 'retention pass complete');
  } catch (error) {
    // Retention failing is not a reason to take the process down; the next pass retries.
    log.error({ err: describeUnknown(error) }, 'retention pass failed');
  }
}

export function startRetentionSchedule(log: FastifyBaseLogger): void {
  firstRun = setTimeout(() => {
    void runOnce(log);
  }, FIRST_RUN_DELAY_MS);
  timer = setInterval(() => {
    void runOnce(log);
  }, DAY_MS);

  // Neither timer should hold the process open at shutdown.
  firstRun.unref();
  timer.unref();
}

export function stopRetentionSchedule(): void {
  if (firstRun) clearTimeout(firstRun);
  if (timer) clearInterval(timer);
  firstRun = null;
  timer = null;
}
