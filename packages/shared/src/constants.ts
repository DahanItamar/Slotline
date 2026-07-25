/** Bounds shared by client validation (UX) and server validation (the control). SPEC §5, §8. */

/** Hard floor on any resource's `minMinutes`. */
export const MIN_RESOURCE_MINUTES = 5;
/** Hard ceiling on any resource's `maxMinutes`. 720 = 12h, the single-local-day cap (Assumption 4). */
export const MAX_RESOURCE_MINUTES = 720;

/** Widest window `GET /api/bookings` will serve — beyond this, `RANGE_TOO_WIDE`. */
export const MAX_QUERY_RANGE_DAYS = 62;
/** How far ahead a booking may start. */
export const MAX_FUTURE_DAYS = 365;
/** Tolerance for a client clock that is slightly behind, so "book now" is not rejected. */
export const PAST_GRACE_MINUTES = 5;

export const MAX_TITLE_LENGTH = 200;
export const MAX_NOTES_LENGTH = 2000;
export const MAX_RESOURCE_NAME_LENGTH = 120;
export const MIN_PASSWORD_LENGTH = 12;

export const SESSION_COOKIE_NAME = 'slotline_session';
export const SESSION_TTL_DAYS = 30;

export const RESOURCE_KINDS = ['room', 'equipment', 'consultant'] as const;
export const MEMBERSHIP_ROLES = ['owner', 'admin', 'member'] as const;
export const BOOKING_STATUSES = ['confirmed', 'cancelled'] as const;
