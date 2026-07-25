import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { LoginRequest, SessionDto } from '@slotline/shared';
import { SESSION_QUERY_KEY } from '../hooks/useSession';
import { api, ApiError } from '../lib/api-client';

export function LoginPage(): ReactElement {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<LoginRequest>({ tenantSlug: '', email: '', password: '' });
  const [error, setError] = useState<string | null>(null);

  const login = useMutation({
    mutationFn: (request: LoginRequest) =>
      api<SessionDto>('/api/auth/login', { method: 'POST', body: request }),
    onSuccess: (session) => {
      queryClient.setQueryData(SESSION_QUERY_KEY, session);
      navigate('/calendar');
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not sign in.');
    },
  });

  return (
    <main className="auth">
      <form
        className="auth__card"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          login.mutate(form);
        }}
      >
        <h1>Sign in to Slotline</h1>

        <label className="field">
          <span>Workspace</span>
          <input
            value={form.tenantSlug}
            onChange={(event) => {
              setForm({ ...form, tenantSlug: event.target.value });
            }}
            placeholder="acme"
            autoComplete="organization"
            required
          />
        </label>

        <label className="field">
          <span>Email</span>
          <input
            type="email"
            value={form.email}
            onChange={(event) => {
              setForm({ ...form, email: event.target.value });
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
              setForm({ ...form, password: event.target.value });
            }}
            autoComplete="current-password"
            required
          />
        </label>

        {error && <p className="field__error">{error}</p>}

        <button type="submit" disabled={login.isPending}>
          {login.isPending ? 'Signing in...' : 'Sign in'}
        </button>

        <p className="auth__aside">
          No workspace yet? <Link to="/signup">Create one</Link>.
        </p>
      </form>
    </main>
  );
}
