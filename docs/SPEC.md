# Slotline — Technical Spec

> Status: Built · 2026-07-26 · Spec version 1.1
> All five milestones in §10 are implemented and verified. Where the build proved a
> decision wrong, this document was corrected rather than left aspirational — those
> places say so inline. Operations live in [RUNBOOK.md](RUNBOOK.md).
> Working name. Rename by changing the package names and the `<title>`; nothing else depends on it.

## 1. Problem & Users

Organizations with shared rooms, shared equipment, and consultants whose time is bookable currently coordinate through a wall calendar, a shared spreadsheet, or a group chat. Every one of those allows two people to claim the same thing at the same time, and the collision is discovered at the moment it costs the most — when both parties show up. Existing calendar tools treat a room as an optional attribute of a meeting rather than a resource with its own availability, so nothing actually prevents the second booking.

**Primary user:** an employee who needs a specific room, a specific piece of equipment, or an hour with a specific consultant, and needs to know the moment they click that it is genuinely theirs.

**Success looks like:** zero double-bookings, structurally — not "we haven't seen one lately." Two people clicking the same slot in the same millisecond produces one booking and one clear rejection, and the loser's calendar shows the truth within a second without a refresh.

## 2. Scope

### In scope

- Sign up a new organization and invite colleagues into it; organizations never see each other's data.
- Define bookable resources of three kinds: rooms, equipment, consultants.
- Define when each resource is bookable — weekly opening hours plus dated exceptions (holidays, maintenance, leave).
- Book a resource for a time window, with the system refusing any window that overlaps an existing booking or falls outside the resource's availability.
- Cancel and reschedule bookings; a cancelled slot becomes immediately bookable again.
- See a week grid per resource and a day grid across resources, updating live as other people book.
- Three roles — owner, admin, member — with resource and user administration restricted to admins.

### Explicitly out of scope

- **Recurring bookings** ("every Tuesday at 10") — v2. It changes the booking from a row into a series with per-occurrence exceptions, which is the single largest thing that could be added here.
- **Pooled resources** ("any one of our three projectors") — v2. Requires an allocation step; see Assumption 2 for the v1 modelling that avoids it.
- **Buffer / turnaround time** between bookings (room reset, consultant travel) — v2. Trivially added later as a per-resource padding applied before the overlap check.
- **Multi-day bookings** (an overnight equipment loan) — v2. See Assumption 4.
- **Email and notifications** of any kind. No email provider is in the stack; see Assumption 3 for how user invitations work without one.
- **Google / Outlook calendar sync** — v2, and a large v2.
- **Approval workflows** (a booking that a resource owner must accept) — not requested. Bookings are immediate and final.
- **Free-slot search** ("find me 30 minutes with Dana this week") — the calendar grid shades unavailable time from the availability rules the client already holds, which covers the need without a search endpoint.
- **Billing / plan limits.** Tenant signup is open and free (Assumption 6).
- **Usage analytics and reporting** — not requested.

## 3. Architecture

### Overview

One Fastify process serving a JSON API, an SSE stream, and the built SPA as static files — same origin, so there is no CORS surface and no cross-site cookie problem. One Postgres database holds every tenant's data in a shared schema, isolated by row-level security. The double-booking guarantee is not application logic: it is a GiST exclusion constraint in Postgres, so it holds under concurrency, under retries, and under a future second application instance without anyone having to be careful.

```
┌────────────────────┐
│  Browser (SPA)     │
│  React + Vite      │
└─────────┬──────────┘
          │ HTTP/JSON (same origin, session cookie)
          │ SSE: GET /api/stream  (text/event-stream, Last-Event-ID)
          ▼
┌────────────────────────────────────────────────┐
│  Fastify 4 (single process, single origin)     │
│                                                │
│  routes/ ──► services/ ──► domain/ ◄── db/     │
│                    │                           │
│                    ▼                           │
│              realtime/ (SSE hub)               │
└───────┬─────────────────────────┬──────────────┘
        │ SQL (pool: app_tenant,  │ LISTEN booking_events
        │      RLS enforced)      │ (pool: dedicated connection)
        │ SQL (pool: app_auth,    │
        │      pre-auth lookups)  │
        ▼                         ▼
┌────────────────────────────────────────────────┐
│  Postgres 16                                   │
│  • EXCLUDE USING gist  ← the booking guarantee │
│  • ROW LEVEL SECURITY  ← the tenant boundary   │
│  • NOTIFY on commit    ← the live-update fanout│
└────────────────────────────────────────────────┘
```

### Components

| Component         | Responsibility                                                                                                                                                                                                        | Technology                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `web`             | The SPA. Renders calendars, submits bookings, subscribes to the event stream. Holds no authorization logic — it hides buttons for convenience only.                                                                   | Vite 5, React 18, TypeScript, TanStack Query 5, react-big-calendar 1.x, Luxon 3 |
| `api/routes`      | HTTP surface: parse, validate with Zod, call a service, map a domain error to a status code. Contains no business rules.                                                                                              | Fastify 4                                                                       |
| `api/services`    | Orchestration. The only place a transaction begins. Owns the tenant-scoped connection.                                                                                                                                | TypeScript                                                                      |
| `api/domain`      | Pure functions: does this window fall inside this resource's availability, is this local time valid, what does a weekly rule expand to on this date. Imports no framework and no `pg`; testable with nothing running. | TypeScript + Luxon                                                              |
| `api/db`          | Kysely schema types, SQL migrations, query builders. The only place SQL is written.                                                                                                                                   | Kysely 0.27, `pg` 8, `btree_gist`, `citext`                                     |
| `api/realtime`    | Holds open SSE responses, receives `NOTIFY`, reads new events, fans out to subscribers of the right tenant. The only module allowed to hold a long-lived raw `pg` client.                                             | Node streams + Postgres LISTEN/NOTIFY                                           |
| `packages/shared` | Zod schemas and the types inferred from them, imported by both `api` and `web`. One definition of every payload.                                                                                                      | Zod 3                                                                           |
| Postgres          | Storage, tenant isolation, and the overlap guarantee.                                                                                                                                                                 | Postgres 16 on Render                                                           |

### Decisions

**Double-booking prevention** — a partial GiST exclusion constraint on `bookings (resource_id WITH =, period WITH &&) WHERE status = 'confirmed'`.
Because: §1 requires the guarantee to be structural. A `SELECT … WHERE overlaps` followed by an `INSERT` is a race no matter how it is written; two concurrent requests both see an empty result and both insert. The exclusion constraint makes the second insert fail at commit with SQLSTATE `23P01`, which the API maps to `409 SLOT_TAKEN`.
Instead of: `SELECT FOR UPDATE` on the resource row — correct, but serializes every booking for a resource behind a lock the application must remember to take, and one forgotten code path silently reopens the hole. Instead of: `SERIALIZABLE` isolation — also correct, but pushes retry logic into every caller and costs far more than one index.
Revisit if: pooled resources (Assumption 2) or buffer time enter scope. Both still work with an exclusion constraint, but the `period` expression changes and the migration needs care.

**Multi-tenancy** — shared database, shared schema, `tenant_id` on every tenant-owned table, enforced by Postgres row-level security rather than by `WHERE` clauses.
Because: the risk checklist's highest-value item is tenant isolation implemented once rather than re-implemented in every handler. With RLS the failure mode of a forgotten `WHERE tenant_id = …` is _zero rows_, not _another tenant's rows_.
Instead of: schema-per-tenant — real isolation, but migrations must run N times and connection pooling gets ugly past a few dozen tenants. Instead of: repository-layer scoping — one missed method leaks, permanently.
Revisit if: a single tenant needs data residency in a specific country, or one tenant grows large enough to want its own database.

**Live push** — Server-Sent Events, fanned out via Postgres `LISTEN`/`NOTIFY`, replayable from a `booking_events` table via `Last-Event-ID`.
Because: the flow is one-way — the server tells clients what changed; clients never push over the socket. SSE is one HTTP response, reconnects automatically in every browser, and replays from a header for free. `NOTIFY` fires on commit, so a client can never be told about a booking that later rolls back.
Instead of: WebSockets — bidirectional machinery for a one-way problem, plus its own reconnect and heartbeat code. Instead of: polling — simpler still, but the user asked for calendars that update within a second, and polling at that rate across every open tab costs more than the stream does. Instead of: Redis pub/sub — new infrastructure to move messages between processes when the database every process already talks to can do it.
Revisit if: clients ever need to send over the same channel (presence, "someone is holding this slot"), which is the point at which WebSockets earn themselves.

**Hosting and database** — Render, running both the web service and Render Postgres in the same region.
Because: Render Postgres is plain managed Postgres with `LISTEN`/`NOTIFY` on the direct connection, which the live-update design depends on; the app and the database sit on the same private network; and one dashboard covers deploys, logs, and backups.
Instead of: Neon — the better developer experience on branching, but Neon does not support `LISTEN`/`NOTIFY`, which would silently break the fan-out. Instead of: Supabase — fine Postgres, but its value is the auth/storage/realtime stack this design does not use, and its Realtime product would duplicate the SSE layer.
Revisit if: the SSE layer is ever replaced by polling — then any managed Postgres including Neon becomes eligible.

**Database access layer** — Kysely with hand-written SQL migrations.
Because: the two features carrying this product — the exclusion constraint and row-level security — are Postgres-specific DDL that ORMs treat as escape hatches. Kysely gives full type inference over queries without pretending the database is portable.
Instead of: Prisma — cannot express exclusion constraints or RLS policies in its schema language, so the most important lines of the system would live in `migrations/*.sql` that Prisma's own tooling doesn't understand. Instead of: raw `pg` — no type safety on results, and this codebase has enough joins to feel it.
Revisit if: never, realistically. This is the layer least worth changing.

**Auth** — session cookies with server-side session rows, hand-rolled (~150 lines), argon2id password hashing.
Because: the requirement is email + password inside a known organization. Sessions in a table are revocable, which JWTs are not without adding the table back.
Instead of: Clerk or Auth.js — Clerk's Organizations feature genuinely models multi-tenancy well, but the tenancy model _is_ this system's data design; delegating it means the tenant boundary lives at a vendor while the RLS policies live here, and the two must be kept in agreement forever. Instead of: JWT in `localStorage` — XSS-readable, and not revocable.
Revisit if: SSO / SAML is requested, which is the point at which building it is the wrong call.

**Timezone authority** — all instants stored as `timestamptz` in UTC; all availability rules expressed as wall-clock minutes interpreted in the _resource's_ timezone; the UI renders in the tenant's timezone, never the browser's.
Because: a room is in a place. A colleague in another country looking at "Room A, Tuesday 09:00" must see the time that room's occupants mean, not their own local rendering of it.
Instead of: rendering in browser-local time — every remote participant reads a different grid for the same room.
Revisit if: never; this is the standard answer and the alternative causes support tickets.

## 4. Project Layout & Conventions

### Directory layout

```
slotline/
├── apps/
│   ├── api/
│   │   ├── src/
│   │   │   ├── routes/       # Fastify plugins, one file per resource path. Zod parse in, service call, error→status out. No SQL, no business rules.
│   │   │   ├── services/     # Orchestration across domain + db. The only place `withTenant`/transactions are opened.
│   │   │   ├── domain/       # Pure business rules. Imports no Fastify, no pg, no Kysely. Luxon is the only permitted dependency.
│   │   │   ├── db/           # Kysely instance, generated table types, migrations/*.ts. The only place SQL text exists.
│   │   │   ├── realtime/     # SSE hub + the LISTEN connection. The only module holding a raw long-lived pg client.
│   │   │   ├── lib/          # errors.ts, ids.ts, logger.ts, password.ts. No domain knowledge — if it needs a Booking, it isn't lib.
│   │   │   └── config/       # env.ts: Zod-parsed environment. Throws at boot, never at request time.
│   │   └── test/             # Integration tests that need a real Postgres. Unit tests live beside their source.
│   └── web/
│       └── src/
│           ├── routes/       # One file per URL. Route element + data loading only. No layout, no business logic.
│           ├── features/     # calendar/ resources/ availability/ users/ auth/ — components, hooks, local state colocated. Cross-feature imports go through the feature's index.ts only.
│           ├── components/   # Shared presentational components. Never fetch data.
│           ├── hooks/        # Shared hooks (useSession, useEventStream).
│           └── lib/          # api-client.ts, event-stream.ts, formatters. Knows HTTP, knows nothing about rooms.
├── packages/
│   └── shared/src/           # Zod schemas + inferred types imported by both apps. Depends on zod and nothing else.
├── .env.example              # Every variable, empty values, committed.
├── CLAUDE.md                 # Points at this file first.
└── docs/SPEC.md              # This document.
```

### Dependency direction

```
routes → services → domain ← db
                       ↑
                 (imports nothing but Luxon)

web → packages/shared ← apps/api
```

- **`domain/` imports no framework and no database client.** Overlap math, availability expansion, and local-time validation are testable with no Postgres and no HTTP server running. This is the rule that keeps booking rules from dissolving into route handlers.
- **Booking logic is three files, not one.** `booking-queries.ts` holds the row shapes and reads every path shares; `booking-service.ts` creates and lists; `booking-lifecycle-service.ts` cancels and reschedules. Creating a booking and changing one turned out to be different jobs with different failure modes, and the split is what lets `availability-service` ask "which bookings no longer fit?" without importing either.
- **One exception, deliberate: the availability _window arithmetic_ lives in `packages/shared`, not in `domain/`.** The calendar shades closed hours and the server refuses bookings outside them, and those two answers must never disagree — two implementations of one rule eventually do. `shared` holds the pure minute arithmetic (`windowsForLocalDate`, `mergeWindows`, `containsWindow`); `domain/` holds the instant-to-wall-clock conversion, because only the API has Luxon. The split is by dependency, not by convenience.
- **`db/` depends on `domain/`, never the reverse.**
- **`routes/` never imports `db/`.** A route that needs data calls a service.
- **`realtime/` is a leaf.** Services publish to it; it imports nothing from services.
- No circular imports — enforced by `madge --circular` in CI.

### Naming

| Kind                 | Convention                          | Example                                         |
| -------------------- | ----------------------------------- | ----------------------------------------------- |
| Type / interface     | PascalCase noun, no `I` prefix      | `Booking`, `AvailabilityWindow`                 |
| Function             | camelCase verb phrase               | `expandWeeklyRules`, `assertWithinAvailability` |
| Boolean              | `is` / `has` / `can` prefix         | `isActive`, `canManageResources`                |
| Constant             | SCREAMING_SNAKE, module scope       | `MAX_BOOKING_MINUTES`                           |
| Module file          | kebab-case matching its main export | `booking-service.ts`                            |
| React component file | PascalCase matching the component   | `ResourceWeekGrid.tsx`                          |
| Unit test            | beside the source                   | `availability.test.ts`                          |
| DB table             | snake_case plural                   | `bookings`, `availability_rules`                |
| DB column            | snake_case singular                 | `resource_id`, `start_minute`                   |
| Timestamp column     | `*_at`, always UTC `timestamptz`    | `created_at`, `cancelled_at`                    |
| Boolean column       | `is_*`, never negated               | `is_active`                                     |
| REST path            | plural nouns, no verbs              | `POST /api/bookings`                            |
| SSE event            | `entity.past_tense`                 | `booking.cancelled`                             |
| Env var              | `APP_` prefix, SCREAMING_SNAKE      | `APP_DATABASE_URL`                              |
| Branch               | `type/short-description`            | `feat/exclusion-constraint`                     |

Banned as suffixes: `Manager`, `Helper`, `Util`, `Processor`, `Data`, `Info`. `Service` is permitted only in `services/`, where it names the layer.

### Size limits

Enforced by ESLint so they are never a review opinion.

| Unit                  | Soft          | Hard | Lint rule                |
| --------------------- | ------------- | ---- | ------------------------ |
| File                  | 300 lines     | 500  | `max-lines`              |
| Function              | 40 lines      | 80   | `max-lines-per-function` |
| Parameters            | 3             | 4    | `max-params`             |
| Nesting depth         | 3             | 4    | `max-depth`              |
| Cyclomatic complexity | 10            | 15   | `complexity`             |
| React component       | 150 lines JSX | 250  | `max-lines` on `.tsx`    |

### Tooling

| Concern         | Tool                                                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| Package manager | npm 10+ workspaces (`package-lock.json` committed)                                                                   |
| Formatter       | Prettier — formatting is never a review comment                                                                      |
| Linter          | ESLint 9 + `typescript-eslint` strict, with `no-floating-promises` and `no-explicit-any` as errors                   |
| Types           | TypeScript 5.5, `strict: true`, `noUncheckedIndexedAccess: true` from the first commit                               |
| Validation      | Zod 3, schemas in `packages/shared`, used server-side as the control and client-side as UX                           |
| Tests           | Vitest; integration tests run against a real Postgres 16 container                                                   |
| Migrations      | Kysely `Migrator` with `FileMigrationProvider`, forward-only, one file per change                                    |
| Pre-commit      | format + lint on staged files (`lint-staged`)                                                                        |
| CI              | GitHub Actions: format check, lint, typecheck, unit tests, integration tests against Postgres service — all blocking |

**Frontend layout rule, from commit one:** CSS logical properties only (`margin-inline-start`, `padding-block`, `inset-inline-start`, `text-align: start`) and `dir` set on `<html>`. No `margin-left`, no `left: 0`, no hardcoded directional chevrons. See Assumption 8 — this costs nothing now and is the difference between a config change and a rewrite if Hebrew is ever added.

## 5. Data Models

Postgres DDL is the source of truth; Kysely types are generated from it. Every optional column states why it can be absent.

### Extensions and enums

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- required: equality operator for resource_id inside a GiST exclusion constraint
CREATE EXTENSION IF NOT EXISTS citext;       -- case-insensitive email and tenant slug

CREATE TYPE resource_kind      AS ENUM ('room', 'equipment', 'consultant');
CREATE TYPE membership_role    AS ENUM ('owner', 'admin', 'member');
CREATE TYPE booking_status     AS ENUM ('confirmed', 'cancelled');
CREATE TYPE booking_event_type AS ENUM ('booking.created', 'booking.rescheduled', 'booking.cancelled');
```

All ids are UUIDv7, generated in the application (`uuidv7` package). Time-ordered, so index locality matches autoincrement, without leaking row counts in URLs.

### Tables

```sql
CREATE TABLE tenants (
  id         uuid PRIMARY KEY,
  slug       citext NOT NULL UNIQUE,       -- login URL segment; CHECK enforces ^[a-z0-9-]{3,32}$
  name       text   NOT NULL,
  timezone   text   NOT NULL,              -- IANA zone; validated against Intl.supportedValuesOf('timeZone') on write
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenants_slug_shape CHECK (slug ~ '^[a-z0-9-]{3,32}$')
);

CREATE TABLE users (
  id                   uuid PRIMARY KEY,
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email                citext NOT NULL,
  password_hash        text   NOT NULL,     -- argon2id
  display_name         text   NOT NULL,
  role                 membership_role NOT NULL DEFAULT 'member',
  is_active            boolean NOT NULL DEFAULT true,   -- false = cannot log in; their bookings are retained (§9)
  must_change_password boolean NOT NULL DEFAULT false,  -- true after admin creates the account with a temp password
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)                 -- email is unique per tenant, not globally (Assumption 1)
);

CREATE TABLE sessions (
  token_hash bytea PRIMARY KEY,             -- sha256 of a 32-byte random token; the raw token exists only in the cookie
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx    ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE resources (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind        resource_kind NOT NULL,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  timezone    text,                          -- null = inherit tenants.timezone. Present but not exposed in the v1 UI (Assumption 9)
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,  -- the consultant's own account; null for rooms and equipment
  capacity    integer,                       -- rooms only, informational; null when the concept does not apply
  min_minutes integer NOT NULL DEFAULT 15,
  max_minutes integer NOT NULL DEFAULT 480,
  is_active   boolean NOT NULL DEFAULT true, -- false = no new bookings; existing future bookings stand (§8)
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resources_minutes_ok      CHECK (min_minutes >= 5 AND max_minutes <= 720 AND min_minutes <= max_minutes),
  CONSTRAINT resources_user_consultant CHECK (user_id IS NULL OR kind = 'consultant'),
  CONSTRAINT resources_name_length     CHECK (char_length(name) BETWEEN 1 AND 120),
  UNIQUE (tenant_id, kind, name)
);

-- Weekly opening hours. A resource with zero rules is bookable 24/7 — the correct default for equipment.
CREATE TABLE availability_rules (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  resource_id  uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  weekday      smallint NOT NULL,   -- ISO-8601: 1 = Monday … 7 = Sunday, matching Luxon's `weekday`
  start_minute integer  NOT NULL,   -- minutes from local midnight in the resource's timezone
  end_minute   integer  NOT NULL,
  CONSTRAINT availability_rules_ok CHECK (
    weekday BETWEEN 1 AND 7 AND start_minute >= 0 AND end_minute <= 1440 AND start_minute < end_minute)
);
CREATE INDEX availability_rules_resource_idx ON availability_rules (resource_id, weekday);

-- Dated overrides: a closure (holiday, maintenance, leave) or a one-off open window.
CREATE TABLE availability_exceptions (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  resource_id  uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  local_date   date NOT NULL,       -- a calendar date in the resource's timezone. Deliberately `date`, not an instant: a holiday has no timezone.
  is_available boolean NOT NULL,    -- false = closed all day; true = open ONLY in the window below, replacing that day's weekly rules
  start_minute integer,             -- null iff is_available = false
  end_minute   integer,
  reason       text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT availability_exceptions_ok CHECK (
    (is_available = false AND start_minute IS NULL AND end_minute IS NULL) OR
    (is_available = true  AND start_minute IS NOT NULL AND end_minute IS NOT NULL
      AND start_minute >= 0 AND end_minute <= 1440 AND start_minute < end_minute)),
  UNIQUE (resource_id, local_date)
);

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
  version              integer NOT NULL DEFAULT 1,   -- optimistic concurrency; surfaced as the ETag
  idempotency_key      text,                          -- null for bookings not created through POST /api/bookings
  cancelled_at         timestamptz,                   -- null iff status = 'confirmed'
  cancelled_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bookings_range_ok        CHECK (ends_at > starts_at),
  CONSTRAINT bookings_title_length    CHECK (char_length(title) BETWEEN 1 AND 200),
  CONSTRAINT bookings_notes_length    CHECK (char_length(notes) <= 2000),
  CONSTRAINT bookings_cancel_coherent CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);

-- The product, in four lines. `[)` bounds mean a 10:00–11:00 booking and an 11:00–12:00 booking do not overlap.
-- The WHERE clause is what makes cancellation release the slot: a cancelled row leaves the index.
ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap
  EXCLUDE USING gist (resource_id WITH =, period WITH &&)
  WHERE (status = 'confirmed');

CREATE UNIQUE INDEX bookings_idempotency_idx ON bookings (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX bookings_calendar_idx ON bookings (tenant_id, starts_at) WHERE status = 'confirmed';
CREATE INDEX bookings_creator_idx  ON bookings (created_by_user_id, starts_at DESC);

-- Append-only. Serves three jobs: SSE replay after reconnect, the audit trail, and the NOTIFY payload source.
CREATE TABLE booking_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_id    uuid NOT NULL,          -- deliberately not a foreign key: the log must outlive any hard delete
  resource_id   uuid NOT NULL,
  type          booking_event_type NOT NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  payload       jsonb NOT NULL,         -- the full BookingDto as clients should hold it after this event
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX booking_events_replay_idx ON booking_events (tenant_id, id);
```

### Row-level security

```sql
-- Applied identically to: users, resources, availability_rules, availability_exceptions, bookings, booking_events
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings FORCE  ROW LEVEL SECURITY;
CREATE POLICY bookings_tenant_isolation ON bookings
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- tenants is scoped by its own id
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenants_self ON tenants
  USING (id = current_setting('app.tenant_id', true)::uuid);
```

`current_setting('app.tenant_id', true)` returns NULL when unset, so the policy evaluates false and returns zero rows. **Failure is closed.**

Three database roles:

| Role         | Privileges                                                                                                              | Used by                                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `app_owner`  | runs migrations and owns the data tables                                                                                | `npm run migrate`, never the running app                                                                                         |
| `app_auth`   | **owns** `tenants`, `users`, `sessions`, and holds no privilege whatsoever on `bookings`, `resources`, or anything else | exactly one module: `services/auth-service.ts`, for the pre-authentication lookups that by definition have no tenant context yet |
| `app_tenant` | `SELECT` on `tenants` and `users`, full DML on the five data tables, nothing on `sessions`; RLS applies to all of it    | every other query, always inside `withTenant()`                                                                                  |

**How `app_auth` sees across tenants without `BYPASSRLS`.** A login has to find the tenant before it can scope to it, so that one path needs to read `users` unscoped. The obvious mechanism, `ALTER ROLE app_auth BYPASSRLS`, requires superuser — which managed Postgres does not hand out, so it would work locally and fail on the first real deploy. Instead `app_auth` **owns** those three tables, and they are the only tables not marked `FORCE ROW LEVEL SECURITY`: a table owner bypasses its own non-forced policies. The five data tables are `FORCE`d, so not even their owner can read across tenants.

The rest of the boundary is enforced by `GRANT`s rather than by convention — if a future service reaches for the auth pool to read a booking, the query fails with a permission error instead of quietly bypassing tenant isolation.

### Relationships

- `tenants` 1:N everything — `ON DELETE CASCADE`. Deleting a tenant removes all of its data, irrecoverably.
- `resources` 1:N `bookings` — `ON DELETE RESTRICT`. A resource with any booking, past or future, cannot be hard-deleted; deactivate it instead.
- `users` 1:N `bookings` (as creator) — `ON DELETE RESTRICT`. Users are deactivated, never deleted, so history stays attributable (§9).
- `resources` 0:1 `users` — a consultant resource may be linked to that consultant's own account; `ON DELETE SET NULL`.
- `resources` 1:N `availability_rules`, 1:N `availability_exceptions` — `ON DELETE CASCADE`.

### Constraints & indexes worth naming

| Object                                                     | Prevents / serves                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `bookings_no_overlap` (GiST, partial)                      | Two confirmed bookings overlapping on one resource — under any concurrency                 |
| `bookings_idempotency_idx` (unique, partial)               | A double-clicked submit creating two bookings                                              |
| `bookings_calendar_idx`                                    | `WHERE tenant_id = $1 AND starts_at BETWEEN $2 AND $3` — the only query the calendar makes |
| `booking_events_replay_idx`                                | `WHERE tenant_id = $1 AND id > $lastEventId` — SSE reconnect replay                        |
| `users (tenant_id, email)` unique                          | Two accounts with one email inside one organization                                        |
| `availability_exceptions (resource_id, local_date)` unique | Two contradictory overrides on the same day                                                |

## 6. Interfaces

All request and response bodies are `application/json`. Every schema below lives in `packages/shared` as a Zod schema and is parsed server-side before a service is called — client-side validation is UX only.

Errors share one envelope: `{ "error": { "code": "SLOT_TAKEN", "message": "…", "details": {…} } }`. `code` is a typed union; clients switch on `code`, never on `message`.

### Shared DTOs

```ts
type BookingDto = {
  id: string;
  resourceId: string;
  createdByUserId: string;
  createdByDisplayName: string;
  title: string;
  notes: string;
  startsAt: string; // ISO 8601 with offset, always UTC: "2026-08-03T09:00:00.000Z"
  endsAt: string;
  status: 'confirmed' | 'cancelled';
  version: number;
};

type ResourceDto = {
  id: string;
  kind: 'room' | 'equipment' | 'consultant';
  name: string;
  description: string;
  timezone: string; // resolved: the resource's own zone, or the tenant's
  userId: string | null;
  capacity: number | null;
  minMinutes: number;
  maxMinutes: number;
  isActive: boolean;
};
```

### HTTP API — auth

| Signature                 | Purpose                       | Request → Response                                                                                       | Errors                                                                                                                            |
| ------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/signup`   | Create a tenant and its owner | `{tenantName, tenantSlug, timezone, email, password, displayName}` → `201 {user, tenant}` + `Set-Cookie` | `409 SLUG_TAKEN`; `422 WEAK_PASSWORD` (< 12 chars); `422 INVALID_TIMEZONE`                                                        |
| `POST /api/auth/login`    | Start a session               | `{tenantSlug, email, password}` → `200 {user, tenant}` + `Set-Cookie`                                    | `401 INVALID_CREDENTIALS` (identical for unknown tenant, unknown email, wrong password, and deactivated user); `429 RATE_LIMITED` |
| `POST /api/auth/logout`   | Delete the session row        | `—` → `204`                                                                                              | —                                                                                                                                 |
| `POST /api/auth/password` | Change own password           | `{currentPassword, newPassword}` → `204`; clears `must_change_password`                                  | `401`, `422 WEAK_PASSWORD`                                                                                                        |
| `GET /api/me`             | Current session               | `—` → `200 {user, tenant}`                                                                               | `401 UNAUTHENTICATED`                                                                                                             |

### HTTP API — resources & availability

| Signature                                                  | Purpose                                      | Request → Response                                                                             | Errors                                           |
| ---------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `GET /api/resources?kind=&includeInactive=`                | List                                         | → `200 {resources: ResourceDto[]}`                                                             | —                                                |
| `POST /api/resources`                                      | Create · **admin**                           | `{kind, name, description?, capacity?, userId?, minMinutes?, maxMinutes?}` → `201 ResourceDto` | `403 FORBIDDEN`; `409 NAME_TAKEN`                |
| `PATCH /api/resources/:id`                                 | Update · **admin**                           | partial of the above → `200 ResourceDto`                                                       | `403`, `404`, `409 NAME_TAKEN`                   |
| `DELETE /api/resources/:id`                                | Hard delete · **admin**                      | → `204`                                                                                        | `409 RESOURCE_HAS_BOOKINGS` — deactivate instead |
| `GET /api/resources/:id/availability-rules`                | Weekly hours                                 | → `200 {rules: [{weekday, startMinute, endMinute}]}`                                           | `404`                                            |
| `PUT /api/resources/:id/availability-rules`                | Replace the **whole** weekly set · **admin** | `{rules: [...]}` → `200 {rules, conflictingBookings: BookingDto[]}`                            | `403`, `422 OVERLAPPING_RULES`                   |
| `GET /api/resources/:id/availability-exceptions?from=&to=` | Dated overrides                              | → `200 {exceptions: [...]}`                                                                    | `404`                                            |
| `POST /api/resources/:id/availability-exceptions`          | Add one · **admin**                          | `{localDate, isAvailable, startMinute?, endMinute?, reason?}` → `201`                          | `403`, `409 EXCEPTION_EXISTS`                    |
| `DELETE /api/availability-exceptions/:id`                  | Remove one · **admin**                       | → `204`                                                                                        | `403`, `404`                                     |

`PUT …/availability-rules` replaces the entire weekly set in one transaction — there is no partial-update path, so the rules can never be observed half-applied. Its response carries `conflictingBookings`: existing future bookings that now fall outside the new hours. They are **not** cancelled (§8).

### HTTP API — bookings

| Signature                                 | Purpose                                                          | Request → Response                                                              | Errors                                                                                                                                                                                                                                               |
| ----------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/bookings?from=&to=&resourceId=` | Calendar range. `resourceId` repeatable; omitted = all resources | → `200 {bookings: BookingDto[]}`                                                | `422 RANGE_TOO_WIDE` (> 62 days)                                                                                                                                                                                                                     |
| `POST /api/bookings`                      | Book. Header `Idempotency-Key: <uuid>` **required**              | `{resourceId, startsAt, endsAt, title, notes?}` → `201 BookingDto`, `ETag: "1"` | `409 SLOT_TAKEN` · `422 OUTSIDE_AVAILABILITY` · `422 INVALID_RANGE` · `422 DURATION_OUT_OF_BOUNDS` · `422 IN_THE_PAST` · `422 TOO_FAR_AHEAD` · `422 SPANS_MIDNIGHT` · `409 RESOURCE_INACTIVE` · `404` when the resource id belongs to another tenant |
| `PATCH /api/bookings/:id`                 | Reschedule or edit. Header `If-Match: "<version>"` **required**  | `{startsAt?, endsAt?, title?, notes?}` → `200 BookingDto`, new `ETag`           | `412 VERSION_CONFLICT` · `409 SLOT_TAKEN` · `422 …` (as above) · `403 FORBIDDEN`                                                                                                                                                                     |
| `POST /api/bookings/:id/cancel`           | Cancel; frees the slot immediately                               | → `200 BookingDto`                                                              | `403`, `404`, `409 ALREADY_CANCELLED`                                                                                                                                                                                                                |
| `GET /api/bookings/mine?from=&to=`        | The caller's own bookings                                        | → `200 {bookings: BookingDto[]}`                                                | —                                                                                                                                                                                                                                                    |

`409 SLOT_TAKEN` carries `details: { conflictingStartsAt, conflictingEndsAt }` so the UI can highlight the taken block. It does **not** carry the other booking's title — that is governed by Open Question 1.

A repeated `Idempotency-Key` returns the original booking with `200` rather than `201`. Keys are matched per tenant and are not scoped by payload: a key reused with different arguments returns `409 IDEMPOTENCY_KEY_REUSED`.

### HTTP API — users

| Signature              | Purpose                                                                   | Request → Response                                                                                                                              | Errors                                                      |
| ---------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `GET /api/users`       | List members                                                              | → `200 {users: UserDto[]}`                                                                                                                      | —                                                           |
| `POST /api/users`      | Create an account · **admin** creates members, **owner** creates any role | `{email, displayName, role}` → `201 {user, temporaryPassword}` — the password is returned **once** and never stored in plaintext (Assumption 3) | `403`, `409 EMAIL_TAKEN`                                    |
| `PATCH /api/users/:id` | Change role / active · **admin**                                          | `{role?, isActive?}` → `200 UserDto`                                                                                                            | `403 FORBIDDEN`; `409 CANNOT_DEMOTE_SELF`; `409 LAST_OWNER` |

### SSE stream

```
GET /api/stream
Accept: text/event-stream
Last-Event-ID: 4821        (optional; sent automatically by the browser on reconnect)
```

Authenticated by the session cookie; the tenant is taken from the session and never from a query parameter. The stream carries every booking event in the tenant; the client filters to the resources currently on screen.

```
: keepalive                          ← comment frame every 25s, so proxies do not close an idle stream

id: 4822
event: booking.created
data: {"booking":{"id":"018f…","resourceId":"018f…","startsAt":"2026-08-03T09:00:00.000Z", … }}

id: 4823
event: booking.cancelled
data: {"booking":{ … ,"status":"cancelled","version":2}}

event: resync
data: {"reason":"event_horizon"}     ← no id; the client must refetch its visible range
```

| Event                 | When                                                                                  | Client action                                             |
| --------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `booking.created`     | A booking is committed                                                                | Insert into the local cache if the resource is on screen  |
| `booking.rescheduled` | `starts_at`/`ends_at`/`title`/`notes` changed                                         | Replace by id, if `version` is higher than the cached one |
| `booking.cancelled`   | A booking is cancelled                                                                | Remove from the grid                                      |
| `resync`              | `Last-Event-ID` is further behind than replay can cover, or ahead of our newest event | Discard the cache and refetch the visible range           |

**Known gap in the day view.** The across-resources day grid does not shade opening hours. React Big Calendar hands the slot-styling hook a time but not which resource column it belongs to, and each column has its own hours — showing one resource's closures across all of them would mislead more than showing none. The server still refuses anything outside a resource's hours, so the cost is that a refusal there is a surprise rather than a prediction. Fixing it properly needs a custom column renderer; the single-resource week view is shaded correctly today.

An **unparseable** `Last-Event-ID` is treated as absent rather than as a resync: it means a malformed request, not a client that has lost history, so it is simply started fresh. An id _ahead_ of our newest event does mean resync — that is a restore, a different database, or a very stale tab.

Limits: 3 concurrent streams per user (a fourth is refused with `409`), 500 per process (`503`). Replay is capped at 2,000 events; beyond that the server sends `resync` instead.

### Internal boundary — Postgres NOTIFY

```
channel: booking_events
payload: {"tenantId":"018f…","eventId":4822}
```

Emitted with `pg_notify()` inside the same transaction as the booking write, so it is delivered only on commit and can never announce a rolled-back booking. The payload deliberately carries only identifiers — `NOTIFY` payloads are capped at 8,000 bytes, and a booking with a 2,000-character note would approach it. The hub reads the full row itself, and skips the read entirely for tenants with no connected clients.

## 7. Core Flows

### Flow A — Book a slot, including the race

1. User drag-selects 10:00–11:00 on Room A in the week grid. `web/features/calendar` renders an optimistic block in a pending style and issues `POST /api/bookings` with a freshly generated `Idempotency-Key`.
2. `routes/bookings.ts` parses the body with the shared Zod schema and rejects anything malformed with `422` before a service is touched.
3. `services/booking-service.ts` opens `withTenant(tenantId)` — `BEGIN; SET LOCAL app.tenant_id = $1;` — so every statement below is tenant-scoped by the database.
4. It loads the resource. Inactive → `409 RESOURCE_INACTIVE`. It loads that resource's weekly rules and any exception on the affected local date.
5. `domain/availability.ts` — pure, no I/O — converts `startsAt`/`endsAt` into the resource's timezone, checks that both fall on the same local date, that the duration sits within `[min_minutes, max_minutes]`, that the start is not in the past beyond a 5-minute grace, that it is under 365 days ahead, and that the window sits inside an open availability window. Any failure → `422` with the specific code.
6. It inserts the booking. **This is the only overlap check that matters.** If a concurrent transaction committed an overlapping booking first, Postgres raises SQLSTATE `23P01` here.
7. On `23P01`: the transaction rolls back, `lib/errors.ts` maps it to `409 SLOT_TAKEN`, and the service re-reads the winning booking's window to fill `details`. The client removes its optimistic block and shows the slot as taken.
8. On success: it inserts a `booking_events` row and calls `pg_notify('booking_events', …)` — both inside the same transaction — then commits.
9. `201` with `ETag: "1"`. The client replaces its optimistic block with the server's booking.

**Failure branches:** network timeout after the server committed → the client retries with the _same_ `Idempotency-Key` and gets `200` with the original booking, never a duplicate. Double-click → the second request hits `bookings_idempotency_idx` and returns the same booking.

### Flow B — Everyone else's calendar updates

1. Postgres delivers the `NOTIFY` on commit to the one connection `realtime/listener.ts` holds open.
2. The hub reads `tenantId` from the payload. If no client from that tenant is connected, it stops here — no query is issued.
3. Otherwise it reads the event rows for that tenant above the last id it fanned out, using `withTenant` on the normal pool. There is no RLS bypass anywhere in this path.
4. Each connected response for that tenant receives an SSE frame with the event `id`, type, and the booking payload.
5. `web/lib/event-stream.ts` receives it, and `web/hooks/useEventStream.ts` patches the TanStack Query cache for the visible range. A booking on a resource not currently displayed is discarded.

**Failure branches:** the listener connection drops → it reconnects with backoff and, on reconnect, reads every event newer than its last-seen id, so nothing is lost. The process restarts → all streams drop, browsers reconnect automatically with `Last-Event-ID`, and replay covers the gap. A client sleeps for an hour → replay from `booking_events`; if that exceeds 2,000 events, it gets `resync` and refetches.

### Flow C — Reschedule under concurrent edits

1. The user drags an existing booking to a new time. The client sends `PATCH /api/bookings/:id` with `If-Match: "3"` — the `version` it holds.
2. The service runs a single `UPDATE … SET starts_at = $1, ends_at = $2, version = version + 1 WHERE id = $3 AND version = 3`.
3. Zero rows updated → someone else changed it since the client loaded it → `412 VERSION_CONFLICT`. The client refetches and asks the user to redo the move rather than silently overwriting.
4. One row updated, but it now overlaps another confirmed booking → `23P01` on the same exclusion constraint → `409 SLOT_TAKEN`, transaction rolled back, the booking unchanged at its original time.
5. Success → `booking.rescheduled` event, `NOTIFY`, commit, `200` with the new `ETag`.

**Failure branches:** a member attempting to move someone else's booking is rejected at step 2 with `403` — members may modify only bookings they created (§9).

## 8. Edge Cases & Failure Modes

| Case                                                                   | Consequence if unhandled                                                                 | Handling                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two users book one slot within milliseconds                            | Both succeed; two groups arrive at one room — the failure this product exists to prevent | Exclusion constraint raises `23P01` on the loser; mapped to `409 SLOT_TAKEN` with the winning window                                                                                                                                                                                                                                        |
| Double-click / retry-on-timeout                                        | Two identical bookings back to back                                                      | `Idempotency-Key` unique index; the repeat returns the original booking with `200`                                                                                                                                                                                                                                                          |
| Reschedule into a slot taken meanwhile                                 | Silent overlap, or a booking left in a half-moved state                                  | Single atomic `UPDATE`; `23P01` → `409` and the booking stays where it was                                                                                                                                                                                                                                                                  |
| Two admins edit the same booking                                       | Last write wins silently; one person's change vanishes                                   | `If-Match` on `version` → `412 VERSION_CONFLICT`, client refetches                                                                                                                                                                                                                                                                          |
| DST spring-forward: a grid offering 02:30 on a night that has no 02:30 | Luxon resolves it forward to 03:30 and the user books an hour they did not pick          | **Client-side only.** The wire format is an absolute instant, and every instant has exactly one valid local reading — so the server has nothing to reject and never raises `INVALID_LOCAL_TIME`. The calendar must not draw skipped hours (M2, when it draws availability at all). Documented in `domain/time.ts`, where a reader will look |
| DST fall-back: 01:30 occurs twice                                      | Ambiguous instant, chosen arbitrarily                                                    | The **earlier** offset is taken, deterministically, and the API documents it. The UI labels the repeated hour                                                                                                                                                                                                                               |
| A weekly rule 09:00–17:00 on a DST changeover day                      | Silently 23 or 25 hours of real time                                                     | Correct and intended: rules are wall-clock. Availability is evaluated in local time, then converted — never the reverse                                                                                                                                                                                                                     |
| Booking crosses local midnight                                         | Availability rules are per-weekday and cannot express it; the check would silently pass  | Rejected with `422 SPANS_MIDNIGHT` (Assumption 4)                                                                                                                                                                                                                                                                                           |
| Admin narrows availability so existing future bookings fall outside it | Either bookings vanish, or the resource's hours are a lie                                | Existing bookings are **kept**. `PUT …/availability-rules` returns `conflictingBookings`; the admin decides. See Open Question 3                                                                                                                                                                                                            |
| Resource deactivated with future bookings                              | Bookings orphaned, or the deactivation silently cancels them                             | Deactivation blocks _new_ bookings only. Hard `DELETE` returns `409 RESOURCE_HAS_BOOKINGS`                                                                                                                                                                                                                                                  |
| Calendar query over a two-year range                                   | Unbounded result; the grid renders tens of thousands of blocks                           | `from`/`to` capped at 62 days, `422 RANGE_TOO_WIDE`; served by `bookings_calendar_idx`. The UI never requests more than the visible range plus one week                                                                                                                                                                                     |
| Empty state: a brand-new tenant with no resources                      | A blank grid that looks broken                                                           | Admins see a "create your first resource" panel; members see "no resources yet — ask an admin"                                                                                                                                                                                                                                              |
| SSE client sleeps, then reconnects                                     | Missed bookings never appear; the grid is stale but looks live                           | `Last-Event-ID` replay from `booking_events`; past 2,000 events or past retention, a `resync` frame forces a refetch                                                                                                                                                                                                                        |
| Process restart drops every stream                                     | Clients sit silently stale                                                               | Browsers reconnect automatically; replay closes the gap. This is the normal deploy path, not an exception                                                                                                                                                                                                                                   |
| Session expires while the stream is open                               | The stream dies with no explanation                                                      | The reconnect attempt returns `401`; the client redirects to login                                                                                                                                                                                                                                                                          |
| 4,000-character paste into a title                                     | Row bloat, broken layout                                                                 | Zod caps title at 200 and notes at 2,000; `CHECK` constraints enforce the same in the database                                                                                                                                                                                                                                              |
| Client clock is wrong by hours                                         | "Past" bookings accepted or valid ones rejected                                          | The server is the sole authority for _now_; the client sends absolute instants and the server judges them                                                                                                                                                                                                                                   |
| Last owner demoted or deactivated                                      | A tenant nobody can administer                                                           | `409 LAST_OWNER`; and no user may change their own role                                                                                                                                                                                                                                                                                     |
| Credential stuffing against `/api/auth/login`                          | Account takeover                                                                         | 10 attempts per 15 min per `(tenantSlug, email)` and per IP; identical `401` regardless of which part was wrong, so the endpoint never confirms an address exists                                                                                                                                                                           |

## 9. Security & Permissions

**Authentication.** Email + password within a tenant. Passwords hashed with argon2id (`@node-rs/argon2`, memory 19 MiB / time 2 / parallelism 1, the OWASP baseline). A session token is 32 bytes from `crypto.randomBytes`, sent in a cookie with `httpOnly; Secure; SameSite=Lax; Path=/`, and stored as a SHA-256 hash — a database leak does not yield usable sessions. Sessions live 30 days, sliding on use, and are rotated on login and on password change. Logging out and deactivating a user both delete every session row for that user, so revocation is immediate.

**CSRF.** `SameSite=Lax` blocks cross-site cookie submission on state-changing requests. Additionally, every mutating route requires `Content-Type: application/json` and an `Origin` header matching `APP_ORIGIN`. Since the API and the SPA share one origin, there is no CORS allowlist and no credentialed cross-origin path to get wrong.

**Authorization.**

| Role     | Can                                                                                                                                                                         | Cannot                                                                                                                             |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `owner`  | Everything an admin can, plus change roles and delete the tenant                                                                                                            | —                                                                                                                                  |
| `admin`  | Create/edit/deactivate resources, set availability rules and exceptions, create **member** accounts, activate and deactivate accounts, cancel or reschedule **any** booking | Delete the tenant; create or promote an admin or owner; demote the last owner; change their own role; deactivate their own account |
| `member` | View all resources, availability, and bookings; create bookings; cancel or reschedule **their own** bookings                                                                | Touch resources, availability, users, or anyone else's bookings                                                                    |

An admin can create members but not other admins, and cannot promote anyone. An admin who could mint another admin can escalate sideways without limit, which is the same hole as editing one's own role — so role changes are owner-only.

**Enforcement points — two, both named.**

1. _Tenant isolation_ is Postgres RLS. Every tenant-owned query runs through `withTenant(tenantId, fn)` in `db/with-tenant.ts`, which opens a transaction, issues `SET LOCAL app.tenant_id`, and runs the callback. Nothing else may take a connection from the `app_tenant` pool — the pool is not exported from that module. A forgotten scope returns zero rows, never another tenant's rows.
2. _Role checks_ are a Fastify `preHandler` decorator, `requireRole('admin')`, declared on the route definition. Ownership checks that depend on the row (`member` editing their own booking) live in the service, immediately after the row is loaded and before it is modified. Hiding a button in the UI is never a control.

The `app_auth` role is the single component with `BYPASSRLS`, and its reach is bounded by `GRANT`s to three tables — it cannot read a booking even if a future bug asks it to.

One subtlety worth stating: the exclusion constraint is enforced beneath RLS, so a conflict could in principle reveal that _some_ row exists that the caller cannot see. It cannot leak across tenants here, because `resource_id` is a UUID belonging to exactly one tenant — any row that conflicts is necessarily a row in the caller's own tenant.

**IDs.** UUIDv7 everywhere. Not enumerable, and no row counts leak through a URL.

**One driver-level setting that is a correctness decision, not a preference.** `db/index.ts` overrides node-postgres's parser for `DATE` so the column arrives as a plain string. The default parses it into a JavaScript `Date` at local midnight _in the server process's zone_ — which would give `availability_exceptions.local_date` a timezone it deliberately does not have, and shift a holiday closure onto the wrong day for any server not running in the resource's zone. Set once at the driver so no query site has to remember.

**Rate limits** (`@fastify/rate-limit`): 10 per 15 minutes on `POST /api/auth/login`, `/signup` and `/password`; 60/min on all other mutations, keyed per user where authenticated and per IP otherwise; 3 concurrent SSE streams per user. Reads are not limited.

Sign-in attempts are keyed on **`(tenantSlug, email)`**, not on the source address — an attacker moving between addresses must not get a fresh allowance against one account, and one shared office NAT must not be able to lock out a floor. Signup and login therefore share a budget for the same account, which is the intended shape: probing both surfaces buys one allowance, not two.

The store is in-memory and therefore **per process**. A shared store means Redis, and this design's own rule is that Redis needs a measured problem first; the trade-off only bites once there is a second instance, and it is recorded in the runbook's scale table rather than left to be discovered.

**Data handling.** The only personal data is a colleague's display name and work email — no payment data, no special-category data (per the answers in §11). Passwords are never logged, never returned, and never recoverable; an admin issues a new temporary password instead. `pino` is configured to redact `req.headers.cookie`, `req.headers.authorization`, and any field named `password`, `passwordHash`, or `temporaryPassword`. Client-facing errors carry a code and a generic message; stack traces go to logs only. Secrets live in Render's environment; `.env` is gitignored and `.env.example` is committed with empty values.

**Retention and deletion.** Users are deactivated, never deleted — their bookings remain attributable, and `ON DELETE RESTRICT` makes that a database guarantee rather than a policy. `booking_events` is pruned at 30 days by a daily `DELETE` (see Open Question 2). Deleting a tenant cascades to every row it owns and is irreversible; the API has no endpoint for it in v1, so it is an operator action against the database.

**Configuration.** `config/env.ts` parses `APP_DATABASE_URL`, `APP_AUTH_DATABASE_URL`, `APP_ORIGIN`, `APP_PORT`, `APP_LOG_LEVEL`, and `APP_NODE_ENV` with Zod at boot. A missing or malformed variable throws before the server listens — a misconfigured deploy fails visibly at 15:00 rather than quietly at 03:00.

**Operations.** Render Postgres daily backups with point-in-time recovery; a restore into a scratch database is a checklist item in M5, because an untested backup is not a backup. `GET /health` checks a database round-trip and returns the migration version. When something breaks, the operator looks at Render's service logs (structured `pino` JSON, one line per request with method, path, status, duration, `tenantId`, `userId`) and at `booking_events`, which is a complete history of every booking change.

## 10. Build Order

**M1 — A calendar that cannot double-book**
_Demo: two browsers, two accounts, both click 10:00 on Room A. One gets the booking; the other gets a clear "just taken" message. Refreshing proves there is exactly one booking._

- [ ] pnpm workspace, TypeScript strict, ESLint/Prettier, CI pipeline green on an empty repo
- [ ] Postgres schema + migrations: all tables, the GiST exclusion constraint, RLS policies, the three database roles
- [ ] `withTenant()` and the two connection pools
- [ ] Signup, login, logout, `GET /api/me`; argon2id; session cookies
- [ ] Resource CRUD with the `requireRole('admin')` guard
- [ ] `POST /api/bookings` with idempotency, `GET /api/bookings` range query
- [ ] `23P01` → `409 SLOT_TAKEN` mapping, with an integration test that fires two concurrent inserts and asserts exactly one wins
- [ ] SPA: login page, week grid for one resource, drag-to-book, conflict toast

**M2 — Availability**
_Demo: set Room A to Mon–Fri 09:00–17:00, add Christmas as a closure. The grid greys out closed hours; booking into one is refused with a reason._

- [ ] `availability_rules` and `availability_exceptions` endpoints
- [ ] `domain/availability.ts` — rule expansion, exception override, DST-correct local-time conversion — with unit tests covering both changeover days
- [ ] Availability editor UI; shaded closed hours on the grid
- [ ] `conflictingBookings` returned when rules are narrowed

**M3 — Live**
_Demo: two browsers side by side. One books; the other's grid shows it within a second, untouched._

- [ ] `booking_events` writes inside the booking transaction
- [ ] `pg_notify` on commit; `realtime/listener.ts` with reconnect and backoff
- [ ] `GET /api/stream`: SSE hub, heartbeats, per-user connection cap
- [ ] `Last-Event-ID` replay and the `resync` frame
- [ ] Client `useEventStream` patching the query cache
- [ ] Test: kill and restart the API mid-session, assert no event is lost

**M4 — Team and lifecycle**
_Demo: an admin adds a colleague, makes them an admin, and reschedules someone else's booking by dragging it. A member tries the same and is refused._

- [ ] User list, create-with-temporary-password, role and active changes, last-owner guard
- [ ] Forced password change on first login
- [ ] Cancel and reschedule, with `If-Match` optimistic concurrency
- [ ] Ownership checks for members; `GET /api/bookings/mine`
- [ ] Multi-resource day view (resource columns)

**M5 — Production hardening**
_Demo: a restore from backup into a scratch database, and a load test holding 200 concurrent SSE connections while bookings flow._

- [ ] Rate limits on auth and mutations
- [ ] `pino` redaction, request logging with tenant/user, `GET /health`
- [ ] `booking_events` daily prune; expired-session cleanup
- [ ] Backup restore rehearsal, documented in `docs/RUNBOOK.md`
- [ ] Empty states, error boundaries, and the `resync` path exercised end to end

## 11. Assumptions

Each is a decision made without explicit confirmation. Reject any by number and the affected sections change as noted.

1. **A user belongs to exactly one tenant.** Email is unique per tenant, not globally; a consultant working with two client organizations holds two accounts. _If wrong:_ `users` becomes global, a `memberships` join table appears, and `users` needs an RLS exception — a change to §5 and §9, cheapest to make now.
2. **Every bookable unit is its own resource row.** Three identical projectors are three resources named "Projector 1/2/3". There is no quantity field and no "book any available one". _If wrong:_ an allocation step appears between request and insert, and the exclusion constraint alone no longer suffices — this is the most expensive assumption in the list to reverse.
3. **No email delivery anywhere.** An admin creating a user receives a one-time temporary password in the API response and passes it on however they like. _If wrong:_ an email provider (Resend) joins the stack, along with verification, invitation, and password-reset flows — roughly a milestone of work.
4. **A booking starts and ends within one local calendar day**, and runs between 5 and 720 minutes. _If wrong:_ the availability model must express multi-day windows, and §8's midnight rule disappears.
5. **No recurring bookings**, in any milestone.
6. **Tenant signup is open and free**; anyone can create an organization, and there is no billing or plan limit. _If wrong:_ an invite-gate or a billing integration is needed before public launch.
7. **Hosted on Render** — web service and Postgres 16 in one region, on a paid instance type (free instances sleep, which would drop every SSE connection). _If wrong:_ any managed Postgres supporting `LISTEN`/`NOTIFY` works — Neon specifically does not.
8. **The UI is English-only and left-to-right**, but built with CSS logical properties and `dir` on `<html>` from the first commit. Adding Hebrew or Arabic later is a translation layer plus a `dir` flip, not a sweep through every stylesheet. _If wrong right now:_ add an i18n library in M1 and keep strings out of components; the layout work is already done.
9. **`resources.timezone` exists but is not exposed in the v1 UI.** Every resource inherits the tenant's timezone. The column is there so a tenant with offices in two countries is a UI change rather than a migration. _If wrong:_ surface it in the resource editor — a day's work, no schema change.
10. **Scale target: ≤ 200 tenants, ≤ 100 resources per tenant, ≤ 500k bookings total, ≤ 500 concurrent SSE connections**, served by a single application instance. _If wrong:_ the design survives horizontal scaling as-is — `LISTEN`/`NOTIFY` fans out to every instance and sessions live in the database, so no sticky routing is needed. The first thing to revisit past ~2M bookings is partitioning `bookings` by month.
11. **"Real-time" means live push of booking changes**, not presence ("Dana is looking at this slot") and not soft holds. Adding either is the point at which WebSockets replace SSE.

## 12. Open Questions

- **Can a `member` see the title and notes of other people's bookings, or only that the slot is busy?** — blocks: the §9 permission table's read column, the `BookingDto` returned to members, and whether `409 SLOT_TAKEN` may name the conflicting booking. _v1 behaves as:_ all details visible to everyone in the tenant. · needed by: **M4**
- **How long must `booking_events` be retained?** 30 days covers SSE replay; an audit requirement would mean years, and the pruning job in M5 becomes an archival job instead. _v1 behaves as:_ 30 days. · needed by: **M5**
- **When an admin narrows availability under existing future bookings, should the system offer to cancel them?** v1 lists them and does nothing, which is safe but leaves the admin cancelling by hand. A bulk-cancel action is small; whether it should exist is a policy call. _v1 behaves as:_ list only. · needed by: **M2**

None of these blocks M1.
