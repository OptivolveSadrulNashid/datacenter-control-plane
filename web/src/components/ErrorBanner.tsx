import type { ReactElement, ReactNode } from 'react';
import type { ApiError } from '../api/client';

/**
 * Renders the API's error envelope as-is: code, message and correlation id. The
 * correlation id is the point — it's the same value in the API and worker logs
 * (`x-correlation-id`), so a failure on screen can be traced straight to
 * `docker compose logs`.
 */
export function ErrorBanner({
  error,
  children,
}: {
  error: ApiError;
  children?: ReactNode;
}): ReactElement {
  return (
    <div className="banner banner-error">
      <div className="banner-head">
        <strong>{error.code}</strong>
        <span className="muted">HTTP {error.status}</span>
      </div>
      <p>{error.message}</p>
      {children}
      {error.correlationId ? (
        <p className="muted mono small">correlation id: {error.correlationId}</p>
      ) : null}
    </div>
  );
}
