import { type Kysely, sql } from 'kysely';

/**
 * The whole v1 schema. Two statements in here carry the product:
 *
 *   1. `bookings_no_overlap` — the GiST exclusion constraint. It is the double-booking
 *      guarantee, and it is enforced by Postgres at commit rather than by application
 *      code that has to remember to check. SPEC §3.
 *   2. The `ENABLE ROW LEVEL SECURITY` block — the tenant boundary. A forgotten
 *      `WHERE tenant_id = …` returns zero rows instead of another tenant's rows.
 *
 * Requires the `app_tenant` and `app_auth` roles to exist: run `npm run provision` first.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- Kysely migrations are schema-generic by design */
export async function up(db: Kysely<any>): Promise<void> {
  await assertRolesExist(db);

  await sql`CREATE EXTENSION IF NOT EXISTS btree_gist`.execute(db);
  await sql`CREATE EXTENSION IF NOT EXISTS citext`.execute(db);

  await sql`CREATE TYPE resource_kind      AS ENUM ('room', 'equipment', 'consultant')`.execute(db);
  await sql`CREATE TYPE membership_role    AS ENUM ('owner', 'admin', 'member')`.execute(db);
  await sql`CREATE TYPE booking_status     AS ENUM ('confirmed', 'cancelled')`.execute(db);
  await sql`CREATE TYPE booking_event_type AS ENUM ('booking.created', 'booking.rescheduled', 'booking.cancelled')`.execute(
    db,
  );

  await sql`
    CREATE TABLE tenants (
      id         uuid PRIMARY KEY,
      slug       citext NOT NULL UNIQUE,
      name       text   NOT NULL,
      timezone   text   NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT tenants_slug_shape CHECK (slug ~ '^[a-z0-9-]{3,32}$')
    )
  `.execute(db);

  await sql`
    CREATE TABLE users (
      id                   uuid PRIMARY KEY,
      tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      email                citext NOT NULL,
      password_hash        text   NOT NULL,
      display_name         text   NOT NULL,
      role                 membership_role NOT NULL DEFAULT 'member',
      is_active            boolean NOT NULL DEFAULT true,
      must_change_password boolean NOT NULL DEFAULT false,
      created_at           timestamptz NOT NULL DEFAULT now(),
      updated_at           timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT users_email_length CHECK (char_length(email) BETWEEN 3 AND 254),
      UNIQUE (tenant_id, email)
    )
  `.execute(db);

  await sql`
    CREATE TABLE sessions (
      token_hash bytea PRIMARY KEY,
      tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`CREATE INDEX sessions_user_idx    ON sessions (user_id)`.execute(db);
  await sql`CREATE INDEX sessions_expires_idx ON sessions (expires_at)`.execute(db);

  await sql`
    CREATE TABLE resources (
      id          uuid PRIMARY KEY,
      tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      kind        resource_kind NOT NULL,
      name        text NOT NULL,
      description text NOT NULL DEFAULT '',
      timezone    text,
      user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
      capacity    integer,
      min_minutes integer NOT NULL DEFAULT 15,
      max_minutes integer NOT NULL DEFAULT 480,
      is_active   boolean NOT NULL DEFAULT true,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT resources_minutes_ok      CHECK (min_minutes >= 5 AND max_minutes <= 720 AND min_minutes <= max_minutes),
      CONSTRAINT resources_user_consultant CHECK (user_id IS NULL OR kind = 'consultant'),
      CONSTRAINT resources_name_length     CHECK (char_length(name) BETWEEN 1 AND 120),
      CONSTRAINT resources_capacity_ok     CHECK (capacity IS NULL OR capacity > 0),
      UNIQUE (tenant_id, kind, name)
    )
  `.execute(db);

  await sql`
    CREATE TABLE availability_rules (
      id           uuid PRIMARY KEY,
      tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      resource_id  uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
      weekday      smallint NOT NULL,
      start_minute integer  NOT NULL,
      end_minute   integer  NOT NULL,
      CONSTRAINT availability_rules_ok CHECK (
        weekday BETWEEN 1 AND 7 AND start_minute >= 0 AND end_minute <= 1440 AND start_minute < end_minute)
    )
  `.execute(db);
  await sql`CREATE INDEX availability_rules_resource_idx ON availability_rules (resource_id, weekday)`.execute(
    db,
  );

  await sql`
    CREATE TABLE availability_exceptions (
      id           uuid PRIMARY KEY,
      tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      resource_id  uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
      local_date   date NOT NULL,
      is_available boolean NOT NULL,
      start_minute integer,
      end_minute   integer,
      reason       text NOT NULL DEFAULT '',
      created_at   timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT availability_exceptions_ok CHECK (
        (is_available = false AND start_minute IS NULL AND end_minute IS NULL) OR
        (is_available = true  AND start_minute IS NOT NULL AND end_minute IS NOT NULL
          AND start_minute >= 0 AND end_minute <= 1440 AND start_minute < end_minute)),
      UNIQUE (resource_id, local_date)
    )
  `.execute(db);

  await sql`
    CREATE TABLE bookings (
      id                   uuid PRIMARY KEY,
      tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      resource_id          uuid NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
      created_by_user_id   uuid NOT NULL REFERENCES users(id)     ON DELETE RESTRICT,
      title                text NOT NULL,
      notes                text NOT NULL DEFAULT '',
      starts_at            timestamptz NOT NULL,
      ends_at              timestamptz NOT NULL,
      period               tstzrange GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)')) STORED,
      status               booking_status NOT NULL DEFAULT 'confirmed',
      version              integer NOT NULL DEFAULT 1,
      idempotency_key      text,
      cancelled_at         timestamptz,
      cancelled_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at           timestamptz NOT NULL DEFAULT now(),
      updated_at           timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT bookings_range_ok        CHECK (ends_at > starts_at),
      CONSTRAINT bookings_title_length    CHECK (char_length(title) BETWEEN 1 AND 200),
      CONSTRAINT bookings_notes_length    CHECK (char_length(notes) <= 2000),
      CONSTRAINT bookings_cancel_coherent CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
    )
  `.execute(db);

  // The product, in four lines.
  //   `[)` bounds: a 10:00-11:00 booking and an 11:00-12:00 booking do not overlap.
  //   The WHERE clause is what makes cancellation free the slot — a cancelled row
  //   leaves the index, so the same window can be booked again immediately.
  await sql`
    ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap
      EXCLUDE USING gist (resource_id WITH =, period WITH &&)
      WHERE (status = 'confirmed')
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX bookings_idempotency_idx ON bookings (tenant_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL
  `.execute(db);
  await sql`CREATE INDEX bookings_calendar_idx ON bookings (tenant_id, starts_at) WHERE status = 'confirmed'`.execute(
    db,
  );
  await sql`CREATE INDEX bookings_creator_idx ON bookings (created_by_user_id, starts_at DESC)`.execute(
    db,
  );

  // Append-only. Three jobs: SSE replay (M3), the audit trail, and the NOTIFY source.
  // `booking_id` is deliberately not a foreign key — the log must outlive a hard delete.
  await sql`
    CREATE TABLE booking_events (
      id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      booking_id    uuid NOT NULL,
      resource_id   uuid NOT NULL,
      type          booking_event_type NOT NULL,
      actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      payload       jsonb NOT NULL,
      created_at    timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`CREATE INDEX booking_events_replay_idx ON booking_events (tenant_id, id)`.execute(db);

  await applyRowLevelSecurity(db);
  await applyGrants(db);
}

/**
 * RLS on every tenant-owned table. `current_setting('app.tenant_id', true)` returns
 * NULL when unset, so an unscoped connection matches no rows: failure is closed.
 *
 * `tenants`, `users` and `sessions` get the same policy but are OWNED BY app_auth and
 * are not FORCEd — a table owner bypasses its own non-forced policies, which is how the
 * pre-authentication lookups work without granting BYPASSRLS (that needs superuser, and
 * managed Postgres does not hand it out). `app_tenant` is a non-owner there, so it is
 * still fully constrained by the policy.
 */
async function applyRowLevelSecurity(db: Kysely<any>): Promise<void> {
  const tenantScoped = [
    'users',
    'sessions',
    'resources',
    'availability_rules',
    'availability_exceptions',
    'bookings',
    'booking_events',
  ] as const;

  for (const table of tenantScoped) {
    await sql`ALTER TABLE ${sql.table(table)} ENABLE ROW LEVEL SECURITY`.execute(db);
    await sql`
      CREATE POLICY ${sql.id(`${table}_tenant_isolation`)} ON ${sql.table(table)}
        USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid)
    `.execute(db);
  }

  await sql`ALTER TABLE tenants ENABLE ROW LEVEL SECURITY`.execute(db);
  await sql`
    CREATE POLICY tenants_self ON tenants
      USING      (id = current_setting('app.tenant_id', true)::uuid)
      WITH CHECK (id = current_setting('app.tenant_id', true)::uuid)
  `.execute(db);

  // Data tables are FORCEd, so even their owner cannot read across tenants.
  for (const table of [
    'resources',
    'availability_rules',
    'availability_exceptions',
    'bookings',
    'booking_events',
  ] as const) {
    await sql`ALTER TABLE ${sql.table(table)} FORCE ROW LEVEL SECURITY`.execute(db);
  }
}

/**
 * The `app_auth` boundary is enforced by GRANTs, not by convention: if a future service
 * reaches for the auth pool to read bookings, the query fails with a permission error
 * instead of quietly bypassing tenant isolation. SPEC §9.
 */
async function applyGrants(db: Kysely<any>): Promise<void> {
  await sql`GRANT USAGE ON SCHEMA public TO app_tenant, app_auth`.execute(db);

  // Owned by app_auth so the pre-auth lookups bypass RLS by ownership, not by BYPASSRLS.
  for (const table of ['tenants', 'users', 'sessions'] as const) {
    await sql`ALTER TABLE ${sql.table(table)} OWNER TO app_auth`.execute(db);
  }

  // app_tenant may read tenants (timezone) and users (display names) — RLS applies to it,
  // since it is not the owner. It gets no privilege at all on sessions: session handling
  // belongs entirely to the auth path.
  await sql`GRANT SELECT ON tenants TO app_tenant`.execute(db);
  await sql`GRANT SELECT, UPDATE ON users TO app_tenant`.execute(db);

  for (const table of [
    'resources',
    'availability_rules',
    'availability_exceptions',
    'bookings',
    'booking_events',
  ] as const) {
    await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON ${sql.table(table)} TO app_tenant`.execute(
      db,
    );
    // Deliberately no grant to app_auth: it cannot read a booking even if a future bug asks.
  }

  await sql`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_tenant`.execute(db);
}

async function assertRolesExist(db: Kysely<any>): Promise<void> {
  const { rows } = await sql<{ rolname: string }>`
    SELECT rolname FROM pg_roles WHERE rolname IN ('app_tenant', 'app_auth')
  `.execute(db);
  const found = new Set(rows.map((row) => row.rolname));
  const missing = ['app_tenant', 'app_auth'].filter((role) => !found.has(role));
  if (missing.length > 0) {
    throw new Error(
      `Missing database role(s): ${missing.join(', ')}. Run \`npm run provision\` first ` +
        `(see README) — the schema grants privileges to these roles and cannot be applied without them.`,
    );
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const table of [
    'booking_events',
    'bookings',
    'availability_exceptions',
    'availability_rules',
    'resources',
    'sessions',
    'users',
    'tenants',
  ] as const) {
    await sql`DROP TABLE IF EXISTS ${sql.table(table)} CASCADE`.execute(db);
  }
  for (const enumType of [
    'booking_event_type',
    'booking_status',
    'membership_role',
    'resource_kind',
  ] as const) {
    await sql`DROP TYPE IF EXISTS ${sql.id(enumType)}`.execute(db);
  }
}
