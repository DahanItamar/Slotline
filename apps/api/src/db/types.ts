import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';
import type { BookingStatus, MembershipRole, ResourceKind } from '@slotline/shared';

/** `DEFAULT now()` columns: readable as Date, optional on insert. */
type CreatedAt = ColumnType<Date, Date | string | undefined, Date | string>;
type Instant = ColumnType<Date, Date | string, Date | string>;

export type BookingEventType = 'booking.created' | 'booking.rescheduled' | 'booking.cancelled';

export type TenantsTable = {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  created_at: CreatedAt;
  updated_at: CreatedAt;
};

export type UsersTable = {
  id: string;
  tenant_id: string;
  email: string;
  password_hash: string;
  display_name: string;
  role: ColumnType<MembershipRole, MembershipRole | undefined, MembershipRole>;
  is_active: ColumnType<boolean, boolean | undefined, boolean>;
  must_change_password: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: CreatedAt;
  updated_at: CreatedAt;
};

export type SessionsTable = {
  token_hash: Buffer;
  tenant_id: string;
  user_id: string;
  expires_at: Instant;
  created_at: CreatedAt;
};

export type ResourcesTable = {
  id: string;
  tenant_id: string;
  kind: ResourceKind;
  name: string;
  description: ColumnType<string, string | undefined, string>;
  /** null = inherit the tenant's zone. Not exposed in the v1 UI (Assumption 9). */
  timezone: string | null;
  user_id: string | null;
  capacity: number | null;
  min_minutes: ColumnType<number, number | undefined, number>;
  max_minutes: ColumnType<number, number | undefined, number>;
  is_active: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: CreatedAt;
  updated_at: CreatedAt;
};

export type AvailabilityRulesTable = {
  id: string;
  tenant_id: string;
  resource_id: string;
  /** ISO-8601 weekday: 1 = Monday … 7 = Sunday, matching Luxon. */
  weekday: number;
  start_minute: number;
  end_minute: number;
};

export type AvailabilityExceptionsTable = {
  id: string;
  tenant_id: string;
  resource_id: string;
  /** A calendar date in the resource's zone. Deliberately a date: a holiday has no timezone. */
  local_date: ColumnType<string, string, string>;
  is_available: boolean;
  start_minute: number | null;
  end_minute: number | null;
  reason: ColumnType<string, string | undefined, string>;
  created_at: CreatedAt;
};

export type BookingsTable = {
  id: string;
  tenant_id: string;
  resource_id: string;
  created_by_user_id: string;
  title: string;
  notes: ColumnType<string, string | undefined, string>;
  starts_at: Instant;
  ends_at: Instant;
  /** GENERATED ALWAYS — readable, never written. Backs `bookings_no_overlap`. */
  period: ColumnType<string, never, never>;
  status: ColumnType<BookingStatus, BookingStatus | undefined, BookingStatus>;
  version: ColumnType<number, number | undefined, number>;
  idempotency_key: string | null;
  cancelled_at: Date | null;
  cancelled_by_user_id: string | null;
  created_at: CreatedAt;
  updated_at: CreatedAt;
};

export type BookingEventsTable = {
  id: Generated<string>;
  tenant_id: string;
  booking_id: string;
  resource_id: string;
  type: BookingEventType;
  actor_user_id: string | null;
  payload: ColumnType<unknown, string, string>;
  created_at: CreatedAt;
};

export type Database = {
  tenants: TenantsTable;
  users: UsersTable;
  sessions: SessionsTable;
  resources: ResourcesTable;
  availability_rules: AvailabilityRulesTable;
  availability_exceptions: AvailabilityExceptionsTable;
  bookings: BookingsTable;
  booking_events: BookingEventsTable;
};

export type TenantRow = Selectable<TenantsTable>;
export type UserRow = Selectable<UsersTable>;
export type ResourceRow = Selectable<ResourcesTable>;
export type BookingRow = Selectable<BookingsTable>;
export type NewBooking = Insertable<BookingsTable>;
export type BookingUpdate = Updateable<BookingsTable>;
export type NewResource = Insertable<ResourcesTable>;
export type NewUser = Insertable<UsersTable>;
