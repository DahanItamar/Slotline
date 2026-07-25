import { DateTime } from 'luxon';
import { useMemo, useState, type ReactElement } from 'react';
import {
  MAX_NOTES_LENGTH,
  MAX_TITLE_LENGTH,
  windowsForLocalDate,
  type CreateBookingRequest,
  type ResourceAvailabilityDto,
  type ResourceDto,
} from '@slotline/shared';
import { Modal } from '../../components/Modal';
import { describeApiError } from '../../lib/describe-error';

/**
 * Creating a booking, with the duration actually choosable.
 *
 * The grid's 15-minute cells are a drawing resolution, not a booking rule — the real
 * limits are the resource's own `minMinutes`/`maxMinutes`, so the presets below are
 * filtered to them. Picking a start and a length instead of two times means an invalid
 * range cannot be expressed at all, rather than being expressible and then rejected.
 */

const PRESET_MINUTES = [15, 30, 45, 60, 90, 120, 180, 240, 480];

const describeDuration = (minutes: number): string => {
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours} hr` : `${Math.floor(hours)} hr ${minutes % 60} min`;
};

const clockOf = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

export function BookingDialog({
  resource,
  availability,
  timezone,
  initialStart,
  initialMinutes,
  pending,
  error,
  onSubmit,
  onClose,
}: {
  resource: ResourceDto;
  availability: ResourceAvailabilityDto | undefined;
  timezone: string;
  initialStart: Date;
  initialMinutes: number;
  pending: boolean;
  error: unknown;
  onSubmit: (request: CreateBookingRequest) => void;
  onClose: () => void;
}): ReactElement {
  const start = DateTime.fromJSDate(initialStart).setZone(timezone);

  const [date, setDate] = useState(start.toISODate() ?? '');
  const [time, setTime] = useState(start.toFormat('HH:mm'));
  const [minutes, setMinutes] = useState(() =>
    Math.min(Math.max(initialMinutes, resource.minMinutes), resource.maxMinutes),
  );
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');

  const durations = useMemo(() => {
    const allowed = PRESET_MINUTES.filter(
      (value) => value >= resource.minMinutes && value <= resource.maxMinutes,
    );
    // Always offer the exact bounds, so a resource with unusual limits is still bookable
    // at both ends without arithmetic in the user's head.
    for (const bound of [resource.minMinutes, resource.maxMinutes]) {
      if (!allowed.includes(bound)) allowed.push(bound);
    }
    return [...new Set(allowed)].sort((a, b) => a - b);
  }, [resource.minMinutes, resource.maxMinutes]);

  const startsAt = DateTime.fromISO(`${date}T${time}`, { zone: timezone });
  const endsAt = startsAt.plus({ minutes });
  const isValid = startsAt.isValid && title.trim().length > 0;

  const openWindows = availability
    ? windowsForLocalDate(
        date,
        startsAt.isValid ? startsAt.weekday : 1,
        availability.rules,
        availability.exceptions,
      )
    : [];

  return (
    <Modal title={`Book ${resource.name}`} onClose={onClose}>
      <form
        className="modal__body"
        onSubmit={(event) => {
          event.preventDefault();
          // Narrowing on `isValid` here rather than on the combined `isValid` const is
          // what lets Luxon type `toISO()` as a plain string instead of `string | null`.
          if (!startsAt.isValid || title.trim().length === 0) return;
          onSubmit({
            resourceId: resource.id,
            startsAt: startsAt.toUTC().toISO(),
            endsAt: startsAt.plus({ minutes }).toUTC().toISO(),
            title: title.trim(),
            notes: notes.trim(),
          });
        }}
      >
        <div className="modal__row">
          <label className="field">
            <span>Date</span>
            <input
              type="date"
              value={date}
              onChange={(event) => {
                setDate(event.target.value);
              }}
              required
            />
          </label>

          <label className="field">
            <span>Start</span>
            <input
              type="time"
              value={time}
              step={900}
              onChange={(event) => {
                setTime(event.target.value);
              }}
              required
            />
          </label>

          <label className="field">
            <span>Length</span>
            <select
              value={minutes}
              onChange={(event) => {
                setMinutes(Number(event.target.value));
              }}
            >
              {durations.map((value) => (
                <option key={value} value={value}>
                  {describeDuration(value)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <p className="modal__summary">
          {startsAt.isValid ? (
            <>
              <strong>
                {startsAt.toFormat('cccc d LLLL')}, {startsAt.toFormat('HH:mm')} –{' '}
                {endsAt.toFormat('HH:mm')}
              </strong>
              <span className="modal__zone"> ({timezone})</span>
            </>
          ) : (
            'Pick a date and a start time.'
          )}
        </p>

        {/* Shown up front rather than discovered by being refused. */}
        {availability && (
          <p className="modal__hours">
            {openWindows.length === 0
              ? 'Closed all day — this booking will be refused.'
              : `Open ${openWindows
                  .map((window) => `${clockOf(window.startMinute)}–${clockOf(window.endMinute)}`)
                  .join(', ')}`}
          </p>
        )}

        <label className="field">
          <span>What is it for?</span>
          <input
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
            }}
            maxLength={MAX_TITLE_LENGTH}
            placeholder="Design review"
            required
          />
        </label>

        <label className="field">
          <span>Notes (optional)</span>
          <textarea
            value={notes}
            onChange={(event) => {
              setNotes(event.target.value);
            }}
            maxLength={MAX_NOTES_LENGTH}
            rows={2}
          />
        </label>

        {/* The form stays open and keeps what was typed, so a lost race costs one edit. */}
        {error != null && <p className="field__error">{describeApiError(error)}</p>}

        <div className="modal__actions">
          <button type="button" className="button--quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={pending || !isValid}>
            {pending ? 'Booking…' : 'Book it'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
