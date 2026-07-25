import { useEffect, useState, type ReactElement } from 'react';
import {
  type AvailabilityRuleDto,
  type BookingDto,
  type ResourceAvailabilityDto,
  WEEKDAY_NAMES,
} from '@slotline/shared';
import { ApiError } from '../../lib/api-client';
import { clockToMinutes, minutesToClock, useReplaceRules } from './useAvailability';

/** One editable row per weekday. Closed days carry no window. */
type DayDraft = {
  weekday: number;
  open: boolean;
  from: string;
  to: string;
};

const DEFAULT_DAY: Omit<DayDraft, 'weekday'> = { open: false, from: '09:00', to: '17:00' };

function toDrafts(rules: readonly AvailabilityRuleDto[]): DayDraft[] {
  return WEEKDAY_NAMES.map((_name, index) => {
    const weekday = index + 1;
    // The editor models one window per day. A day carrying several (a lunch break, set
    // through the API) collapses to its outer bounds here, and saving would widen it —
    // so the caller warns before letting that happen.
    const forDay = rules.filter((rule) => rule.weekday === weekday);
    if (forDay.length === 0) return { weekday, ...DEFAULT_DAY };
    const from = Math.min(...forDay.map((rule) => rule.startMinute));
    const to = Math.max(...forDay.map((rule) => rule.endMinute));
    return { weekday, open: true, from: minutesToClock(from), to: minutesToClock(to) };
  });
}

const hasSplitDay = (rules: readonly AvailabilityRuleDto[]): boolean =>
  WEEKDAY_NAMES.some(
    (_name, index) => rules.filter((rule) => rule.weekday === index + 1).length > 1,
  );

export function AvailabilityEditor({
  resourceId,
  availability,
  onSaved,
  onError,
}: {
  resourceId: string;
  availability: ResourceAvailabilityDto;
  onSaved: (conflicting: BookingDto[]) => void;
  onError: (message: string) => void;
}): ReactElement {
  const [drafts, setDrafts] = useState<DayDraft[]>(() => toDrafts(availability.rules));
  const replaceRules = useReplaceRules(resourceId);

  useEffect(() => {
    setDrafts(toDrafts(availability.rules));
  }, [availability.rules]);

  const update = (weekday: number, patch: Partial<DayDraft>): void => {
    setDrafts((current) =>
      current.map((draft) => (draft.weekday === weekday ? { ...draft, ...patch } : draft)),
    );
  };

  const save = (): void => {
    const rules: AvailabilityRuleDto[] = [];
    for (const draft of drafts) {
      if (!draft.open) continue;
      const startMinute = clockToMinutes(draft.from);
      const endMinute = clockToMinutes(draft.to);
      if (startMinute === null || endMinute === null || startMinute >= endMinute) {
        onError(`${WEEKDAY_NAMES[draft.weekday - 1] ?? 'That day'} has an invalid window.`);
        return;
      }
      rules.push({ weekday: draft.weekday, startMinute, endMinute });
    }

    replaceRules.mutate(rules, {
      onSuccess: (response) => {
        onSaved(response.conflictingBookings);
      },
      onError: (error) => {
        onError(error instanceof ApiError ? error.message : 'Could not save opening hours.');
      },
    });
  };

  return (
    <section className="availability">
      <h2>Opening hours</h2>
      <p className="availability__hint">
        {availability.rules.length === 0
          ? 'No hours set, so this resource is bookable around the clock.'
          : `Times are wall-clock in ${availability.timezone}, on every week including the ones where the clocks change.`}
      </p>

      {hasSplitDay(availability.rules) && (
        <p className="field__error">
          A day here has more than one window (for example a lunch break). This editor shows one
          window per day, so saving would merge them. Use the API to keep the split.
        </p>
      )}

      <ul className="availability__days">
        {drafts.map((draft) => (
          <li key={draft.weekday} className="availability__day">
            <label className="availability__toggle">
              <input
                type="checkbox"
                checked={draft.open}
                onChange={(event) => {
                  update(draft.weekday, { open: event.target.checked });
                }}
              />
              <span>{WEEKDAY_NAMES[draft.weekday - 1]}</span>
            </label>

            <input
              type="time"
              value={draft.from}
              disabled={!draft.open}
              onChange={(event) => {
                update(draft.weekday, { from: event.target.value });
              }}
              aria-label={`${WEEKDAY_NAMES[draft.weekday - 1] ?? ''} opens`}
            />
            <span className="availability__dash">to</span>
            <input
              type="time"
              value={draft.to}
              disabled={!draft.open}
              onChange={(event) => {
                update(draft.weekday, { to: event.target.value });
              }}
              aria-label={`${WEEKDAY_NAMES[draft.weekday - 1] ?? ''} closes`}
            />
          </li>
        ))}
      </ul>

      <button type="button" onClick={save} disabled={replaceRules.isPending}>
        {replaceRules.isPending ? 'Saving...' : 'Save opening hours'}
      </button>
    </section>
  );
}
