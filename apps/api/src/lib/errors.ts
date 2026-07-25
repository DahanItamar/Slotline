import type { ApiErrorBody, ErrorCode } from '@slotline/shared';

/**
 * One error type crossing the service→route boundary, carrying a typed code.
 * Routes map `status`; nothing anywhere matches on a message string. SPEC §4.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, status: number, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  toBody(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export const unauthenticated = (): AppError =>
  new AppError('UNAUTHENTICATED', 401, 'Sign in to continue.');

export const forbidden = (message = 'You do not have access to this.'): AppError =>
  new AppError('FORBIDDEN', 403, message);

export const notFound = (what: string): AppError =>
  new AppError('NOT_FOUND', 404, `${what} not found.`);

export const conflict = (
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): AppError => new AppError(code, 409, message, details);

export const unprocessable = (
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): AppError => new AppError(code, 422, message, details);

/** Postgres SQLSTATE codes this codebase reacts to by name rather than by number. */
export const PG_ERROR = {
  /** exclusion_violation — raised by `bookings_no_overlap`. The whole product. SPEC §3. */
  EXCLUSION_VIOLATION: '23P01',
  /** unique_violation — idempotency key replay, duplicate email, duplicate slug. */
  UNIQUE_VIOLATION: '23505',
  /** foreign_key_violation — e.g. deleting a resource that still has bookings. */
  FOREIGN_KEY_VIOLATION: '23503',
  /** check_violation */
  CHECK_VIOLATION: '23514',
} as const;

type PostgresError = { code: string; constraint?: string };

export function isPostgresError(error: unknown, sqlState: string): error is PostgresError {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === sqlState;
}

export function constraintName(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'constraint' in error) {
    return typeof error.constraint === 'string' ? error.constraint : undefined;
  }
  return undefined;
}

/** Turns anything thrown into something safe to put in a log line. */
export function describeUnknown(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  // JSON.stringify returns undefined for these, despite what its signature says.
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return 'unknown error';
  }
  return JSON.stringify(value);
}
