import { useMutation } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import { MIN_PASSWORD_LENGTH, type SessionDto } from '@slotline/shared';
import { useClearSession } from '../hooks/useSession';
import { api, ApiError } from '../lib/api-client';

/**
 * The only screen an account with a temporary password can reach. The server enforces
 * that too — this is the pleasant way to meet the rule, not the rule itself. SPEC §10 M4.
 */
export function ChangePasswordPage({ session }: { session: SessionDto }): ReactElement {
  const clearSession = useClearSession();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const change = useMutation({
    mutationFn: () =>
      api<undefined>('/api/auth/password', {
        method: 'POST',
        body: { currentPassword, newPassword },
      }),
    // Changing a password revokes every session, including this one, so the only honest
    // next step is signing in again.
    onSuccess: clearSession,
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not set that password.');
    },
  });

  return (
    <main className="auth">
      <form
        className="auth__card"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          change.mutate();
        }}
      >
        <h1>Choose your own password</h1>
        <p className="auth__aside">
          {session.user.displayName}, this account still uses the temporary password an
          administrator gave you. Set your own to carry on.
        </p>

        <label className="field">
          <span>Temporary password</span>
          <input
            type="password"
            value={currentPassword}
            onChange={(event) => {
              setCurrentPassword(event.target.value);
            }}
            autoComplete="current-password"
            required
          />
        </label>

        <label className="field">
          <span>New password</span>
          <input
            type="password"
            value={newPassword}
            onChange={(event) => {
              setNewPassword(event.target.value);
            }}
            minLength={MIN_PASSWORD_LENGTH}
            autoComplete="new-password"
            required
          />
          <small>At least {MIN_PASSWORD_LENGTH} characters.</small>
        </label>

        {error && <p className="field__error">{error}</p>}

        <button type="submit" disabled={change.isPending}>
          {change.isPending ? 'Saving...' : 'Set password and sign in again'}
        </button>
      </form>
    </main>
  );
}
