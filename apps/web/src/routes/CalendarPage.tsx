import { useQuery } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useMemo, useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import type { BookingDto, ResourceDto, SessionDto } from '@slotline/shared';
import { Toast, type ToastMessage } from '../components/Toast';
import { useAvailability } from '../features/availability/useAvailability';
import { AllResourcesDayGrid } from '../features/calendar/AllResourcesDayGrid';
import { BookingDetail } from '../features/calendar/BookingDetail';
import { BookingDialog } from '../features/calendar/BookingDialog';
import { CalendarToolbar, type ViewMode } from '../features/calendar/CalendarToolbar';
import { ResourceWeekGrid } from '../features/calendar/ResourceWeekGrid';
import { useRescheduleBooking } from '../features/calendar/useBookingMutations';
import { useBookingDraft } from '../features/calendar/useBookingDraft';
import { ALL_RESOURCES, useBookings } from '../features/calendar/useBookings';
import { api } from '../lib/api-client';
import { describeApiError } from '../lib/describe-error';

function rangeFor(anchor: Date, mode: ViewMode): { from: string; to: string } {
  const unit = mode === 'week' ? 'week' : 'day';
  const start = DateTime.fromJSDate(anchor).startOf(unit);
  const end = mode === 'week' ? start.plus({ weeks: 1 }) : start.plus({ days: 1 });
  return { from: start.toUTC().toISO() ?? '', to: end.toUTC().toISO() ?? '' };
}

/** The screen a brand-new workspace actually opens on, so it is worth writing properly. */
function NoResourcesYet({ canManage }: { canManage: boolean }): ReactElement {
  return (
    <div className="page__empty">
      <h2>No resources yet</h2>
      {canManage ? (
        <p>
          Rooms, equipment and consultants live in <Link to="/resources">Resources</Link>. Add the
          first one and it will appear here.
        </p>
      ) : (
        <p>Nothing is bookable yet. Ask an administrator to add a room or a piece of equipment.</p>
      )}
    </div>
  );
}

export function CalendarPage({ session }: { session: SessionDto }): ReactElement {
  const [anchorDate, setAnchorDate] = useState(() => new Date());
  const [mode, setMode] = useState<ViewMode>('week');
  const [selectedResourceId, setSelectedResourceId] = useState<string | null>(null);
  const [openBooking, setOpenBooking] = useState<BookingDto | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const resourcesQuery = useQuery({
    queryKey: ['resources'],
    queryFn: async () => (await api<{ resources: ResourceDto[] }>('/api/resources')).resources,
  });

  const resources = useMemo(() => resourcesQuery.data ?? [], [resourcesQuery.data]);
  const activeResourceId = selectedResourceId ?? resources[0]?.id ?? null;
  const activeResource = resources.find((resource) => resource.id === activeResourceId) ?? null;

  const range = useMemo(() => rangeFor(anchorDate, mode), [anchorDate, mode]);
  const cacheResourceId = mode === 'day' ? ALL_RESOURCES : activeResourceId;
  const bookingsQuery = useBookings(range, cacheResourceId);
  const availabilityQuery = useAvailability(mode === 'week' ? activeResourceId : null);
  const rescheduleBooking = useRescheduleBooking();
  const {
    draft,
    openFromSelection,
    close: closeDraft,
    createBooking,
  } = useBookingDraft(range, cacheResourceId, resources, activeResourceId);

  const showToast = (tone: ToastMessage['tone'], text: string): void => {
    setToast({ id: Date.now(), tone, text });
  };

  const handleMove = (booking: BookingDto, start: Date, end: Date): void => {
    rescheduleBooking.mutate(
      { booking, startsAt: start.toISOString(), endsAt: end.toISOString() },
      {
        onSuccess: () => {
          showToast('success', 'Moved.');
        },
        onError: (error) => {
          showToast('error', describeApiError(error));
        },
      },
    );
  };

  if (resourcesQuery.isLoading) return <p className="page__empty">Loading&hellip;</p>;
  if (resources.length === 0) {
    return <NoResourcesYet canManage={session.user.role !== 'member'} />;
  }

  return (
    <div className="calendar-page">
      <CalendarToolbar
        mode={mode}
        onModeChange={setMode}
        resources={resources}
        activeResource={activeResource}
        onResourceChange={setSelectedResourceId}
        timezone={session.tenant.timezone}
      />

      <div className="calendar-page__body">
        {mode === 'week' && activeResource && (
          <ResourceWeekGrid
            resource={activeResource}
            availability={availabilityQuery.data}
            bookings={bookingsQuery.data ?? []}
            anchorDate={anchorDate}
            onNavigate={setAnchorDate}
            onSelectSlot={openFromSelection}
            onSelectBooking={setOpenBooking}
            onMoveBooking={handleMove}
          />
        )}

        {mode === 'day' && (
          <AllResourcesDayGrid
            resources={resources}
            bookings={bookingsQuery.data ?? []}
            anchorDate={anchorDate}
            onNavigate={setAnchorDate}
            onSelectSlot={openFromSelection}
            onSelectBooking={setOpenBooking}
          />
        )}

        {draft && (
          <BookingDialog
            resource={draft.resource}
            availability={availabilityQuery.data}
            timezone={session.tenant.timezone}
            initialStart={draft.start}
            initialMinutes={draft.minutes}
            pending={createBooking.isPending}
            error={createBooking.error}
            onClose={closeDraft}
            onSubmit={(request) => {
              createBooking.mutate(request, {
                onSuccess: () => {
                  closeDraft();
                  showToast('success', 'Booked.');
                },
                // No toast on failure: the dialog stays open and shows it inline, beside
                // the fields that produced it and with the typing still there.
              });
            }}
          />
        )}

        {openBooking && (
          <BookingDetail
            booking={openBooking}
            session={session}
            timezone={session.tenant.timezone}
            onClose={() => {
              setOpenBooking(null);
            }}
            onError={(message) => {
              showToast('error', message);
            }}
          />
        )}
      </div>

      {toast && (
        <Toast
          message={toast}
          onDismiss={() => {
            setToast(null);
          }}
        />
      )}
    </div>
  );
}
