import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import type { ResourceDto } from '@slotline/shared';

export type ViewMode = 'week' | 'day';

export function CalendarToolbar({
  mode,
  onModeChange,
  resources,
  activeResource,
  onResourceChange,
  timezone,
}: {
  mode: ViewMode;
  onModeChange: (mode: ViewMode) => void;
  resources: ResourceDto[];
  activeResource: ResourceDto | null;
  onResourceChange: (resourceId: string) => void;
  timezone: string;
}): ReactElement {
  return (
    <div className="calendar-page__bar">
      <div className="calendar-page__modes" role="group" aria-label="View">
        <button
          type="button"
          className={mode === 'week' ? '' : 'button--quiet'}
          aria-pressed={mode === 'week'}
          onClick={() => {
            onModeChange('week');
          }}
        >
          One resource, a week
        </button>
        <button
          type="button"
          className={mode === 'day' ? '' : 'button--quiet'}
          aria-pressed={mode === 'day'}
          onClick={() => {
            onModeChange('day');
          }}
        >
          All resources, a day
        </button>
      </div>

      {mode === 'week' && (
        <>
          <label className="field field--inline">
            <span>Resource</span>
            <select
              value={activeResource?.id ?? ''}
              onChange={(event) => {
                onResourceChange(event.target.value);
              }}
            >
              {resources.map((resource) => (
                <option key={resource.id} value={resource.id}>
                  {resource.name} &middot; {resource.kind}
                </option>
              ))}
            </select>
          </label>

          {activeResource && (
            <Link
              to={`/resources/${activeResource.id}/availability`}
              className="calendar-page__link"
            >
              Opening hours
            </Link>
          )}

          <p className="calendar-page__legend">
            <span className="calendar-page__swatch" aria-hidden="true" />
            Outside opening hours
          </p>
        </>
      )}

      {/* The day view spans resources with different hours, so it shades none of them —
          see the note in AllResourcesDayGrid. Saying so beats an unexplained difference. */}
      {mode === 'day' && (
        <p className="calendar-page__legend">Opening hours are shaded in the week view.</p>
      )}

      <p className="calendar-page__zone">Times shown in {timezone}</p>
    </div>
  );
}
