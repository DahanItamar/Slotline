import { z } from 'zod';
import { BOOKING_STATUSES, MAX_NOTES_LENGTH, MAX_TITLE_LENGTH } from './constants.js';

export const bookingStatusSchema = z.enum(BOOKING_STATUSES);
export type BookingStatus = z.infer<typeof bookingStatusSchema>;

export type BookingDto = {
  id: string;
  resourceId: string;
  createdByUserId: string;
  createdByDisplayName: string;
  title: string;
  notes: string;
  /** ISO 8601, always normalised to UTC by the server: "2026-08-03T09:00:00.000Z". */
  startsAt: string;
  endsAt: string;
  status: BookingStatus;
  /** Optimistic-concurrency token, surfaced as the ETag. SPEC §7 Flow C. */
  version: number;
};

/** Offsets are accepted on the wire; the server normalises to UTC before storing. */
const instantSchema = z.string().datetime({ offset: true });

export const createBookingRequestSchema = z.object({
  resourceId: z.string().uuid(),
  startsAt: instantSchema,
  endsAt: instantSchema,
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
  notes: z.string().max(MAX_NOTES_LENGTH).default(''),
});
export type CreateBookingRequest = z.infer<typeof createBookingRequestSchema>;

export const updateBookingRequestSchema = z
  .object({
    startsAt: instantSchema.optional(),
    endsAt: instantSchema.optional(),
    title: z.string().min(1).max(MAX_TITLE_LENGTH).optional(),
    notes: z.string().max(MAX_NOTES_LENGTH).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'no fields to update' })
  .refine((value) => (value.startsAt === undefined) === (value.endsAt === undefined), {
    message: 'startsAt and endsAt must be supplied together',
    path: ['startsAt'],
  });
export type UpdateBookingRequest = z.infer<typeof updateBookingRequestSchema>;

/** `resourceId` may repeat in the query string; Fastify hands us a string or an array. */
const repeatableUuid = z
  .union([z.string().uuid(), z.array(z.string().uuid())])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    return Array.isArray(value) ? value : [value];
  });

export const listBookingsQuerySchema = z.object({
  from: instantSchema,
  to: instantSchema,
  resourceId: repeatableUuid,
});
export type ListBookingsQuery = z.infer<typeof listBookingsQuerySchema>;

export const listMyBookingsQuerySchema = z.object({
  from: instantSchema,
  to: instantSchema,
});
export type ListMyBookingsQuery = z.infer<typeof listMyBookingsQuerySchema>;

/**
 * Payload attached to a 409 SLOT_TAKEN. Carries the window only — never the other
 * booking's title, which is governed by Open Question 1 in the spec.
 */
export type SlotTakenDetails = {
  conflictingStartsAt: string;
  conflictingEndsAt: string;
};
