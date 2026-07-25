import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import type {
  CreateResourceRequest,
  ResourceDto,
  ResourceKind,
  SessionDto,
} from '@slotline/shared';
import { RESOURCE_KINDS } from '@slotline/shared';
import { Toast, type ToastMessage } from '../components/Toast';
import { api, ApiError } from '../lib/api-client';

const EMPTY_FORM = { kind: 'room' as ResourceKind, name: '', description: '' };

function ResourceTable({
  resources,
  canManage,
  onToggle,
}: {
  resources: ResourceDto[];
  canManage: boolean;
  onToggle: (resource: ResourceDto) => void;
}): ReactElement {
  return (
    <table className="table">
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Kind</th>
          <th scope="col">Booking length</th>
          <th scope="col">Status</th>
          <th scope="col">Availability</th>
          {canManage && <th scope="col">Actions</th>}
        </tr>
      </thead>
      <tbody>
        {resources.map((resource) => (
          <tr key={resource.id} className={resource.isActive ? '' : 'table__row--muted'}>
            <td>{resource.name}</td>
            <td>{resource.kind}</td>
            <td>
              {resource.minMinutes}-{resource.maxMinutes} min
            </td>
            <td>{resource.isActive ? 'Bookable' : 'Not bookable'}</td>
            <td>
              <Link to={`/resources/${resource.id}/availability`}>Hours</Link>
            </td>
            {canManage && (
              <td>
                <button
                  type="button"
                  className="button--quiet"
                  onClick={() => {
                    onToggle(resource);
                  }}
                >
                  {resource.isActive ? 'Deactivate' : 'Reactivate'}
                </button>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ResourcesPage({ session }: { session: SessionDto }): ReactElement {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(EMPTY_FORM);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const canManage = session.user.role !== 'member';

  const resourcesQuery = useQuery({
    queryKey: ['resources', 'all'],
    queryFn: async () =>
      (await api<{ resources: ResourceDto[] }>('/api/resources?includeInactive=true')).resources,
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['resources'] });
  };

  const createResource = useMutation({
    mutationFn: (request: Partial<CreateResourceRequest>) =>
      api<ResourceDto>('/api/resources', { method: 'POST', body: request }),
    onSuccess: () => {
      setForm(EMPTY_FORM);
      refresh();
      setToast({ id: Date.now(), tone: 'success', text: 'Resource added.' });
    },
    onError: (error) => {
      setToast({
        id: Date.now(),
        tone: 'error',
        text: error instanceof ApiError ? error.message : 'Could not add that resource.',
      });
    },
  });

  const toggleActive = useMutation({
    mutationFn: (resource: ResourceDto) =>
      api<ResourceDto>(`/api/resources/${resource.id}`, {
        method: 'PATCH',
        body: { isActive: !resource.isActive },
      }),
    onSuccess: refresh,
  });

  const resources = resourcesQuery.data ?? [];

  return (
    <div className="page">
      <h1>Resources</h1>

      {canManage && (
        <form
          className="resource-form"
          onSubmit={(event) => {
            event.preventDefault();
            createResource.mutate(form);
          }}
        >
          <label className="field field--inline">
            <span>Kind</span>
            <select
              value={form.kind}
              onChange={(event) => {
                setForm({ ...form, kind: event.target.value as ResourceKind });
              }}
            >
              {RESOURCE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
          </label>

          <label className="field field--inline">
            <span>Name</span>
            <input
              value={form.name}
              onChange={(event) => {
                setForm({ ...form, name: event.target.value });
              }}
              placeholder="Room A / Projector 1 / Dana Levi"
              required
            />
          </label>

          <button type="submit" disabled={createResource.isPending}>
            Add
          </button>
        </form>
      )}

      {resourcesQuery.isLoading && <p className="page__empty">Loading&hellip;</p>}

      {!resourcesQuery.isLoading && resources.length === 0 && (
        <div className="page__empty">
          <h2>Nothing here yet</h2>
          <p>
            {canManage
              ? 'Add your first room, piece of equipment, or consultant above.'
              : 'Ask an administrator to add a bookable resource.'}
          </p>
        </div>
      )}

      {resources.length > 0 && (
        <ResourceTable
          resources={resources}
          canManage={canManage}
          onToggle={(resource) => {
            toggleActive.mutate(resource);
          }}
        />
      )}

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
