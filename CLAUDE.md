# Slotline — working notes

**Read [docs/SPEC.md](docs/SPEC.md) first.** It carries the architecture, the data model,
every interface signature, and the numbered assumptions. This file is only the short
version of what a session needs to avoid breaking things.

## The two invariants

1. **Double-booking is prevented by `bookings_no_overlap`**, a partial GiST exclusion
   constraint in Postgres — not by any check in TypeScript. Never add a
   `SELECT ... WHERE overlaps` before an insert and treat it as the guard; it is a race.
   The insert either succeeds or raises SQLSTATE `23P01`, which maps to `409 SLOT_TAKEN`.
2. **Tenant isolation is row-level security**, and the only way to open a tenant-scoped
   connection is `withTenant()`. The tenant pool is not exported from `db/index.ts`. Do
   not add `WHERE tenant_id = ...` by hand — if you feel the need to, something is
   already wrong.

`services/auth-service.ts` is the sole user of `authDb()`. Do not import it elsewhere;
that pool has no privileges on bookings or resources and the query will simply fail.

## Traps this codebase has already hit

- **Fastify hooks must be arity-3 or return a promise.** A synchronous one-argument
  `preHandler` never signals completion, and every _authenticated_ request hangs — while
  the unauthenticated path keeps working, because throwing short-circuits. Follow
  `requireAuth`/`requireRole` in `routes/plugins/auth.ts`.
- **An idempotent retry trips the exclusion constraint, not the idempotency index.** The
  retry overlaps its own earlier booking, so `23P01` fires first. `createBooking` checks
  for the replay _before_ interpreting a constraint violation as a taken slot; keep that
  ordering if you touch it.
- **`DATE` is parsed by node-postgres into a JS `Date` at the server's local midnight.**
  `db/index.ts` overrides that so `availability_exceptions.local_date` stays a plain
  calendar string. Do not remove it: a holiday has no timezone, and giving it one shifts
  closures onto the wrong day.
- **A booking event must be written through `recordBookingEvent`**, inside the same
  transaction as the booking. It writes the log row and the `pg_notify` together, so a
  rolled-back booking can never be announced to a connected client.
- **A Fastify hook that throws still short-circuits correctly**, which is why a broken
  hook can look like it works. Test the _authenticated_ path, not just the rejection.
- **`@fastify/rate-limit` throws whatever `errorResponseBuilder` returns.** It must be an
  `Error` carrying a status — ours returns an `AppError`. Returning a plain body object
  makes every throttled request a 500, and only under load, which is the worst time to
  find out.

## Where booking logic lives

`booking-queries.ts` (shared row shapes and reads) → `booking-service.ts` (create, list)
and `booking-lifecycle-service.ts` (cancel, reschedule). Nothing imports across the last
two; anything they both need belongs in `booking-queries.ts`.

## Layering

```
routes/ -> services/ -> domain/ <- db/
```

- `domain/` imports no Fastify, no `pg`, no Kysely. Luxon only. If a rule needs a
  database, it is not a domain rule.
- `routes/` parses with a Zod schema from `packages/shared`, calls one service, and maps
  an `AppError` to a status. No business rules.
- `services/` is where transactions begin.

## Conventions that are enforced

- TypeScript `strict` plus `noUncheckedIndexedAccess`. No `any`.
- Errors carry a typed `code` from `packages/shared/src/errors.ts`. Never match on a
  message string, on either side of the wire.
- CSS uses logical properties only (`margin-inline-start`, never `margin-left`). This is
  what keeps a future RTL language a config change rather than a rewrite.
- Times are stored as `timestamptz` in UTC; availability is wall-clock in the resource's
  zone. The UI renders in the tenant's zone, never the browser's.
- Size limits and the bans on `Manager`/`Helper`/`Util` are in `eslint.config.js`.

## Before starting a milestone

Check the spec's Build Order (§10) for what M-whatever actually includes, and the Open
Questions (§12) for what it depends on. If the code and the spec disagree, say so rather
than silently picking one — the spec is meant to stay true.
