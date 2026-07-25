import type { FastifyInstance } from 'fastify';
import {
  createResourceRequestSchema,
  listResourcesQuerySchema,
  updateResourceRequestSchema,
} from '@slotline/shared';
import { z } from 'zod';
import * as resourceService from '../services/resource-service.js';
import { requireAdmin, requireAuth, sessionOf } from './plugins/auth.js';

const idParamsSchema = z.object({ id: z.string().uuid() });

export function registerResourceRoutes(app: FastifyInstance): void {
  app.get('/api/resources', { preHandler: requireAuth }, async (request, reply) => {
    const { tenant } = sessionOf(request);
    const query = listResourcesQuerySchema.parse(request.query);
    const resources = await resourceService.listResources(tenant.id, tenant.timezone, query);
    return reply.send({ resources });
  });

  app.get('/api/resources/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { tenant } = sessionOf(request);
    const { id } = idParamsSchema.parse(request.params);
    return reply.send(await resourceService.getResource(tenant.id, tenant.timezone, id));
  });

  app.post('/api/resources', { preHandler: requireAdmin() }, async (request, reply) => {
    const { tenant } = sessionOf(request);
    const body = createResourceRequestSchema.parse(request.body);
    const resource = await resourceService.createResource(tenant.id, tenant.timezone, body);
    return reply.status(201).send(resource);
  });

  app.patch('/api/resources/:id', { preHandler: requireAdmin() }, async (request, reply) => {
    const { tenant } = sessionOf(request);
    const { id } = idParamsSchema.parse(request.params);
    const body = updateResourceRequestSchema.parse(request.body);
    return reply.send(await resourceService.updateResource(tenant.id, tenant.timezone, id, body));
  });

  app.delete('/api/resources/:id', { preHandler: requireAdmin() }, async (request, reply) => {
    const { tenant } = sessionOf(request);
    const { id } = idParamsSchema.parse(request.params);
    await resourceService.deleteResource(tenant.id, id);
    return reply.status(204).send();
  });
}
