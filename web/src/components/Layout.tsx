import type { ReactElement } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { StatusBadge } from './StatusBadge';

const NAV = [
  { to: '/clusters', label: 'Clusters' },
  { to: '/nodes', label: 'Nodes' },
  { to: '/gpus', label: 'GPUs' },
  { to: '/provision', label: 'Provision' },
];

/** Sends unauthenticated visitors to the login screen, remembering where they were. */
export function RequireAuth(): ReactElement {
  const { user } = useAuth();
  const location = useLocation();

  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}

export function Layout(): ReactElement {
  const { user, logout } = useAuth();

  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/nodes" className="brand">
          Infrastructure&nbsp;Control&nbsp;Plane
        </Link>

        <nav className="nav">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="session">
          {user ? (
            <>
              <span className="muted small">{user.email}</span>
              <StatusBadge value={user.role} />
              <button type="button" className="btn btn-ghost" onClick={logout}>
                Sign out
              </button>
            </>
          ) : null}
        </div>
      </header>

      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
