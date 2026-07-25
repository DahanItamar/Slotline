import { z } from 'zod';
import { MEMBERSHIP_ROLES, MIN_PASSWORD_LENGTH } from './constants.js';

export const membershipRoleSchema = z.enum(MEMBERSHIP_ROLES);
export type MembershipRole = z.infer<typeof membershipRoleSchema>;

/**
 * Only a length floor. Composition rules ("one uppercase, one symbol") push users
 * toward predictable passwords and are not applied here.
 */
export const passwordSchema = z.string().min(MIN_PASSWORD_LENGTH).max(200);

export const tenantSlugSchema = z
  .string()
  .regex(/^[a-z0-9-]{3,32}$/, 'lowercase letters, digits and hyphens, 3-32 characters');

export const emailSchema = z.string().email().max(254).toLowerCase();

export const signupRequestSchema = z.object({
  tenantName: z.string().min(1).max(120),
  tenantSlug: tenantSlugSchema,
  timezone: z.string().min(1).max(64),
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().min(1).max(120),
});
export type SignupRequest = z.infer<typeof signupRequestSchema>;

export const loginRequestSchema = z.object({
  tenantSlug: tenantSlugSchema,
  email: emailSchema,
  password: z.string().min(1).max(200),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export type UserDto = {
  id: string;
  email: string;
  displayName: string;
  role: MembershipRole;
  isActive: boolean;
  mustChangePassword: boolean;
};

export type TenantDto = {
  id: string;
  slug: string;
  name: string;
  timezone: string;
};

export type SessionDto = {
  user: UserDto;
  tenant: TenantDto;
};

export const createUserRequestSchema = z.object({
  email: emailSchema,
  displayName: z.string().min(1).max(120),
  role: membershipRoleSchema,
});
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;

/**
 * The temporary password is returned exactly once, here, and is never recoverable
 * afterwards — there is no email provider in the stack to send it (Assumption 3). The
 * admin reads it out; the account is forced to change it on first sign-in.
 */
export type CreateUserResponse = {
  user: UserDto;
  temporaryPassword: string;
};

export const updateUserRequestSchema = z
  .object({
    role: membershipRoleSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => value.role !== undefined || value.isActive !== undefined, {
    message: 'at least one field must be present',
  });
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;
