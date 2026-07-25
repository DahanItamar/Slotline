import {
  containsWindow,
  MINUTES_IN_DAY,
  windowsForLocalDate,
  type BookingDto,
  type ResourceAvailabilityDto,
  type ResourceDto,
} from '@slotline/shared';
import { DateTime } from 'luxon';
import { useCallback, useMemo, type ReactElement } from 'react';
import { Calendar, luxonLocalizer, type SlotInfo, Views } from 'react-big-calendar';
import withDragAndDrop from 'react-big-calendar/lib/addons/dragAndDrop';
import { isPending } from './useBookings';

const localizer = luxonLocalizer(DateTime, { firstDayOfWeek: 1 });

/** The grid's slot height. Also the smallest window it can shade honestly. */
const SLOT_MINUTES = 15;

export type CalendarEvent = {
  id: string;
  title: string;
  start: Date;
  end: Date;
  pending: boolean;
  booking: BookingDto;
};

const DragAndDropCalendar = withDragAndDrop<CalendarEvent>(Calendar);

export function ResourceWeekGrid({
  resource,
  availability,
  bookings,
  anchorDate,
  onNavigate,
  onSelectSlot,
  onSelectBooking,
  onMoveBooking,
}: {
  resource: ResourceDto;
  availability: ResourceAvailabilityDto | undefined;
  bookings: BookingDto[];
  anchorDate: Date;
  onNavigate: (date: Date) => void;
  onSelectSlot: (slot: { start: Date; end: Date }) => void;
  onSelectBooking: (booking: BookingDto) => void;
  onMoveBooking: (booking: BookingDto, start: Date, end: Date) => void;
}): ReactElement {
  const events = useMemo<CalendarEvent[]>(
    () =>
      bookings.map((booking) => ({
        id: booking.id,
        title: `${booking.title} · ${booking.createdByDisplayName}`,
        start: new Date(booking.startsAt),
        end: new Date(booking.endsAt),
        pending: isPending(booking),
        booking,
      })),
    [bookings],
  );

  /**
   * Shading uses the same `windowsForLocalDate` the server enforces with, so a slot is
   * greyed out exactly when a booking there would be refused. Two implementations of
   * this rule would drift, and the user would meet the difference as a rejection on a
   * slot that looked open.
   */
  const isSlotOpen = useCallback(
    (slotStart: Date): boolean => {
      if (!availability) return true;
      const local = DateTime.fromJSDate(slotStart).setZone(availability.timezone);
      const open = windowsForLocalDate(
        local.toISODate() ?? '',
        local.weekday,
        availability.rules,
        availability.exceptions,
      );
      const startMinute = local.hour * 60 + local.minute;
      return containsWindow(
        open,
        startMinute,
        Math.min(startMinute + SLOT_MINUTES, MINUTES_IN_DAY),
      );
    },
    [availability],
  );

  return (
    <div className="calendar" role="group" aria-label={`${resource.name} week view`}>
      <DragAndDropCalendar
        localizer={localizer}
        events={events}
        date={anchorDate}
        onNavigate={onNavigate}
        defaultView={Views.WEEK}
        views={[Views.WEEK, Views.DAY]}
        step={SLOT_MINUTES}
        timeslots={4}
        selectable
        onSelectSlot={(slot: SlotInfo) => {
          onSelectSlot({ start: slot.start, end: slot.end });
        }}
        onSelectEvent={(event) => {
          onSelectBooking(event.booking);
        }}
        // A pending block has no server-side identity yet, so there is nothing to move.
        draggableAccessor={(event) => !event.pending}
        resizable
        onEventDrop={({ event, start, end }) => {
          onMoveBooking(event.booking, new Date(start), new Date(end));
        }}
        onEventResize={({ event, start, end }) => {
          onMoveBooking(event.booking, new Date(start), new Date(end));
        }}
        slotPropGetter={(date: Date) => (isSlotOpen(date) ? {} : { className: 'rbc-slot--closed' })}
        eventPropGetter={(event) => ({
          className: event.pending ? 'rbc-event--pending' : '',
        })}
        style={{ height: '100%' }}
      />
    </div>
  );
}
