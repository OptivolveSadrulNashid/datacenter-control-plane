import { useState } from 'react';
import type { ReactElement } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import type { Role } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ErrorBanner } from '../components/ErrorBanner';
import { Field } from '../components/ui';

/**
 * The seeded accounts from `prisma/seed.ts`, offered as one-click fills. A
 * reviewer opening this project shouldn't have to dig through the README to find
 * credentials — and switching roles is how the RBAC demo is driven.
 */
const DEMO_ACCOUNTS: { email: string; password: string; role: Role; note: string }[] = [
  { email: 'admin@icp.local', password: 'admin12345', role: 'ADMIN', note: 'everything' },
  {
    email: 'operator@icp.local',
    password: 'operator12345',
    role: 'OPERATOR',
    note: 'nodes and GPUs, no cluster changes',
  },
  { email: 'viewer@icp.local', password: 'viewer12345', role: 'VIEWER', note: 'read-only' },
];

export function LoginPage(): ReactElement {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('admin@icp.local');
  const [password, setPassword] = useState('admin12345');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const from = (location.state as { from?: string } | null)?.from ?? '/nodes';
  if (user) return <Navigate to={from} replace />;

  async function submit(nextEmail: string, nextPassword: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await login(nextEmail, nextPassword);
      navigate(from, { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err
          : new ApiError(0, 'NETWORK_ERROR', 'Could not reach the API', null, null),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="login-card">
        <h1>Infrastructure Control Plane</h1>
        <p className="muted">
          Lifecycle management for simulated datacenter inventory — clusters, racks, nodes and
          GPUs.
        </p>

        {error ? <ErrorBanner error={error} /> : null}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit(email, password);
          }}
        >
          <Field label="Email">
            <input
              type="email"
              value={email}
              autoComplete="username"
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </Field>

          <Field label="Password">
            <input
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </Field>

          <button type="submit" className="btn btn-primary block" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <div className="divider">seeded accounts</div>

        <ul className="accounts">
          {DEMO_ACCOUNTS.map((account) => (
            <li key={account.email}>
              <button
                type="button"
                className="btn btn-ghost block"
                disabled={busy}
                onClick={() => {
                  setEmail(account.email);
                  setPassword(account.password);
                  void submit(account.email, account.password);
                }}
              >
                <strong>{account.role}</strong>
                <span className="muted small">{account.note}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
