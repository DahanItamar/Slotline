import { z } from 'zod';
import {
  MAX_RESOURCE_MINUTES,
  MAX_RESOURCE_NAME_LENGTH,
  MIN_RESOURCE_MINUTES,
  RESOURCE_KINDS,
} from './constants.js';

export const resourceKindSchema = z.enum(RESOURCE_KINDS);
export type ResourceKind = z.infer<typeof resourceKindSchema>;

export type ResourceDto = {
  id: string;
  kind: ResourceKind;
  name: string;
  description: string;
  /** Resolved: the resource's own zone if set, otherwise the tenant's. Never null to the client. */
  timezone: string;
  /** The consultant's own account. Always null for rooms and equipment. */
  userId: string | null;
  /** Rooms only, informational. Null when the concept does not apply. */
  capacity: number | null;
  minMinutes: number;
  maxMinutes: number;
  isActive: boolean;
};

const minutesBoundsSchema = z.number().int().min(MIN_RESOURCE_MINUTES).max(MAX_RESOURCE_MINUTES);

export const createResourceRequestSchema = z
  .object({
    kind: resourceKindSchema,
    name: z.string().min(1).max(MAX_RESOURCE_NAME_LENGTH),
    description: z.string().max(1000).default(''),
    capacity: z.number().int().min(1).max(10_000).nullable().default(null),
    userId: z.string().uuid().nullable().default(null),
    minMinutes: minutesBoundsSchema.default(15),
    maxMinutes: minutesBoundsSchema.default(480),
  })
  .refine((value) => value.minMinutes <= value.maxMinutes, {
    message: 'minMinutes must not exceed maxMinutes',
    path: ['minMinutes'],
  })
  .refine((value) => value.userId === null || value.kind === 'consultant', {
    message: 'only a consultant resource may be linked to a user account',
    path: ['userId'],
  });
export type CreateResourceRequest = z.infer<typeof createResourceRequestSchema>;

export const updateResourceRequestSchema = z
  .object({
    name: z.string().min(1).max(MAX_RESOURCE_NAME_LENGTH).optional(),
    description: z.string().max(1000).optional(),
    capacity: z.number().int().min(1).max(10_000).nullable().optional(),
    userId: z.string().uuid().nullable().optional(),
    minMinutes: minutesBoundsSchema.optional(),
    maxMinutes: minutesBoundsSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'no fields to update' })
  .refine(
    (value) =>
      value.minMinutes === undefined ||
      value.maxMinutes === undefined ||
      value.minMinutes <= value.maxMinutes,
    { message: 'minMinutes must not exceed maxMinutes', path: ['minMinutes'] },
  );
export type UpdateResourceRequest = z.infer<typeof updateResourceRequestSchema>;

export const listResourcesQuerySchema = z.object({
  kind: resourceKindSchema.optional(),
  includeInactive: z.coerce.boolean().default(false),
});
export type ListResourcesQuery = z.infer<typeof listResourcesQuerySchema>;
