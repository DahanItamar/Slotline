import { uuidv7 } from 'uuidv7';

/**
 * UUIDv7 everywhere. Time-ordered, so index locality matches an autoincrement without
 * leaking row counts through a URL — a sequential id tells anyone who sees one how many
 * bookings the tenant has. SPEC §9.
 */
export function newId(): string {
  return uuidv7();
}
