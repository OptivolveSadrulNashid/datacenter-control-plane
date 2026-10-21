import type { ReactElement, ReactNode } from 'react';

export function Spinner({ label = 'Loading' }: { label?: string }): ReactElement {
  return (
    <p className="muted" role="status">
      {label}…
    </p>
  );
}

export function Card({
  title,
  actions,
  children,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="card">
      {title ? (
        <div className="card-head">
          <h2>{title}</h2>
          {actions ? <div className="row gap">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="muted small">{hint}</span> : null}
    </label>
  );
}

export function Empty({ children }: { children: ReactNode }): ReactElement {
  return <p className="empty">{children}</p>;
}

/** A short, monospace id — full uuids make every table unreadable. */
export function ShortId({ id }: { id: string }): ReactElement {
  return (
    <span className="mono small muted" title={id}>
      {id.slice(0, 8)}
    </span>
  );
}

export function formatMemory(mb: number): string {
  if (mb >= 1024) {
    const gb = mb / 1024;
    return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
  }
  return `${mb} MB`;
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString();
}
