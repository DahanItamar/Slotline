import type { BookingDto, ResourceDto } from '@slotline/shared';
import { DateTime } from 'luxon';
import { useMemo, type ReactElement } from 'react';
import { Calendar, luxonLocalizer, type SlotInfo, Views } from 'react-big-calendar';
import { isPending } from './useBookings';

const localizer = luxonLocalizer(DateTime, { firstDayOfWeek: 1 });

/**
 * One day, every resource side by side — the view for "what is free right now".
 *
 * Deliberately does not shade opening hours: the shading hook receives a slot's time but
 * not which resource column it belongs to, and each column has its own hours. Showing one
 * resource's closures across all of them would be worse than showing none. The server
 * still refuses anything outside a resource's hours, so the only cost is that a refusal
 * here is a surprise rather than a prediction. Fixing it properly means a custom column
 * renderer; see the week view for the shaded single-resource grid.
 */
type DayEvent = {
  id: string;
  title: string;
  start: Date;
  end: Date;
  resourceId: string;
  pending: boolean;
  booking: BookingDto;
};

export function AllResourcesDayGrid({
  resources,
  bookings,
  anchorDate,
  onNavigate,
  onSelectSlot,
  onSelectBooking,
}: {
  resources: ResourceDto[];
  bookings: BookingDto[];
  anchorDate: Date;
  onNavigate: (date: Date) => void;
  onSelectSlot: (slot: { start: Date; end: Date; resourceId: string }) => void;
  onSelectBooking: (booking: BookingDto) => void;
}): ReactElement {
  const events = useMemo<DayEvent[]>(
    () =>
      bookings.map((booking) => ({
        id: booking.id,
        title: `${booking.title} · ${booking.createdByDisplayName}`,
        start: new Date(booking.startsAt),
        end: new Date(booking.endsAt),
        resourceId: booking.resourceId,
        pending: isPending(booking),
        booking,
      })),
    [bookings],
  );

  const columns = useMemo(
    () => resources.map((resource) => ({ id: resource.id, title: resource.name })),
    [resources],
  );

  return (
    <div className="calendar" role="group" aria-label="All resources, one day">
      <Calendar<DayEvent, { id: string; title: string }>
        localizer={localizer}
        events={events}
        date={anchorDate}
        onNavigate={onNavigate}
        defaultView={Views.DAY}
        views={[Views.DAY]}
        step={15}
        timeslots={4}
        resources={columns}
        resourceIdAccessor="id"
        resourceTitleAccessor="title"
        selectable
        onSelectSlot={(slot: SlotInfo) => {
          const resourceId = typeof slot.resourceId === 'string' ? slot.resourceId : columns[0]?.id;
          if (resourceId) onSelectSlot({ start: slot.start, end: slot.end, resourceId });
        }}
        onSelectEvent={(event) => {
          onSelectBooking(event.booking);
        }}
        eventPropGetter={(event) => ({
          className: event.pending ? 'rbc-event--pending' : '',
        })}
        style={{ height: '100%' }}
      />
    </div>
  );
}
