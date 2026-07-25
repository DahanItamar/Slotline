/**
 * The complete set of error codes the API can return. Clients switch on `code`,
 * never on `message` — messages are for humans and may be reworded at any time.
 * SPEC §6.
 */
export const ERROR_CODES = [
  // auth
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'INVALID_CREDENTIALS',
  'WEAK_PASSWORD',
  'SLUG_TAKEN',
  'EMAIL_TAKEN',
  'INVALID_TIMEZONE',
  'RATE_LIMITED',
  'PASSWORD_CHANGE_REQUIRED',

  // resources
  'NAME_TAKEN',
  'RESOURCE_INACTIVE',
  'RESOURCE_HAS_BOOKINGS',

  // availability
  'OVERLAPPING_RULES',
  'EXCEPTION_EXISTS',

  // bookings
  'SLOT_TAKEN',
  'INVALID_RANGE',
  'DURATION_OUT_OF_BOUNDS',
  'IN_THE_PAST',
  'TOO_FAR_AHEAD',
  'SPANS_MIDNIGHT',
  'INVALID_LOCAL_TIME',
  'OUTSIDE_AVAILABILITY',
  'ALREADY_CANCELLED',
  'VERSION_CONFLICT',
  'IDEMPOTENCY_KEY_REUSED',
  'RANGE_TOO_WIDE',

  // users
  'CANNOT_DEMOTE_SELF',
  'LAST_OWNER',

  // generic
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** The single response envelope for every non-2xx response. */
export type ApiErrorBody = {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
};
