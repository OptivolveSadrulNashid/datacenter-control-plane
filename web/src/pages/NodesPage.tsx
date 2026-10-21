import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError, query, request } from '../api/client';
import { NODE_STATUSES } from '../api/types';
import type { Node, NodeStatus, Page } from '../api/types';
import { ErrorBanner } from '../components/ErrorBanner';
import { StatusBadge } from '../components/StatusBadge';
import { Empty, Field, ShortId, Spinner, formatMemory } from '../components/ui';

export function NodesPage(): ReactElement {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const hostname = params.get('hostname') ?? '';
  const rackId = params.get('rackId') ?? '';

  const [rows, setRows] = useState<Node[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);

  /**
   * Pages are appended, not replaced, so "Load more" walks the keyset cursor the
   * API already returns (`page.nextCursor`) rather than recomputing an offset.
   */
  const load = useCallback(
    async (from: string | null): Promise<void> => {
      setLoading(true);
      try {
        const page = await request<Page<Node>>(
          `/nodes${query({ status, hostname, rackId, limit: 20, cursor: from ?? undefined })}`,
        );
        setRows((current) => (from ? [...current, ...page.data] : page.data));
        setCursor(page.page.nextCursor);
        setHasMore(page.page.hasMore);
        setError(null);
      } catch (err) {
        if (err instanceof ApiError) setError(err);
      } finally {
        setLoading(false);
      }
    },
    [status, hostname, rackId],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  function setFilter(key: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  }

  return (
    <>
      <div className="page-head">
        <h1>Nodes</h1>
        <p className="muted">
          Every node carries a <code>version</code>. Open one to change its status — that is where
          optimistic locking lives.
        </p>
      </div>

      <div className="filters">
        <Field label="Status">
          <select value={status} onChange={(e) => setFilter('status', e.target.value)}>
            <option value="">any</option>
            {NODE_STATUSES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Hostname contains">
          <input
            type="search"
            value={hostname}
            placeholder="gpu-node"
            onChange={(e) => setFilter('hostname', e.target.value)}
          />
        </Field>

        {rackId ? (
          <Field label="Rack">
            <button type="button" className="btn btn-ghost" onClick={() => setFilter('rackId', '')}>
              clear rack filter
            </button>
          </Field>
        ) : null}
      </div>

      {error ? <ErrorBanner error={error} /> : null}

      {rows.length === 0 && !loading ? (
        <Empty>
          No nodes match. <Link to="/provision">Provision one</Link>.
        </Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Hostname</th>
              <th>Status</th>
              <th>Version</th>
              <th>CPU</th>
              <th>Memory</th>
              <th>GPUs</th>
              <th>Id</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((node) => (
              <tr key={node.id}>
                <td>
                  <Link to={`/nodes/${node.id}`} className="link">
                    {node.hostname}
                  </Link>
                </td>
                <td>
                  <StatusBadge value={node.status as NodeStatus} />
                </td>
                <td className="mono">v{node.version}</td>
                <td className="muted small">{node.cpu}</td>
                <td className="muted small">{formatMemory(node.memoryMb)}</td>
                <td>{node._count?.gpus ?? 0}</td>
                <td>
                  <ShortId id={node.id} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {loading ? <Spinner label="Loading nodes" /> : null}

      {hasMore ? (
        <button type="button" className="btn btn-ghost" onClick={() => void load(cursor)}>
          Load more
        </button>
      ) : null}
    </>
  );
}
