import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import type {
  CreateUserRequest,
  CreateUserResponse,
  MembershipRole,
  SessionDto,
  UserDto,
} from '@slotline/shared';
import { MEMBERSHIP_ROLES } from '@slotline/shared';
import { Toast, type ToastMessage } from '../components/Toast';
import { api, ApiError } from '../lib/api-client';

const EMPTY: CreateUserRequest = { email: '', displayName: '', role: 'member' };

export function UsersPage({ session }: { session: SessionDto }): ReactElement {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<CreateUserRequest>(EMPTY);
  const [issued, setIssued] = useState<CreateUserResponse | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const isOwner = session.user.role === 'owner';
  const canManage = session.user.role !== 'member';

  const usersQuery = useQuery({
    queryKey: ['users'],
    queryFn: async () => (await api<{ users: UserDto[] }>('/api/users')).users,
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['users'] });
  };

  const fail = (error: unknown): void => {
    setToast({
      id: Date.now(),
      tone: 'error',
      text: error instanceof ApiError ? error.message : 'That did not work.',
    });
  };

  const createUser = useMutation({
    mutationFn: (request: CreateUserRequest) =>
      api<CreateUserResponse>('/api/users', { method: 'POST', body: request }),
    onSuccess: (response) => {
      setForm(EMPTY);
      setIssued(response);
      refresh();
    },
    onError: fail,
  });

  const updateUser = useMutation({
    mutationFn: ({ id, ...changes }: { id: string; role?: MembershipRole; isActive?: boolean }) =>
      api<UserDto>(`/api/users/${id}`, { method: 'PATCH', body: changes }),
    onSuccess: refresh,
    onError: fail,
  });

  return (
    <div className="page">
      <h1>People</h1>

      {canManage && (
        <form
          className="resource-form"
          onSubmit={(event) => {
            event.preventDefault();
            createUser.mutate(form);
          }}
        >
          <label className="field field--inline">
            <span>Name</span>
            <input
              value={form.displayName}
              onChange={(event) => {
                setForm({ ...form, displayName: event.target.value });
              }}
              required
            />
          </label>

          <label className="field field--inline">
            <span>Email</span>
            <input
              type="email"
              value={form.email}
              onChange={(event) => {
                setForm({ ...form, email: event.target.value });
              }}
              required
            />
          </label>

          <label className="field field--inline">
            <span>Role</span>
            <select
              value={form.role}
              onChange={(event) => {
                setForm({ ...form, role: event.target.value as MembershipRole });
              }}
            >
              {MEMBERSHIP_ROLES.filter((role) => isOwner || role === 'member').map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </label>

          <button type="submit" disabled={createUser.isPending}>
            Add person
          </button>
        </form>
      )}

      {/*
        There is no email provider in the stack (Assumption 3), so this is the only time
        the password exists in readable form. Saying so plainly is better than letting an
        admin navigate away and find out.
      */}
      {issued && (
        <section className="availability availability--warning">
          <h2>Temporary password for {issued.user.displayName}</h2>
          <p className="detail__password">{issued.temporaryPassword}</p>
          <p className="availability__hint">
            Shown once and never again — it is not stored in readable form. Pass it on, and they
            will be asked to choose their own on first sign-in. If it is lost, add the person again
            or ask an owner to reset it.
          </p>
          <button
            type="button"
            className="button--quiet"
            onClick={() => {
              setIssued(null);
            }}
          >
            I have copied it
          </button>
        </section>
      )}

      {usersQuery.isLoading ? (
        <p className="page__empty">Loading&hellip;</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Email</th>
              <th scope="col">Role</th>
              <th scope="col">Status</th>
              {canManage && <th scope="col">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {(usersQuery.data ?? []).map((user) => (
              <tr key={user.id} className={user.isActive ? '' : 'table__row--muted'}>
                <td>
                  {user.displayName}
                  {user.id === session.user.id ? ' (you)' : ''}
                </td>
                <td>{user.email}</td>
                <td>
                  {isOwner && user.id !== session.user.id ? (
                    <select
                      value={user.role}
                      onChange={(event) => {
                        updateUser.mutate({
                          id: user.id,
                          role: event.target.value as MembershipRole,
                        });
                      }}
                    >
                      {MEMBERSHIP_ROLES.map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </select>
                  ) : (
                    user.role
                  )}
                </td>
                <td>
                  {user.isActive ? 'Active' : 'Deactivated'}
                  {user.mustChangePassword ? ' · password not set' : ''}
                </td>
                {canManage && (
                  <td>
                    {user.id === session.user.id ? (
                      <span className="availability__hint">&mdash;</span>
                    ) : (
                      <button
                        type="button"
                        className="button--quiet"
                        onClick={() => {
                          updateUser.mutate({ id: user.id, isActive: !user.isActive });
                        }}
                      >
                        {user.isActive ? 'Deactivate' : 'Reactivate'}
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
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
