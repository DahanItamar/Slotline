import { DateTime } from 'luxon';
import { useState, type ReactElement } from 'react';
import type { BookingDto, SessionDto } from '@slotline/shared';
import { describeApiError } from '../../lib/describe-error';
import { canModify, useCancelBooking, useRescheduleBooking } from './useBookingMutations';

/**
 * The panel behind clicking a booking. Cancel lives here rather than on the grid so a
 * destructive action always takes two deliberate steps.
 */
export function BookingDetail({
  booking,
  session,
  timezone,
  onClose,
  onError,
}: {
  booking: BookingDto;
  session: SessionDto;
  timezone: string;
  onClose: () => void;
  onError: (message: string) => void;
}): ReactElement {
  const [confirming, setConfirming] = useState(false);
  const [title, setTitle] = useState(booking.title);
  const cancelBooking = useCancelBooking();
  const rescheduleBooking = useRescheduleBooking();

  const mine = canModify(booking, session.user);
  const at = (iso: string): string =>
    DateTime.fromISO(iso).setZone(timezone).toFormat('ccc d LLL, HH:mm');

  const fail = (error: unknown): void => {
    onError(describeApiError(error));
  };

  return (
    <aside className="detail" role="dialog" aria-label="Booking details">
      <header className="detail__head">
        <h2>{booking.title}</h2>
        <button type="button" className="detail__close" onClick={onClose} aria-label="Close">
          &times;
        </button>
      </header>

      <dl className="detail__facts">
        <dt>When</dt>
        <dd>
          {at(booking.startsAt)} to{' '}
          {DateTime.fromISO(booking.endsAt).setZone(timezone).toFormat('HH:mm')}
        </dd>
        <dt>Booked by</dt>
        <dd>{booking.createdByDisplayName}</dd>
      </dl>

      {booking.notes && <p className="detail__notes">{booking.notes}</p>}

      {!mine && (
        <p className="availability__hint">Only its owner or an administrator can change this.</p>
      )}

      {mine && (
        <>
          <label className="field">
            <span>Title</span>
            <input
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
              }}
              maxLength={200}
            />
          </label>

          <div className="detail__actions">
            <button
              type="button"
              disabled={rescheduleBooking.isPending || title === booking.title}
              onClick={() => {
                rescheduleBooking.mutate({ booking, title }, { onSuccess: onClose, onError: fail });
              }}
            >
              Save title
            </button>

            {confirming ? (
              <button
                type="button"
                className="button--danger"
                disabled={cancelBooking.isPending}
                onClick={() => {
                  cancelBooking.mutate(booking, { onSuccess: onClose, onError: fail });
                }}
              >
                {cancelBooking.isPending ? 'Cancelling...' : 'Yes, cancel it'}
              </button>
            ) : (
              <button
                type="button"
                className="button--quiet"
                onClick={() => {
                  setConfirming(true);
                }}
              >
                Cancel booking
              </button>
            )}
          </div>

          <p className="availability__hint">
            Drag the block on the grid to move it. The slot frees the moment it is cancelled.
          </p>
        </>
      )}
    </aside>
  );
}
