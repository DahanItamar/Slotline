import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createUserRequestSchema, updateUserRequestSchema } from '@slotline/shared';
import * as userService from '../services/user-service.js';
import { requireAdmin, requireAuth, sessionOf } from './plugins/auth.js';

const idParamsSchema = z.object({ id: z.string().uuid() });

export function registerUserRoutes(app: FastifyInstance): void {
  // Readable by everyone: a booking shows who made it, so the names are already visible.
  app.get('/api/users', { preHandler: requireAuth }, async (request, reply) => {
    const { tenant } = sessionOf(request);
    return reply.send({ users: await userService.listUsers(tenant.id) });
  });

  app.post('/api/users', { preHandler: requireAdmin() }, async (request, reply) => {
    const { tenant, user } = sessionOf(request);
    const body = createUserRequestSchema.parse(request.body);
    const created = await userService.createUser(tenant.id, { id: user.id, role: user.role }, body);
    // 201 carries the temporary password. It is not stored in plaintext and cannot be
    // read again — the admin passes it on however they like (Assumption 3).
    return reply.status(201).send(created);
  });

  app.patch('/api/users/:id', { preHandler: requireAdmin() }, async (request, reply) => {
    const { tenant, user } = sessionOf(request);
    const { id } = idParamsSchema.parse(request.params);
    const body = updateUserRequestSchema.parse(request.body);
    return reply.send(
      await userService.updateUser(tenant.id, { id: user.id, role: user.role }, id, body),
    );
  });
}
