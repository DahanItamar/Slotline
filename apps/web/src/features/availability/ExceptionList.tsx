import { useState, type ReactElement } from 'react';
import type { AvailabilityExceptionDto } from '@slotline/shared';
import { ApiError } from '../../lib/api-client';
import {
  clockToMinutes,
  minutesToClock,
  useCreateException,
  useDeleteException,
} from './useAvailability';

type Draft = {
  localDate: string;
  mode: 'closed' | 'open';
  from: string;
  to: string;
  reason: string;
};

const EMPTY: Draft = { localDate: '', mode: 'closed', from: '10:00', to: '14:00', reason: '' };

function describe(exception: AvailabilityExceptionDto): string {
  if (!exception.isAvailable) return 'Closed all day';
  if (exception.startMinute === null || exception.endMinute === null) return 'Closed all day';
  return `Open ${minutesToClock(exception.startMinute)} to ${minutesToClock(exception.endMinute)} only`;
}

export function ExceptionList({
  resourceId,
  exceptions,
  canManage,
  onError,
}: {
  resourceId: string;
  exceptions: AvailabilityExceptionDto[];
  canManage: boolean;
  onError: (message: string) => void;
}): ReactElement {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const createException = useCreateException(resourceId);
  const deleteException = useDeleteException(resourceId);

  const submit = (): void => {
    if (!draft.localDate) {
      onError('Pick a date for the override.');
      return;
    }

    const isAvailable = draft.mode === 'open';
    const startMinute = isAvailable ? clockToMinutes(draft.from) : null;
    const endMinute = isAvailable ? clockToMinutes(draft.to) : null;

    if (isAvailable && (startMinute === null || endMinute === null || startMinute >= endMinute)) {
      onError('That one-off window is not valid.');
      return;
    }

    createException.mutate(
      { localDate: draft.localDate, isAvailable, startMinute, endMinute, reason: draft.reason },
      {
        onSuccess: () => {
          setDraft(EMPTY);
        },
        onError: (error) => {
          onError(error instanceof ApiError ? error.message : 'Could not save that override.');
        },
      },
    );
  };

  return (
    <section className="availability">
      <h2>Date overrides</h2>
      <p className="availability__hint">
        A holiday, a maintenance day, or a one-off opening. An override replaces the weekly hours
        for that date entirely.
      </p>

      {canManage && (
        <div className="exception-form">
          <label className="field field--inline">
            <span>Date</span>
            <input
              type="date"
              value={draft.localDate}
              onChange={(event) => {
                setDraft({ ...draft, localDate: event.target.value });
              }}
            />
          </label>

          <label className="field field--inline">
            <span>Effect</span>
            <select
              value={draft.mode}
              onChange={(event) => {
                setDraft({ ...draft, mode: event.target.value === 'open' ? 'open' : 'closed' });
              }}
            >
              <option value="closed">Closed all day</option>
              <option value="open">Open only in a window</option>
            </select>
          </label>

          {draft.mode === 'open' && (
            <>
              <input
                type="time"
                value={draft.from}
                onChange={(event) => {
                  setDraft({ ...draft, from: event.target.value });
                }}
                aria-label="Override opens"
              />
              <input
                type="time"
                value={draft.to}
                onChange={(event) => {
                  setDraft({ ...draft, to: event.target.value });
                }}
                aria-label="Override closes"
              />
            </>
          )}

          <label className="field field--inline">
            <span>Reason</span>
            <input
              value={draft.reason}
              onChange={(event) => {
                setDraft({ ...draft, reason: event.target.value });
              }}
              placeholder="Public holiday"
            />
          </label>

          <button type="button" onClick={submit} disabled={createException.isPending}>
            Add override
          </button>
        </div>
      )}

      {exceptions.length === 0 ? (
        <p className="availability__hint">No overrides. The weekly hours apply every week.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Effect</th>
              <th scope="col">Reason</th>
              {canManage && <th scope="col">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {exceptions.map((exception) => (
              <tr key={exception.id}>
                <td>{exception.localDate}</td>
                <td>{describe(exception)}</td>
                <td>{exception.reason || '—'}</td>
                {canManage && (
                  <td>
                    <button
                      type="button"
                      className="button--quiet"
                      onClick={() => {
                        deleteException.mutate(exception.id);
                      }}
                    >
                      Remove
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
