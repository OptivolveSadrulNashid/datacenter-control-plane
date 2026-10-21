import { useState } from 'react';
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { request } from '../api/client';
import type { Cluster, ClusterDetail, Page } from '../api/types';
import { ErrorBanner } from '../components/ErrorBanner';
import { Card, Empty, ShortId, Spinner, formatTime } from '../components/ui';
import { useApi } from '../hooks/useApi';

/**
 * `GET /clusters/:id` already returns the cluster's racks with a soft-delete
 * filtered node count, so expanding a row is one request and needs no extra
 * endpoint.
 */
function ClusterRacks({ clusterId }: { clusterId: string }): ReactElement {
  const { data, error, loading } = useApi<ClusterDetail>(
    () => request<ClusterDetail>(`/clusters/${clusterId}`),
    [clusterId],
  );

  if (loading) return <Spinner label="Loading racks" />;
  if (error) return <ErrorBanner error={error} />;
  if (!data || data.racks.length === 0) return <Empty>No racks in this cluster.</Empty>;

  return (
    <table className="table">
      <thead>
        <tr>
          <th>Rack</th>
          <th>Nodes</th>
          <th>Id</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {data.racks.map((rack) => (
          <tr key={rack.id}>
            <td>{rack.name}</td>
            <td>{rack._count?.nodes ?? 0}</td>
            <td>
              <ShortId id={rack.id} />
            </td>
            <td className="right">
              <Link className="btn btn-ghost small" to={`/nodes?rackId=${rack.id}`}>
                View nodes
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ClustersPage(): ReactElement {
  const { data, error, loading } = useApi<Page<Cluster>>(
    () => request<Page<Cluster>>('/clusters'),
    [],
  );
  const [expanded, setExpanded] = useState<string | null>(null);

  if (loading) return <Spinner label="Loading clusters" />;
  if (error) return <ErrorBanner error={error} />;

  return (
    <>
      <div className="page-head">
        <h1>Clusters</h1>
        <p className="muted">
          The top of the inventory hierarchy: clusters contain racks, racks contain nodes, nodes
          contain GPUs.
        </p>
      </div>

      {!data || data.data.length === 0 ? (
        <Empty>No clusters yet.</Empty>
      ) : (
        data.data.map((cluster) => (
          <Card
            key={cluster.id}
            title={
              <span className="row gap">
                {cluster.name}
                <span className="muted small">{cluster.location}</span>
              </span>
            }
            actions={
              <button
                type="button"
                className="btn btn-ghost small"
                onClick={() => setExpanded(expanded === cluster.id ? null : cluster.id)}
              >
                {expanded === cluster.id ? 'Hide racks' : 'Show racks'}
              </button>
            }
          >
            <p className="muted small">
              created {formatTime(cluster.createdAt)} · <ShortId id={cluster.id} />
            </p>
            {expanded === cluster.id ? <ClusterRacks clusterId={cluster.id} /> : null}
          </Card>
        ))
      )}
    </>
  );
}
