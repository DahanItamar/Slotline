import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createBookingRequestSchema,
  listBookingsQuerySchema,
  listMyBookingsQuerySchema,
  updateBookingRequestSchema,
} from '@slotline/shared';
import { unprocessable } from '../lib/errors.js';
import * as lifecycleService from '../services/booking-lifecycle-service.js';
import * as bookingService from '../services/booking-service.js';
import { requireAuth, sessionOf } from './plugins/auth.js';

const idempotencyKeySchema = z.string().uuid();
const idParamsSchema = z.object({ id: z.string().uuid() });

export function registerBookingRoutes(app: FastifyInstance): void {
  app.get('/api/bookings', { preHandler: requireAuth }, async (request, reply) => {
    const { tenant } = sessionOf(request);
    const query = listBookingsQuerySchema.parse(request.query);
    const bookings = await bookingService.listBookings(tenant.id, query);
    return reply.send({ bookings });
  });

  app.post('/api/bookings', { preHandler: requireAuth }, async (request, reply) => {
    const { tenant, user } = sessionOf(request);

    // Required, not optional: without it a retried request creates a second booking,
    // and a retry is the normal outcome of a timeout. SPEC §8.
    const parsedKey = idempotencyKeySchema.safeParse(request.headers['idempotency-key']);
    if (!parsedKey.success) {
      throw unprocessable(
        'VALIDATION_FAILED',
        'An Idempotency-Key header containing a UUID is required.',
      );
    }

    const body = createBookingRequestSchema.parse(request.body);
    const result = await bookingService.createBooking(
      { tenantId: tenant.id, tenantTimeZone: tenant.timezone, userId: user.id },
      body,
      parsedKey.data,
    );

    // A replay is not a creation: 200, so a client can tell the two apart.
    return reply
      .status(result.replayed ? 200 : 201)
      .header('ETag', `"${result.booking.version}"`)
      .send(result.booking);
  });

  app.get('/api/bookings/mine', { preHandler: requireAuth }, async (request, reply) => {
    const { tenant, user } = sessionOf(request);
    const query = listMyBookingsQuerySchema.parse(request.query);
    const bookings = await bookingService.listMyBookings(tenant.id, user.id, query);
    return reply.send({ bookings });
  });

  app.patch('/api/bookings/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { tenant, user } = sessionOf(request);
    const { id } = idParamsSchema.parse(request.params);

    // Required, not optional. Without it, two people dragging the same booking produce
    // a silent last-write-wins and one of them never learns their change was undone.
    const expectedVersion = parseIfMatch(request.headers['if-match']);
    if (expectedVersion === null) {
      throw unprocessable(
        'VALIDATION_FAILED',
        'An If-Match header carrying the booking version is required.',
      );
    }

    const body = updateBookingRequestSchema.parse(request.body);
    const booking = await lifecycleService.rescheduleBooking(
      { tenantId: tenant.id, tenantTimeZone: tenant.timezone, userId: user.id, role: user.role },
      id,
      body,
      expectedVersion,
    );

    return reply.header('ETag', `"${booking.version}"`).send(booking);
  });

  app.post('/api/bookings/:id/cancel', { preHandler: requireAuth }, async (request, reply) => {
    const { tenant, user } = sessionOf(request);
    const { id } = idParamsSchema.parse(request.params);
    const booking = await lifecycleService.cancelBooking(
      { tenantId: tenant.id, tenantTimeZone: tenant.timezone, userId: user.id, role: user.role },
      id,
    );
    return reply.header('ETag', `"${booking.version}"`).send(booking);
  });
}

/** Accepts both `"3"` and `3`; anything else is a missing precondition, not a version. */
function parseIfMatch(header: string | string[] | undefined): number | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined) return null;
  const match = /^(?:W\/)?"?(\d{1,9})"?$/.exec(raw.trim());
  return match?.[1] === undefined ? null : Number(match[1]);
}
