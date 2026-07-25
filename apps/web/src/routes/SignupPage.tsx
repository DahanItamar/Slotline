import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { SessionDto, SignupRequest } from '@slotline/shared';
import { SESSION_QUERY_KEY } from '../hooks/useSession';
import { api, ApiError } from '../lib/api-client';

const browserTimeZone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin';

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);

export function SignupPage(): ReactElement {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<SignupRequest>({
    tenantName: '',
    tenantSlug: '',
    timezone: browserTimeZone(),
    email: '',
    password: '',
    displayName: '',
  });

  const signup = useMutation({
    mutationFn: (request: SignupRequest) =>
      api<SessionDto>('/api/auth/signup', { method: 'POST', body: request }),
    onSuccess: (session) => {
      queryClient.setQueryData(SESSION_QUERY_KEY, session);
      navigate('/calendar');
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not create the workspace.');
    },
  });

  const set = <K extends keyof SignupRequest>(key: K, value: SignupRequest[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  return (
    <main className="auth">
      <form
        className="auth__card"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          signup.mutate(form);
        }}
      >
        <h1>Create a workspace</h1>

        <label className="field">
          <span>Organisation name</span>
          <input
            value={form.tenantName}
            onChange={(event) => {
              const name = event.target.value;
              setForm((current) => ({
                ...current,
                tenantName: name,
                // Only auto-fill while the address is untouched, so editing it sticks.
                tenantSlug:
                  current.tenantSlug === slugify(current.tenantName)
                    ? slugify(name)
                    : current.tenantSlug,
              }));
            }}
            required
          />
        </label>

        <label className="field">
          <span>Workspace address</span>
          <input
            value={form.tenantSlug}
            onChange={(event) => {
              set('tenantSlug', event.target.value);
            }}
            pattern="[a-z0-9-]{3,32}"
            title="Lowercase letters, digits and hyphens, 3-32 characters"
            required
          />
        </label>

        <label className="field">
          <span>Time zone</span>
          <input
            value={form.timezone}
            onChange={(event) => {
              set('timezone', event.target.value);
            }}
            required
          />
          <small>Every calendar in this workspace is shown in this zone.</small>
        </label>

        <label className="field">
          <span>Your name</span>
          <input
            value={form.displayName}
            onChange={(event) => {
              set('displayName', event.target.value);
            }}
            autoComplete="name"
            required
          />
        </label>

        <label className="field">
          <span>Email</span>
          <input
            type="email"
            value={form.email}
            onChange={(event) => {
              set('email', event.target.value);
            }}
            autoComplete="username"
            required
          />
        </label>

        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={form.password}
            onChange={(event) => {
              set('password', event.target.value);
            }}
            minLength={12}
            autoComplete="new-password"
            required
          />
          <small>At least 12 characters.</small>
        </label>

        {error && <p className="field__error">{error}</p>}

        <button type="submit" disabled={signup.isPending}>
          {signup.isPending ? 'Creating...' : 'Create workspace'}
        </button>

        <p className="auth__aside">
          Already have one? <Link to="/login">Sign in</Link>.
        </p>
      </form>
    </main>
  );
}
