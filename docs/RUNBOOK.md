# Slotline — Operations Runbook

For whoever is holding the pager. Design rationale lives in [SPEC.md](SPEC.md); this is
what to actually do.

---

## When something is wrong, look here first

| Question                    | Where                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Is the service up?          | `GET /health` — returns `{"status":"ok"}` only after a real database round-trip                              |
| What happened, and to whom? | Service logs. One JSON line per request: `method`, `path`, `status`, `durationMs`, `tenantId`, `userId`      |
| What happened to a booking? | `booking_events` — a complete history of every create, move and cancel, for the last 30 days                 |
| Is the live stream working? | Look for `booking event listener connected` at boot, and `booking event listener reconnecting` if it dropped |

Logs never contain cookies, `Authorization` headers, passwords, password hashes, or
issued temporary passwords. That is enforced by `lib/logger.ts` and asserted by
`lib/logger.test.ts` — if you add a field that could carry a secret, add it there too.

---

## Deploying

```bash
npm ci
npm run build          # builds shared, api, and the SPA
npm run migrate        # forward-only; safe to run when there is nothing pending
npm start --workspace apps/api
```

The API serves the built SPA from `apps/web/dist`, so there is one process and one
origin. If that directory is missing, the API logs `no built SPA found; serving the API
only` and every page load 404s — check the build ran.

**Environment.** All variables are parsed at boot by `config/env.ts`; a missing or
malformed one stops the process before it listens. That is deliberate: a misconfigured
deploy should fail at 15:00 during the rollout, not at 03:00 on the first request that
needed it.

**Deploy drops every SSE stream.** This is normal and self-healing: browsers reconnect
automatically and replay what they missed via `Last-Event-ID`. Users see the header flip
to "Reconnecting" and back. No action needed.

---

## First-time database setup

Roles are cluster-level objects and live outside the migration sequence.

```bash
APP_TENANT_ROLE_PASSWORD=... APP_AUTH_ROLE_PASSWORD=... npm run provision
npm run migrate
```

`provision` needs a superuser or a role with `CREATEROLE`. It is idempotent.

---

## Retention

The running server prunes once a day, a minute after boot and every 24 hours after:

- `booking_events` older than **30 days** — that is as far back as SSE replay can reach,
  so older rows serve nobody. If an audit requirement lands (Open Question 2), this
  becomes an archival step, not a delete.
- Sessions past their expiry.

To run it by hand, or from a platform cron once there is more than one instance:

```bash
npm run prune
```

It is idempotent. With several instances the in-process schedule runs on each of them,
which duplicates effort but not effect — move to platform cron at that point.

---

## Backup and restore

Render Postgres takes daily backups with point-in-time recovery. **An untested backup is
not a backup**, so the restore below has actually been run, not just written down.

### Take a dump

```bash
pg_dump -U <user> -h <host> -d slotline -Fc -f slotline-backup.dump
```

### Restore into a scratch database and verify

Never restore over a live database to check a backup. Restore beside it.

```bash
psql  -U postgres -h <host> -d postgres -c "CREATE DATABASE slotline_restore"
pg_restore -U postgres -h <host> -d slotline_restore --no-owner --role=postgres slotline-backup.dump
```

### Confirm the restore is real

Row counts alone are not enough — the two things that make this system correct are a
constraint and a set of policies, and both must survive.

```sql
-- 1. Data is there
SELECT count(*) FROM tenants;
SELECT count(*) FROM bookings;

-- 2. The double-booking guarantee survived
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint WHERE conname = 'bookings_no_overlap';

-- 3. Tenant isolation survived
SELECT count(*) FROM pg_policies WHERE schemaname = 'public';
```

**Last rehearsed: 2026-07-26**, against a database holding 5 tenants and 10 bookings.
Result: counts matched exactly, and both structural guarantees came back intact —

```
bookings_no_overlap / EXCLUDE USING gist (resource_id WITH =, period WITH &&)
                      WHERE ((status = 'confirmed'::booking_status))
8 policies
```

Expect **8 policies**: one per tenant-scoped table (`users`, `sessions`, `resources`,
`availability_rules`, `availability_exceptions`, `bookings`, `booking_events`) plus
`tenants_self`. A lower number after a restore means tenant isolation is missing — do not
point the application at it.

Drop the scratch database when finished:

```bash
psql -U postgres -h <host> -d postgres -c "DROP DATABASE slotline_restore"
```

---

## Incidents

### "Someone got double-booked"

This should be structurally impossible. Before anything else, check the constraint is
still on the table:

```sql
SELECT conname FROM pg_constraint WHERE conname = 'bookings_no_overlap';
```

If it is missing, a migration or a restore dropped it. Recreate it before taking any more
bookings — note that the `ALTER TABLE ... ADD CONSTRAINT` will fail if overlapping rows
already exist, which is itself the diagnosis.

```sql
SELECT a.id, b.id, a.resource_id, a.period, b.period
FROM bookings a JOIN bookings b
  ON a.resource_id = b.resource_id AND a.id < b.id AND a.period && b.period
WHERE a.status = 'confirmed' AND b.status = 'confirmed';
```

### "A workspace can see another workspace's data"

Check RLS is enabled and forced, and that the application is not connecting as a table
owner:

```sql
SELECT relname, relrowsecurity, relforcerowsecurity
FROM pg_class WHERE relname IN ('bookings','resources','booking_events');

SELECT current_user;  -- must be app_tenant for data queries, never app_owner
```

### "Calendars have stopped updating live"

The API is fine; the listener is not. Look for `booking event listener reconnecting` in
the logs. It backs off up to 10 seconds and recovers on its own. Nothing is lost — clients
replay on reconnect. If it never recovers, the database is refusing connections to
`app_tenant`, which is a bigger problem than the stream.

### "Everyone is getting 429s"

Rate limits are per process and in memory (SPEC §9). A restart clears them. If legitimate
traffic is hitting the write limit of 60/minute per user, that is a client bug — look at
the log line's `userId` and `path` to find the loop.

### "An admin locked themselves out"

There is no password reset, by design — no email provider is in the stack (Assumption 3).
An owner can create a replacement account with a temporary password. If the _last_ owner
is locked out, that needs direct database access:

```sql
UPDATE users SET must_change_password = true, password_hash = '<argon2id hash>'
WHERE tenant_id = '<uuid>' AND email = '<address>';
```

Generate the hash with the same parameters as `lib/password.ts` (argon2id, 19 MiB, 2
iterations, 1 lane). Then delete their sessions so nothing stale survives:

```sql
DELETE FROM sessions WHERE user_id = '<uuid>';
```

---

## Scale thresholds

From SPEC Assumption 10. None of these are near, but they are where to look when
something starts feeling slow:

| Signal             | Threshold       | What to revisit                                                                         |
| ------------------ | --------------- | --------------------------------------------------------------------------------------- |
| Bookings           | ~2M rows        | Partition `bookings` by month                                                           |
| Tenants            | a few thousand  | The retention loop visits each tenant in turn; batch it                                 |
| Concurrent streams | 500 per process | Add an instance; sessions are in the database, so no sticky routing is needed           |
| Instances          | more than one   | Move retention to platform cron; rate limits become per-process and need a shared store |
