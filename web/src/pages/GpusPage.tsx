import type { ReactElement } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { query, request } from '../api/client';
import { GPU_HEALTHS } from '../api/types';
import type { Gpu, Page } from '../api/types';
import { ErrorBanner } from '../components/ErrorBanner';
import { StatusBadge } from '../components/StatusBadge';
import { Empty, Field, ShortId, Spinner, formatMemory } from '../components/ui';
import { useApi } from '../hooks/useApi';

export function GpusPage(): ReactElement {
  const [params, setParams] = useSearchParams();
  const vendor = params.get('vendor') ?? '';
  const healthStatus = params.get('healthStatus') ?? '';
  const unassigned = params.get('unassigned') ?? '';

  const { data, error, loading } = useApi<Page<Gpu>>(
    () =>
      request<Page<Gpu>>(
        `/gpus${query({ vendor, healthStatus, unassigned, limit: 50 })}`,
      ),
    [vendor, healthStatus, unassigned],
  );

  function setFilter(key: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  }

  return (
    <>
      <div className="page-head">
        <h1>GPUs</h1>
        <p className="muted">
          Attached to a node or sitting in spare inventory. Note the <code>unassigned</code> filter
          is parsed from an explicit <code>true</code>/<code>false</code> literal, not coerced —
          coercion would read the string “false” as true.
        </p>
      </div>

      <div className="filters">
        <Field label="Vendor">
          <input
            type="search"
            value={vendor}
            placeholder="NVIDIA"
            onChange={(e) => setFilter('vendor', e.target.value)}
          />
        </Field>

        <Field label="Health">
          <select value={healthStatus} onChange={(e) => setFilter('healthStatus', e.target.value)}>
            <option value="">any</option>
            {GPU_HEALTHS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Assignment">
          <select value={unassigned} onChange={(e) => setFilter('unassigned', e.target.value)}>
            <option value="">all</option>
            <option value="true">spares only</option>
          </select>
        </Field>
      </div>

      {loading ? <Spinner label="Loading GPUs" /> : null}
      {error ? <ErrorBanner error={error} /> : null}

      {data && data.data.length === 0 ? <Empty>No GPUs match.</Empty> : null}

      {data && data.data.length > 0 ? (
        <table className="table">
          <thead>
            <tr>
              <th>Vendor</th>
              <th>Model</th>
              <th>Memory</th>
              <th>Serial</th>
              <th>Health</th>
              <th>Node</th>
            </tr>
          </thead>
          <tbody>
            {data.data.map((gpu) => (
              <tr key={gpu.id}>
                <td>{gpu.vendor}</td>
                <td>{gpu.model}</td>
                <td className="muted small">{formatMemory(gpu.memoryMb)}</td>
                <td className="mono small">{gpu.serialNumber}</td>
                <td>
                  <StatusBadge value={gpu.healthStatus} />
                </td>
                <td>
                  {gpu.nodeId ? (
                    <Link className="link" to={`/nodes/${gpu.nodeId}`}>
                      <ShortId id={gpu.nodeId} />
                    </Link>
                  ) : (
                    <span className="muted small">spare</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </>
  );
}
