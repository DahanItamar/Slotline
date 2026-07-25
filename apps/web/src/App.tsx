import { useMutation } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import type { SessionDto } from '@slotline/shared';
import { useEventStream } from './hooks/useEventStream';
import { useClearSession, useSession } from './hooks/useSession';
import { api } from './lib/api-client';
import { AvailabilityPage } from './routes/AvailabilityPage';
import { CalendarPage } from './routes/CalendarPage';
import { ChangePasswordPage } from './routes/ChangePasswordPage';
import { LoginPage } from './routes/LoginPage';
import { ResourcesPage } from './routes/ResourcesPage';
import { SignupPage } from './routes/SignupPage';
import { UsersPage } from './routes/UsersPage';

function TopBar({ session, connected }: { session: SessionDto; connected: boolean }): ReactElement {
  const navigate = useNavigate();
  const clearSession = useClearSession();
  const location = useLocation();

  const logout = useMutation({
    mutationFn: () => api<undefined>('/api/auth/logout', { method: 'POST' }),
    onSuccess: () => {
      clearSession();
      navigate('/login');
    },
  });

  const isCurrent = (path: string): boolean => location.pathname.startsWith(path);

  return (
    <header className="topbar">
      <span className="topbar__brand">Slotline</span>
      <nav className="topbar__nav">
        <Link to="/calendar" aria-current={isCurrent('/calendar') ? 'page' : undefined}>
          Calendar
        </Link>
        <Link to="/resources" aria-current={isCurrent('/resources') ? 'page' : undefined}>
          Resources
        </Link>
        <Link to="/people" aria-current={isCurrent('/people') ? 'page' : undefined}>
          People
        </Link>
      </nav>
      <div className="topbar__account">
        {/* Silent staleness is the failure mode SSE invites: a grid that looks live and
            is not. Saying so is cheaper than the support ticket. */}
        <span
          className={`topbar__live topbar__live--${connected ? 'on' : 'off'}`}
          title={connected ? 'Updating live' : 'Reconnecting — the grid may be out of date'}
        >
          <span className="topbar__dot" aria-hidden="true" />
          {connected ? 'Live' : 'Reconnecting'}
        </span>
        <span>
          {session.user.displayName} &middot; {session.tenant.name}
        </span>
        <button
          type="button"
          className="button--quiet"
          onClick={() => {
            logout.mutate();
          }}
        >
          Sign out
        </button>
      </div>
    </header>
  );
}

export function App(): ReactElement {
  const { session, isLoading } = useSession();
  // One stream per tab, held at the top so it survives navigation between pages.
  const { connected } = useEventStream(session !== null);

  if (isLoading) return <p className="page__empty">Loading&hellip;</p>;

  if (!session) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  // An account still holding an admin-issued password can reach nothing else — the API
  // refuses it anyway, so routing anywhere but here would only produce 403s.
  if (session.user.mustChangePassword) return <ChangePasswordPage session={session} />;

  return (
    <div className="shell">
      <TopBar session={session} connected={connected} />
      <main className="shell__body">
        <Routes>
          <Route path="/calendar" element={<CalendarPage session={session} />} />
          <Route path="/resources" element={<ResourcesPage session={session} />} />
          <Route
            path="/resources/:resourceId/availability"
            element={<AvailabilityPage session={session} />}
          />
          <Route path="/people" element={<UsersPage session={session} />} />
          <Route path="*" element={<Navigate to="/calendar" replace />} />
        </Routes>
      </main>
    </div>
  );
}
