import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api/client';

interface ApiState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Fetch-on-mount with a manual `reload()`. Deliberately not a caching library:
 * every screen here wants to see the server's current state, and a stale cache
 * is actively misleading in a demo about concurrent writes.
 *
 * `deps` behaves like a `useEffect` dependency list — pass the values the
 * `fetcher` closes over (filters, ids) so it re-runs when they change.
 */
export function useApi<T>(fetcher: () => Promise<T>, deps: unknown[]): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let active = true;
    setLoading(true);

    fetcher()
      .then((result) => {
        if (!active) return;
        setData(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(
          err instanceof ApiError
            ? err
            : new ApiError(0, 'NETWORK_ERROR', 'Could not reach the API', null, null),
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    // Ignoring a resolved response after the deps changed prevents an older,
    // slower request from overwriting a newer one.
    return () => {
      active = false;
    };
    // `fetcher` is intentionally not a dependency: callers pass an inline arrow
    // that is a new reference on every render, which would loop forever. `deps`
    // is the explicit contract instead.
  }, [...deps, nonce]);

  return { data, error, loading, reload };
}
