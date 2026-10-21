import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { clearSession, readStoredUser, request, setSession } from '../api/client';
import type { AuthUser, LoginResponse, Role } from '../api/types';

interface AuthState {
  user: AuthUser | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  /**
   * Whether the signed-in role is allowed to perform an action.
   *
   * This is a usability affordance only — it greys out buttons a VIEWER can't
   * use. The actual guard is `app.authorize(...)` on every route, and the demo
   * deliberately shows a 403 so that's visible rather than implied.
   */
  can: (...roles: Role[]) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): ReactElement {
  const [user, setUser] = useState<AuthUser | null>(() => readStoredUser<AuthUser>());

  // The client dispatches this when a request comes back 401, so an expired
  // token logs the UI out instead of leaving it in a half-authenticated state.
  useEffect(() => {
    const onExpired = (): void => setUser(null);
    window.addEventListener('icp:session-expired', onExpired);
    return () => window.removeEventListener('icp:session-expired', onExpired);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const result = await request<LoginResponse>('/auth/login', {
      method: 'POST',
      body: { email, password },
      anonymous: true,
    });
    setSession(result.token, result.user);
    setUser(result.user);
  }, []);

  const logout = useCallback(() => {
    clearSession();
    setUser(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      login,
      logout,
      can: (...roles: Role[]) => (user ? roles.includes(user.role) : false),
    }),
    [user, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
}
