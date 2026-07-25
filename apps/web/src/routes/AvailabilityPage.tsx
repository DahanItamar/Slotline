import { useQuery } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useState, type ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { BookingDto, ResourceDto, SessionDto } from '@slotline/shared';
import { Toast, type ToastMessage } from '../components/Toast';
import { AvailabilityEditor } from '../features/availability/AvailabilityEditor';
import { ExceptionList } from '../features/availability/ExceptionList';
import { useAvailability } from '../features/availability/useAvailability';
import { api } from '../lib/api-client';

export function AvailabilityPage({ session }: { session: SessionDto }): ReactElement {
  const { resourceId = '' } = useParams();
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [orphaned, setOrphaned] = useState<BookingDto[]>([]);

  const canManage = session.user.role !== 'member';

  const resourceQuery = useQuery({
    queryKey: ['resource', resourceId],
    queryFn: () => api<ResourceDto>(`/api/resources/${resourceId}`),
  });
  const availabilityQuery = useAvailability(resourceId);

  const showError = (text: string): void => {
    setToast({ id: Date.now(), tone: 'error', text });
  };

  if (resourceQuery.isLoading || availabilityQuery.isLoading) {
    return <p className="page__empty">Loading&hellip;</p>;
  }

  const resource = resourceQuery.data;
  const availability = availabilityQuery.data;
  if (!resource || !availability) {
    return <p className="page__empty">That resource could not be loaded.</p>;
  }

  return (
    <div className="page">
      <p className="page__breadcrumb">
        <Link to="/resources">Resources</Link> / {resource.name}
      </p>
      <h1>{resource.name} availability</h1>

      {canManage ? (
        <AvailabilityEditor
          resourceId={resourceId}
          availability={availability}
          onSaved={(conflicting) => {
            setOrphaned(conflicting);
            setToast({ id: Date.now(), tone: 'success', text: 'Opening hours saved.' });
          }}
          onError={showError}
        />
      ) : (
        <p className="availability__hint">Only an administrator can change these.</p>
      )}

      {/*
        Existing bookings are never cancelled by an hours change. Showing them is the
        honest middle ground: the admin sees what the new hours cannot honour and
        decides. SPEC Open Question 3.
      */}
      {orphaned.length > 0 && (
        <section className="availability availability--warning">
          <h2>{orphaned.length} booking(s) now fall outside these hours</h2>
          <p className="availability__hint">
            They have been kept, not cancelled. Cancel them by hand if that is what you want.
          </p>
          <ul>
            {orphaned.map((booking) => (
              <li key={booking.id}>
                {DateTime.fromISO(booking.startsAt).toFormat('ccc d LLL HH:mm')} to{' '}
                {DateTime.fromISO(booking.endsAt).toFormat('HH:mm')} &middot; {booking.title} (
                {booking.createdByDisplayName})
              </li>
            ))}
          </ul>
        </section>
      )}

      <ExceptionList
        resourceId={resourceId}
        exceptions={availability.exceptions}
        canManage={canManage}
        onError={showError}
      />

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
