/**
 * The single place that talks to the API.
 *
 * Requests go to a relative `/api/...` path, which both the Vite dev server and
 * the production nginx image rewrite onto the Fastify service. Same-origin by
 * construction, so there is no CORS setup and no API base URL to configure per
 * environment.
 */

const TOKEN_KEY = 'icp.token';
const USER_KEY = 'icp.user';

/**
 * A failed response, unwrapped from the API's error envelope
 * (`src/http/errorHandler.ts`). Every endpoint fails in this one shape, so the UI
 * can branch on `code` instead of guessing from the status.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown,
    readonly correlationId: string | null,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when a concurrent writer got there first. */
  get isVersionConflict(): boolean {
    return this.code === 'VERSION_CONFLICT';
  }

  get isInvalidTransition(): boolean {
    return this.code === 'INVALID_TRANSITION';
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setSession(token: string, user: unknown): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export function readStoredUser<T>(): T | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A corrupted entry shouldn't wedge the app on a parse error at boot.
    clearSession();
    return null;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Skip the bearer header — only the login call needs this. */
  anonymous?: boolean;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, anonymous = false } = options;
  const token = anonymous ? null : getToken();

  const response = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload: unknown = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const envelope = (payload as { error?: Record<string, unknown> } | null)?.error;
    const error = new ApiError(
      response.status,
      typeof envelope?.['code'] === 'string' ? envelope['code'] : 'UNKNOWN',
      typeof envelope?.['message'] === 'string' ? envelope['message'] : response.statusText,
      envelope?.['details'] ?? null,
      response.headers.get('x-correlation-id'),
    );

    // The JWT lives an hour (JWT_EXPIRES_IN). Rather than let every page render
    // its own "unauthorized" state, drop the dead session and let the route
    // guard send the user to the login screen.
    if (response.status === 401 && !anonymous) {
      clearSession();
      window.dispatchEvent(new Event('icp:session-expired'));
    }

    throw error;
  }

  return payload as T;
}

/** Builds a query string, omitting empty values so filters can be left blank. */
export function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}
