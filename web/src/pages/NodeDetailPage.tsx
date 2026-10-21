import { useState } from 'react';
import type { ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, request } from '../api/client';
import { NODE_STATUSES } from '../api/types';
import type {
  InvalidTransitionDetails,
  LifecycleEvent,
  NodeDetail,
  NodeStatus,
  StatusChangeResponse,
  VersionConflictDetails,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ErrorBanner } from '../components/ErrorBanner';
import { StatusBadge } from '../components/StatusBadge';
import { Card, Empty, Field, ShortId, Spinner, formatMemory, formatTime } from '../components/ui';
import { useApi } from '../hooks/useApi';

interface HistoryResponse {
  nodeId: string;
  events: LifecycleEvent[];
}

/**
 * The screen the whole project is about.
 *
 * Two rules it has to obey:
 *   1. always PATCH the version currently on screen — never a literal. A freshly
 *      provisioned node is already on version 3 (created → PROVISIONING → ACTIVE).
 *   2. render the server's `allowedTransitions` rather than a copy of the state
 *      machine. The graph lives in `src/domain/lifecycle.ts` and nowhere else.
 */
export function NodeDetailPage(): ReactElement {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const mayWrite = can('ADMIN', 'OPERATOR');

  const node = useApi<NodeDetail>(() => request<NodeDetail>(`/nodes/${id}`), [id]);
  // Fetched separately because the audit trail deliberately outlives the node:
  // after a soft delete `/nodes/:id` is 404 but `/nodes/:id/history` still answers.
  const history = useApi<HistoryResponse>(
    () => request<HistoryResponse>(`/nodes/${id}/history`),
    [id],
  );

  const [reason, setReason] = useState('');
  const [pending, setPending] = useState<NodeStatus | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [lastChange, setLastChange] = useState<StatusChangeResponse | null>(null);
  const [illegalTarget, setIllegalTarget] = useState<NodeStatus>('CREATED');

  async function changeStatus(to: NodeStatus): Promise<void> {
    if (!node.data) return;
    setPending(to);
    setActionError(null);
    setLastChange(null);

    try {
      const result = await request<StatusChangeResponse>(`/nodes/${id}/status`, {
        method: 'PATCH',
        // The version comes from what is rendered, which is what makes a stale
        // tab produce a genuine 409 instead of silently clobbering.
        body: { status: to, version: node.data.version, ...(reason ? { reason } : {}) },
      });
      setLastChange(result);
      setReason('');
      node.reload();
      history.reload();
    } catch (err) {
      if (err instanceof ApiError) setActionError(err);
    } finally {
      setPending(null);
    }
  }

  if (node.loading) return <Spinner label="Loading node" />;

  // Soft-deleted: the node is gone from reads, but its history is not.
  if (node.error?.status === 404) {
    return (
      <>
        <div className="page-head">
          <h1>Node not found</h1>
          <p className="muted">
            This node was soft-deleted — <code>deleted_at</code> is set, so reads return 404. Its
            audit trail survives, because history is append-only and never deleted with the row.
          </p>
        </div>
        <ErrorBanner error={node.error} />
        <HistoryCard state={history} />
        <Link className="btn btn-ghost" to="/nodes">
          Back to nodes
        </Link>
      </>
    );
  }

  if (node.error) return <ErrorBanner error={node.error} />;
  if (!node.data) return <Empty>Nothing to show.</Empty>;

  const current = node.data;
  const conflict = actionError?.isVersionConflict
    ? (actionError.details as VersionConflictDetails | null)
    : null;
  const invalid = actionError?.isInvalidTransition
    ? (actionError.details as InvalidTransitionDetails | null)
    : null;

  return (
    <>
      <div className="page-head">
        <div className="row gap baseline">
          <Link to="/nodes" className="muted">
            Nodes
          </Link>
          <span className="muted">/</span>
          <h1>{current.hostname}</h1>
          <StatusBadge value={current.status} />
          <span className="version-chip mono">version {current.version}</span>
        </div>
        <p className="muted small">
          <ShortId id={current.id} />
          {current.rack ? ` · rack ${current.rack.name}` : null}
          {current.rack?.cluster ? ` · cluster ${current.rack.cluster.name}` : null}
        </p>
      </div>

      <div className="grid-2">
        <Card title="Change status">
          {!mayWrite ? (
            <div className="banner banner-info">
              <strong>Read-only role.</strong>
              <p>
                Your role is VIEWER, so these controls are disabled. The server enforces this
                independently — a hand-crafted request still gets 403 <code>FORBIDDEN</code>.
              </p>
            </div>
          ) : null}

          <p className="muted small">
            Legal next states come from the API (<code>allowedTransitions</code>), so this UI never
            duplicates the lifecycle graph.
          </p>

          <div className="row gap wrap">
            {current.allowedTransitions.length === 0 ? (
              <Empty>
                <code>{current.status}</code> is terminal — there is nowhere left to go.
              </Empty>
            ) : (
              current.allowedTransitions.map((target) => (
                <button
                  key={target}
                  type="button"
                  className="btn btn-primary"
                  disabled={!mayWrite || pending !== null}
                  onClick={() => void changeStatus(target)}
                >
                  {pending === target ? 'Working…' : `→ ${target}`}
                </button>
              ))
            )}
          </div>

          <Field label="Reason" hint="Optional. Stored on the audit event.">
            <input
              type="text"
              value={reason}
              maxLength={500}
              placeholder="scheduled firmware upgrade"
              disabled={!mayWrite}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>

          <details className="demo-block">
            <summary>Demo: force an illegal transition</summary>
            <p className="muted small">
              The buttons above can only produce legal moves. This sends any status you pick, so
              the server-side state machine has to reject it — expect 422{' '}
              <code>INVALID_TRANSITION</code>.
            </p>
            <div className="row gap">
              <select
                value={illegalTarget}
                onChange={(e) => setIllegalTarget(e.target.value as NodeStatus)}
              >
                {NODE_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-danger"
                disabled={!mayWrite || pending !== null}
                onClick={() => void changeStatus(illegalTarget)}
              >
                Send anyway
              </button>
            </div>
          </details>

          {conflict ? (
            <ErrorBanner error={actionError as ApiError}>
              <div className="conflict">
                <div>
                  <span className="muted small">you sent</span>
                  <strong className="mono">v{conflict.expectedVersion}</strong>
                </div>
                <div>
                  <span className="muted small">current</span>
                  <strong className="mono">v{conflict.currentVersion}</strong>
                </div>
              </div>
              <p className="small">
                Someone else committed first, so your write was rejected rather than silently
                overwriting theirs. Re-read the node and decide again.
              </p>
              <button
                type="button"
                className="btn btn-primary small"
                onClick={() => {
                  setActionError(null);
                  node.reload();
                  history.reload();
                }}
              >
                Reload node
              </button>
            </ErrorBanner>
          ) : null}

          {invalid ? (
            <ErrorBanner error={actionError as ApiError}>
              <p className="small">
                <code>{invalid.from}</code> → <code>{invalid.to}</code> is not a legal move. The row
                was not touched. Allowed from here:{' '}
                {invalid.allowed.length === 0 ? (
                  <em>nothing, this state is terminal</em>
                ) : (
                  invalid.allowed.map((value) => (
                    <span key={value} className="inline-badge">
                      {value}
                    </span>
                  ))
                )}
              </p>
            </ErrorBanner>
          ) : null}

          {actionError && !conflict && !invalid ? <ErrorBanner error={actionError} /> : null}

          {lastChange ? (
            <div className="banner banner-ok">
              <strong>
                {lastChange.previousStatus} → {lastChange.status}
              </strong>
              <p className="small">
                Version moved to <span className="mono">v{lastChange.version}</span>, and one row
                was appended to the audit trail in the same transaction.
              </p>
            </div>
          ) : null}
        </Card>

        <Card title="Hardware">
          <dl className="kv">
            <dt>CPU</dt>
            <dd>{current.cpu}</dd>
            <dt>Memory</dt>
            <dd>{formatMemory(current.memoryMb)}</dd>
            <dt>Created</dt>
            <dd>{formatTime(current.createdAt)}</dd>
            <dt>Updated</dt>
            <dd>{formatTime(current.updatedAt)}</dd>
          </dl>

          <h3 className="sub">GPUs ({current.gpus?.length ?? 0})</h3>
          {!current.gpus || current.gpus.length === 0 ? (
            <Empty>No GPUs attached.</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Vendor</th>
                  <th>Model</th>
                  <th>Memory</th>
                  <th>Serial</th>
                  <th>Health</th>
                </tr>
              </thead>
              <tbody>
                {current.gpus.map((gpu) => (
                  <tr key={gpu.id}>
                    <td>{gpu.vendor}</td>
                    <td>{gpu.model}</td>
                    <td className="muted small">{formatMemory(gpu.memoryMb)}</td>
                    <td className="mono small">{gpu.serialNumber}</td>
                    <td>
                      <StatusBadge value={gpu.healthStatus} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <HistoryCard state={history} />
    </>
  );
}

/**
 * The append-only audit trail. Newest first, but every row is an insert — nothing
 * here is ever updated, which is what makes it trustworthy.
 */
function HistoryCard({
  state,
}: {
  state: { data: HistoryResponse | null; error: ApiError | null; loading: boolean };
}): ReactElement {
  return (
    <Card title="Lifecycle history">
      <p className="muted small">
        One append-only row per transition, written in the same transaction as the status change.
      </p>

      {state.loading ? <Spinner label="Loading history" /> : null}
      {state.error ? <ErrorBanner error={state.error} /> : null}

      {state.data && state.data.events.length > 0 ? (
        <ol className="timeline">
          {[...state.data.events].reverse().map((event) => (
            <li key={event.id}>
              <div className="row gap baseline">
                {event.oldStatus ? (
                  <>
                    <StatusBadge value={event.oldStatus} />
                    <span className="muted">→</span>
                  </>
                ) : (
                  <span className="muted small">created as</span>
                )}
                <StatusBadge value={event.newStatus} />
                <span className="muted small">{event.eventType}</span>
              </div>
              <p className="muted small">
                {event.actor} · {formatTime(event.createdAt)}
                {event.reason ? ` · ${event.reason}` : ''}
              </p>
            </li>
          ))}
        </ol>
      ) : null}

      {state.data && state.data.events.length === 0 ? <Empty>No events recorded.</Empty> : null}
    </Card>
  );
}
