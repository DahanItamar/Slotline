import { DateTime } from 'luxon';
import type { SlotTakenDetails } from '@slotline/shared';
import { ApiError } from './api-client';

/**
 * The one place an API failure becomes a sentence a person can act on.
 *
 * Every caller that renders an error uses this. Two copies of the mapping drift — one
 * gets a new code and the other keeps saying something vaguer for the same failure — and
 * the user meets the difference as the app being inconsistent about the same event.
 */
export function describeApiError(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return error instanceof Error ? error.message : 'That did not work.';
  }

  switch (error.code) {
    case 'SLOT_TAKEN': {
      const details = error.details as SlotTakenDetails | undefined;
      if (!details) return error.message;
      const from = DateTime.fromISO(details.conflictingStartsAt).toFormat('HH:mm');
      const to = DateTime.fromISO(details.conflictingEndsAt).toFormat('HH:mm');
      return `Someone booked ${from}–${to} first. Pick another time.`;
    }
    case 'VERSION_CONFLICT':
      return 'Someone else changed that booking while you had it open. It has been reloaded.';
    case 'OUTSIDE_AVAILABILITY':
      return 'That falls outside this resource’s opening hours.';
    case 'DURATION_OUT_OF_BOUNDS':
      return 'That length is not allowed for this resource.';
    case 'IN_THE_PAST':
      return 'That time has already passed.';
    case 'SPANS_MIDNIGHT':
      return 'A booking has to start and end on the same day.';
    case 'RESOURCE_INACTIVE':
      return 'This resource is not taking bookings.';
    case 'PASSWORD_CHANGE_REQUIRED':
      return 'Set a password of your own before using the workspace.';
    case 'RATE_LIMITED':
      return error.message;
    default:
      // Server messages are already written for people; the codes above exist only
      // where the client can say something more useful than the server could.
      return error.message;
  }
}
