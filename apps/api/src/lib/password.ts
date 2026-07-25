import { hash, verify } from '@node-rs/argon2';
import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * `Algorithm.Argon2id`. Written as the literal because the package exports `Algorithm`
 * as a `const enum`, which cannot be read under `isolatedModules`.
 */
const ARGON2ID = 2;

/** OWASP's argon2id baseline: 19 MiB, 2 iterations, 1 lane. SPEC §9. */
const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, ARGON2_OPTIONS);
}

export async function verifyPassword(digest: string, plaintext: string): Promise<boolean> {
  try {
    // No options: the cost parameters come from the encoded digest, so a hash written
    // under older settings still verifies after the constants above are raised.
    return await verify(digest, plaintext);
  } catch {
    // A malformed stored digest is a failed login, not a 500. It is also unreachable
    // unless the column was written by something other than hashPassword.
    return false;
  }
}

/**
 * Burned when a login names an address that does not exist, so the response time of a
 * miss matches the response time of a wrong password. Without it, the endpoint tells an
 * attacker which addresses are registered purely by answering faster.
 */
const DUMMY_DIGEST_PLAINTEXT = 'slotline-timing-equaliser';
let dummyDigest: string | undefined;

export async function burnPasswordComparison(): Promise<void> {
  dummyDigest ??= await hashPassword(DUMMY_DIGEST_PLAINTEXT);
  await verifyPassword(dummyDigest, 'not-the-password');
}

/** A temporary password an admin reads out once. Ambiguous characters left out. */
export function generateTemporaryPassword(): string {
  // No l/o/0/1: these get read aloud or copied off a screen.
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const out = Array.from(randomBytes(16), (byte) => alphabet.charAt(byte % alphabet.length)).join(
    '',
  );
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}`;
}

export function constantTimeEquals(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
