import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BookingDto, CreateUserResponse, ResourceDto, UserDto } from '@slotline/shared';
import { closeDatabases } from '../src/db/index.js';
import {
  bookRequest,
  createRoom,
  createTestApp,
  futureWindow,
  signUpWorkspace,
  type Workspace,
} from './helpers/app.js';
import {
  closeTestDatabase,
  hasDatabase,
  resetDatabase,
  setupDatabase,
} from './helpers/database.js';

/**
 * Booking lifecycle and team management. SPEC §10 M4.
 *
 * These also close the coverage gap the earlier milestones left behind: until a member
 * could exist, the `requireRole` admin guard was enforced but never exercised by a test.
 */
describe.skipIf(!hasDatabase)('lifecycle and team (integration)', () => {
  let app: FastifyInstance;
  let owner: Workspace;
  let room: ResourceDto;

  const errorCode = (body: string): string =>
    (JSON.parse(body) as { error: { code: string } }).error.code;

  /** Creates a member and signs in as them, clearing the forced password change. */
  async function addMember(role: 'member' | 'admin' = 'member'): Promise<Workspace> {
    const slug = owner.session.tenant.slug;
    const email = `${role}-${randomUUID().slice(0, 6)}@${slug}.test`;

    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: owner.cookie },
      payload: { email, displayName: `A ${role}`, role },
    });
    if (created.statusCode !== 201) {
      throw new Error(`create user -> ${created.statusCode} ${created.body}`);
    }
    const { temporaryPassword } = created.json<CreateUserResponse>();

    const signedIn = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { tenantSlug: slug, email, password: temporaryPassword },
    });
    let cookie = (signedIn.headers['set-cookie'] as string).split(';')[0] ?? '';

    // Clear the forced change, then sign in again with the chosen password.
    await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { cookie },
      payload: { currentPassword: temporaryPassword, newPassword: 'a-real-password-now' },
    });
    const finalSignIn = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { tenantSlug: slug, email, password: 'a-real-password-now' },
    });
    cookie = (finalSignIn.headers['set-cookie'] as string).split(';')[0] ?? '';

    return { cookie, session: finalSignIn.json() };
  }

  const book = (workspace: Workspace, offsetHours = 0) =>
    app.inject(
      bookRequest(workspace, {
        resourceId: room.id,
        ...(({ start, end }) => ({ startsAt: start, endsAt: end }))(futureWindow(offsetHours)),
        idempotencyKey: randomUUID(),
      }),
    );

  beforeAll(async () => {
    await setupDatabase();
    app = await createTestApp();
  });

  beforeEach(async () => {
    await resetDatabase();
    owner = await signUpWorkspace(app, { timezone: 'UTC' });
    room = await createRoom(app, owner);
  });

  afterAll(async () => {
    await app.close();
    await closeDatabases();
    await closeTestDatabase();
  });

  describe('cancelling', () => {
    it('frees the slot for someone else immediately', async () => {
      const first = await book(owner);
      expect(first.statusCode).toBe(201);

      const cancelled = await app.inject({
        method: 'POST',
        url: `/api/bookings/${first.json<BookingDto>().id}/cancel`,
        headers: { cookie: owner.cookie },
      });
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json<BookingDto>().status).toBe('cancelled');

      // The exclusion constraint is partial on status='confirmed', so the window reopens.
      const rebooked = await book(owner);
      expect(rebooked.statusCode).toBe(201);
    });

    it('drops a cancelled booking out of the calendar', async () => {
      const created = (await book(owner)).json<BookingDto>();
      await app.inject({
        method: 'POST',
        url: `/api/bookings/${created.id}/cancel`,
        headers: { cookie: owner.cookie },
      });

      const { start, end } = futureWindow();
      const listed = await app.inject({
        method: 'GET',
        url: `/api/bookings?from=${start}&to=${end}`,
        headers: { cookie: owner.cookie },
      });
      expect(listed.json<{ bookings: BookingDto[] }>().bookings).toEqual([]);
    });

    it('refuses to cancel twice', async () => {
      const created = (await book(owner)).json<BookingDto>();
      const url = `/api/bookings/${created.id}/cancel`;
      await app.inject({ method: 'POST', url, headers: { cookie: owner.cookie } });
      const second = await app.inject({ method: 'POST', url, headers: { cookie: owner.cookie } });

      expect(second.statusCode).toBe(409);
      expect(errorCode(second.body)).toBe('ALREADY_CANCELLED');
    });
  });

  describe('rescheduling', () => {
    it('moves a booking when the version matches', async () => {
      const created = (await book(owner)).json<BookingDto>();
      const moved = futureWindow(5);

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/bookings/${created.id}`,
        headers: { cookie: owner.cookie, 'if-match': `"${created.version}"` },
        payload: { startsAt: moved.start, endsAt: moved.end },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<BookingDto>();
      expect(body.startsAt).toBe(moved.start);
      expect(body.version).toBe(created.version + 1);
      expect(response.headers.etag).toBe(`"${created.version + 1}"`);
    });

    it('refuses a stale version rather than overwriting silently', async () => {
      const created = (await book(owner)).json<BookingDto>();
      const staleVersion = created.version;

      // Someone else edits first.
      await app.inject({
        method: 'PATCH',
        url: `/api/bookings/${created.id}`,
        headers: { cookie: owner.cookie, 'if-match': `"${created.version}"` },
        payload: { title: 'Renamed by someone else' },
      });

      const late = await app.inject({
        method: 'PATCH',
        url: `/api/bookings/${created.id}`,
        headers: { cookie: owner.cookie, 'if-match': `"${staleVersion}"` },
        payload: { title: 'My change' },
      });

      expect(late.statusCode).toBe(412);
      expect(errorCode(late.body)).toBe('VERSION_CONFLICT');

      const listed = await app.inject({
        method: 'GET',
        url: `/api/bookings?from=${futureWindow().start}&to=${futureWindow().end}`,
        headers: { cookie: owner.cookie },
      });
      expect(listed.json<{ bookings: BookingDto[] }>().bookings[0]?.title).toBe(
        'Renamed by someone else',
      );
    });

    it('requires an If-Match header at all', async () => {
      const created = (await book(owner)).json<BookingDto>();
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/bookings/${created.id}`,
        headers: { cookie: owner.cookie },
        payload: { title: 'No precondition' },
      });
      expect(response.statusCode).toBe(422);
    });

    it('refuses a move onto an occupied slot, leaving the booking where it was', async () => {
      const first = (await book(owner, 0)).json<BookingDto>();
      const second = (await book(owner, 3)).json<BookingDto>();
      const occupied = futureWindow(3);

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/bookings/${first.id}`,
        headers: { cookie: owner.cookie, 'if-match': `"${first.version}"` },
        payload: { startsAt: occupied.start, endsAt: occupied.end },
      });

      expect(response.statusCode).toBe(409);
      expect(errorCode(response.body)).toBe('SLOT_TAKEN');

      // Unchanged, and the other booking untouched.
      const stillThere = await app.inject({
        method: 'GET',
        url: `/api/bookings?from=${futureWindow(0).start}&to=${futureWindow(4).end}`,
        headers: { cookie: owner.cookie },
      });
      const ids = stillThere.json<{ bookings: BookingDto[] }>().bookings.map((b) => b.startsAt);
      expect(ids).toEqual([futureWindow(0).start, futureWindow(3).start]);
      expect(second.id).toBeDefined();
    });

    it('refuses to reschedule a cancelled booking', async () => {
      const created = (await book(owner)).json<BookingDto>();
      await app.inject({
        method: 'POST',
        url: `/api/bookings/${created.id}/cancel`,
        headers: { cookie: owner.cookie },
      });

      const moved = futureWindow(5);
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/bookings/${created.id}`,
        headers: { cookie: owner.cookie, 'if-match': `"${created.version + 1}"` },
        payload: { startsAt: moved.start, endsAt: moved.end },
      });

      expect(response.statusCode).toBe(409);
      expect(errorCode(response.body)).toBe('ALREADY_CANCELLED');
    });
  });

  describe('member permissions', () => {
    it('refuses to let a member create a resource', async () => {
      const member = await addMember();
      const response = await app.inject({
        method: 'POST',
        url: '/api/resources',
        headers: { cookie: member.cookie },
        payload: { kind: 'room', name: 'Sneaky Room' },
      });
      expect(response.statusCode).toBe(403);
      expect(errorCode(response.body)).toBe('FORBIDDEN');
    });

    it('refuses to let a member set opening hours', async () => {
      const member = await addMember();
      const response = await app.inject({
        method: 'PUT',
        url: `/api/resources/${room.id}/availability-rules`,
        headers: { cookie: member.cookie },
        payload: { rules: [{ weekday: 1, startMinute: 540, endMinute: 1020 }] },
      });
      expect(response.statusCode).toBe(403);
    });

    it('lets a member book, and cancel what they booked', async () => {
      const member = await addMember();
      const created = await book(member);
      expect(created.statusCode).toBe(201);

      const cancelled = await app.inject({
        method: 'POST',
        url: `/api/bookings/${created.json<BookingDto>().id}/cancel`,
        headers: { cookie: member.cookie },
      });
      expect(cancelled.statusCode).toBe(200);
    });

    it('refuses to let a member cancel someone else’s booking', async () => {
      const member = await addMember();
      const ownersBooking = (await book(owner)).json<BookingDto>();

      const response = await app.inject({
        method: 'POST',
        url: `/api/bookings/${ownersBooking.id}/cancel`,
        headers: { cookie: member.cookie },
      });
      expect(response.statusCode).toBe(403);
    });

    it('lets an admin cancel anyone’s booking', async () => {
      const admin = await addMember('admin');
      const ownersBooking = (await book(owner)).json<BookingDto>();

      const response = await app.inject({
        method: 'POST',
        url: `/api/bookings/${ownersBooking.id}/cancel`,
        headers: { cookie: admin.cookie },
      });
      expect(response.statusCode).toBe(200);
    });

    it('returns only the caller’s own bookings from /mine', async () => {
      const member = await addMember();
      await book(owner, 0);
      const theirs = (await book(member, 3)).json<BookingDto>();

      const response = await app.inject({
        method: 'GET',
        url: `/api/bookings/mine?from=${futureWindow(0).start}&to=${futureWindow(6).end}`,
        headers: { cookie: member.cookie },
      });

      const bookings = response.json<{ bookings: BookingDto[] }>().bookings;
      expect(bookings).toHaveLength(1);
      expect(bookings[0]?.id).toBe(theirs.id);
    });
  });

  describe('user management', () => {
    it('returns a temporary password exactly once, and forces a change', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { cookie: owner.cookie },
        payload: { email: 'new@acme.test', displayName: 'New Person', role: 'member' },
      });

      expect(created.statusCode).toBe(201);
      const body = created.json<CreateUserResponse>();
      expect(body.temporaryPassword).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
      expect(body.user.mustChangePassword).toBe(true);

      // That account can sign in, and then do nothing else until it sets a password.
      const signedIn = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          tenantSlug: owner.session.tenant.slug,
          email: 'new@acme.test',
          password: body.temporaryPassword,
        },
      });
      const cookie = (signedIn.headers['set-cookie'] as string).split(';')[0] ?? '';

      const blocked = await app.inject({
        method: 'GET',
        url: '/api/resources',
        headers: { cookie },
      });
      expect(blocked.statusCode).toBe(403);
      expect(errorCode(blocked.body)).toBe('PASSWORD_CHANGE_REQUIRED');
    });

    it('refuses a duplicate address inside the workspace', async () => {
      const payload = { email: 'dup@acme.test', displayName: 'Dup', role: 'member' };
      await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { cookie: owner.cookie },
        payload,
      });
      const second = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { cookie: owner.cookie },
        payload,
      });

      expect(second.statusCode).toBe(409);
      expect(errorCode(second.body)).toBe('EMAIL_TAKEN');
    });

    it('refuses to let an admin mint another admin', async () => {
      const admin = await addMember('admin');
      const response = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { cookie: admin.cookie },
        payload: { email: 'escalate@acme.test', displayName: 'Escalation', role: 'admin' },
      });
      expect(response.statusCode).toBe(403);
    });

    it('refuses to let anyone change their own role', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/users/${owner.session.user.id}`,
        headers: { cookie: owner.cookie },
        payload: { role: 'member' },
      });
      expect(response.statusCode).toBe(409);
      expect(errorCode(response.body)).toBe('CANNOT_DEMOTE_SELF');
    });

    it('refuses to demote the last owner', async () => {
      // A second owner, so the demotion below is about the *last* one, not about self.
      const created = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { cookie: owner.cookie },
        payload: { email: 'owner2@acme.test', displayName: 'Second Owner', role: 'owner' },
      });
      const second = created.json<CreateUserResponse>().user;

      // Demoting the second owner is fine — the first is still standing.
      const allowed = await app.inject({
        method: 'PATCH',
        url: `/api/users/${second.id}`,
        headers: { cookie: owner.cookie },
        payload: { role: 'member' },
      });
      expect(allowed.statusCode).toBe(200);

      // Now the first owner is the only one, and cannot be deactivated by an admin.
      const admin = await addMember('admin');
      const refused = await app.inject({
        method: 'PATCH',
        url: `/api/users/${owner.session.user.id}`,
        headers: { cookie: admin.cookie },
        payload: { isActive: false },
      });
      expect(refused.statusCode).toBe(409);
      expect(errorCode(refused.body)).toBe('LAST_OWNER');
    });

    it('signs a deactivated user out immediately', async () => {
      const member = await addMember();
      const stillValid = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { cookie: member.cookie },
      });
      expect(stillValid.statusCode).toBe(200);

      await app.inject({
        method: 'PATCH',
        url: `/api/users/${member.session.user.id}`,
        headers: { cookie: owner.cookie },
        payload: { isActive: false },
      });

      const revoked = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { cookie: member.cookie },
      });
      expect(revoked.statusCode).toBe(401);
    });

    it('never lists another tenant’s people', async () => {
      const other = await signUpWorkspace(app);
      await addMember();

      const response = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { cookie: other.cookie },
      });
      const users = response.json<{ users: UserDto[] }>().users;
      expect(users).toHaveLength(1);
      expect(users[0]?.id).toBe(other.session.user.id);
    });
  });
});
