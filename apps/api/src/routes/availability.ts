import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createAvailabilityExceptionSchema,
  listExceptionsQuerySchema,
  replaceAvailabilityRulesSchema,
} from '@slotline/shared';
import * as availabilityService from '../services/availability-service.js';
import { requireAdmin, requireAuth, sessionOf } from './plugins/auth.js';

const idParamsSchema = z.object({ id: z.string().uuid() });

export function registerAvailabilityRoutes(app: FastifyInstance): void {
  // Readable by everyone: the calendar needs it to shade closed hours, and hiding it
  // would only mean members discover a closure by being refused.
  app.get(
    '/api/resources/:id/availability',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { tenant } = sessionOf(request);
      const { id } = idParamsSchema.parse(request.params);
      return reply.send(await availabilityService.getAvailability(tenant.id, tenant.timezone, id));
    },
  );

  app.put(
    '/api/resources/:id/availability-rules',
    { preHandler: requireAdmin() },
    async (request, reply) => {
      const { tenant } = sessionOf(request);
      const { id } = idParamsSchema.parse(request.params);
      const { rules } = replaceAvailabilityRulesSchema.parse(request.body);
      return reply.send(
        await availabilityService.replaceAvailabilityRules(tenant.id, tenant.timezone, id, rules),
      );
    },
  );

  app.get(
    '/api/resources/:id/availability-exceptions',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { tenant } = sessionOf(request);
      const { id } = idParamsSchema.parse(request.params);
      const query = listExceptionsQuerySchema.parse(request.query);
      const exceptions = await availabilityService.listExceptions(tenant.id, id, query);
      return reply.send({ exceptions });
    },
  );

  app.post(
    '/api/resources/:id/availability-exceptions',
    { preHandler: requireAdmin() },
    async (request, reply) => {
      const { tenant } = sessionOf(request);
      const { id } = idParamsSchema.parse(request.params);
      const body = createAvailabilityExceptionSchema.parse(request.body);
      const exception = await availabilityService.createException(
        tenant.id,
        tenant.timezone,
        id,
        body,
      );
      return reply.status(201).send(exception);
    },
  );

  app.delete(
    '/api/availability-exceptions/:id',
    { preHandler: requireAdmin() },
    async (request, reply) => {
      const { tenant } = sessionOf(request);
      const { id } = idParamsSchema.parse(request.params);
      await availabilityService.deleteException(tenant.id, id);
      return reply.status(204).send();
    },
  );
}
