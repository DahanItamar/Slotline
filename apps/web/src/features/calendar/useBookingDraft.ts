import { useState } from 'react';
import type { ResourceDto } from '@slotline/shared';
import { useCreateBooking, type BookingRange } from './useBookings';

/**
 * The state behind the booking dialog.
 *
 * A grid selection opens a draft rather than booking outright: a click on the calendar
 * covers one 15-minute cell, which is the grid's drawing resolution and a poor guess at
 * how long anyone wants a room for. The dialog is where the length is actually chosen,
 * and the dragged range is only its starting point.
 */
export type BookingDraft = {
  resource: ResourceDto;
  start: Date;
  minutes: number;
};

export type GridSelection = {
  start: Date;
  end: Date;
  resourceId?: string;
};

export function useBookingDraft(
  range: BookingRange,
  cacheResourceId: string | null,
  resources: readonly ResourceDto[],
  fallbackResourceId: string | null,
) {
  const [draft, setDraft] = useState<BookingDraft | null>(null);
  const createBooking = useCreateBooking(range, cacheResourceId);

  const openFromSelection = (selection: GridSelection): void => {
    const resourceId = selection.resourceId ?? fallbackResourceId;
    const resource = resources.find((candidate) => candidate.id === resourceId);
    if (!resource) return;

    // A previous failure must not greet the next attempt.
    createBooking.reset();
    setDraft({
      resource,
      start: selection.start,
      minutes: Math.max(
        Math.round((selection.end.getTime() - selection.start.getTime()) / 60_000),
        resource.minMinutes,
      ),
    });
  };

  const close = (): void => {
    setDraft(null);
    createBooking.reset();
  };

  return { draft, openFromSelection, close, createBooking };
}
