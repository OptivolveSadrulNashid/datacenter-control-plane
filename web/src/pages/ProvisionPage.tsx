import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, request } from '../api/client';
import { isTerminalJobStatus } from '../api/types';
import type { EnqueuedJob, GpuInput, Job, Page, Rack } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ErrorBanner } from '../components/ErrorBanner';
import { StatusBadge } from '../components/StatusBadge';
import { Card, Empty, Field, Spinner, formatTime } from '../components/ui';
import { useApi } from '../hooks/useApi';

/** A serial already in the database from `prisma/seed.ts` — the rollback demo. */
const SEEDED_SERIAL = 'SPARE-H100-0001';

const emptyGpu = (index: number): GpuInput => ({
  vendor: 'NVIDIA',
  model: 'H100',
  memoryMb: 81920,
  serialNumber: `SN-${String(index + 1).padStart(4, '0')}`,
});

/**
 * Watches a job to completion.
 *
 * Polls once a second and stops the moment the status is terminal. The API is
 * rate limited to 100 requests/minute per IP (RATE_LIMIT_MAX) and in Docker every
 * browser request arrives from the same proxy address, so an unbounded interval
 * here would eventually spend the whole budget.
 */
function JobWatcher({ jobId }: { jobId: string }): ReactElement {
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;

    const poll = async (): Promise<void> => {
      try {
        const next = await request<Job>(`/jobs/${jobId}`);
        if (!active) return;
        setJob(next);
        if (!isTerminalJobStatus(next.status)) {
          timer = window.setTimeout(() => void poll(), 1000);
        }
      } catch (err) {
        if (active && err instanceof ApiError) setError(err);
      }
    };

    void poll();

    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [jobId]);

  if (error) return <ErrorBanner error={error} />;
  if (!job) return <Spinner label="Reading job" />;

  return (
    <div className="job">
      <div className="row gap baseline">
        <StatusBadge value={job.status} />
        <span className="muted small mono">{job.id}</span>
        {!isTerminalJobStatus(job.status) ? <span className="pulse">watching…</span> : null}
      </div>

      <ol className="job-steps">
        {(['QUEUED', 'RUNNING', 'SUCCEEDED'] as const).map((step) => {
          const order = ['QUEUED', 'RUNNING', 'SUCCEEDED'];
          const reached =
            job.status === 'FAILED'
              ? order.indexOf(step) < order.indexOf('SUCCEEDED')
              : order.indexOf(step) <= order.indexOf(job.status);
          return (
            <li key={step} className={reached ? 'reached' : ''}>
              {job.status === 'FAILED' && step === 'SUCCEEDED' ? 'FAILED' : step}
            </li>
          );
        })}
      </ol>

      <dl className="kv">
        <dt>Retries</dt>
        <dd>{job.retries}</dd>
        <dt>Started</dt>
        <dd>{job.startedAt ? formatTime(job.startedAt) : '—'}</dd>
        <dt>Finished</dt>
        <dd>{job.finishedAt ? formatTime(job.finishedAt) : '—'}</dd>
      </dl>

      {job.error ? (
        <div className="banner banner-error">
          <strong>Job failed</strong>
          {/* Prisma's constraint errors are multi-line, so keep the whitespace. */}
          <p className="small mono pre-wrap">{job.error}</p>
          <p className="muted small">
            The node was moved to <code>FAILED</code> rather than being left stuck in{' '}
            <code>PROVISIONING</code>. If the failure happened inside the first transaction, no node
            or GPU rows exist at all.
          </p>
        </div>
      ) : null}

      {job.status === 'SUCCEEDED' && job.nodeId ? (
        <Link className="btn btn-primary" to={`/nodes/${job.nodeId}`}>
          Open the provisioned node
        </Link>
      ) : null}

      {job.status === 'FAILED' ? (
        <Link className="btn btn-ghost" to="/nodes">
          Check the node list
        </Link>
      ) : null}
    </div>
  );
}

export function ProvisionPage(): ReactElement {
  const { can } = useAuth();
  const mayWrite = can('ADMIN', 'OPERATOR');
  const racks = useApi<Page<Rack>>(() => request<Page<Rack>>('/racks'), []);

  const [rackId, setRackId] = useState('');
  const [hostname, setHostname] = useState('gpu-node-01');
  const [cpu, setCpu] = useState('AMD EPYC 9654');
  const [memoryMb, setMemoryMb] = useState(786432);
  const [gpus, setGpus] = useState<GpuInput[]>([emptyGpu(0)]);
  const [accepted, setAccepted] = useState<EnqueuedJob | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  // Default to the first seeded rack once it loads.
  useEffect(() => {
    const first = racks.data?.data[0];
    if (first && !rackId) setRackId(first.id);
  }, [racks.data, rackId]);

  function updateGpu(index: number, patch: Partial<GpuInput>): void {
    setGpus((current) =>
      current.map((gpu, i) => (i === index ? { ...gpu, ...patch } : gpu)),
    );
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    setAccepted(null);
    try {
      const result = await request<EnqueuedJob>('/nodes', {
        method: 'POST',
        body: { rackId, hostname, cpu, memoryMb, gpus },
      });
      setAccepted(result);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Provision a node</h1>
        <p className="muted">
          This request does not create anything synchronously. The API records the intent as a job,
          publishes a command to RabbitMQ and answers <strong>202 Accepted</strong> with somewhere to
          poll. A worker does the work.
        </p>
      </div>

      <div className="grid-2">
        <Card title="Request">
          {!mayWrite ? (
            <div className="banner banner-info">
              <strong>Read-only role.</strong>
              <p>Provisioning requires ADMIN or OPERATOR. The server returns 403 regardless.</p>
            </div>
          ) : null}

          {racks.loading ? <Spinner label="Loading racks" /> : null}
          {racks.error ? <ErrorBanner error={racks.error} /> : null}

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Field label="Rack">
              <select value={rackId} onChange={(e) => setRackId(e.target.value)} required>
                <option value="">select a rack…</option>
                {racks.data?.data.map((rack) => (
                  <option key={rack.id} value={rack.id}>
                    {rack.name} ({rack._count?.nodes ?? 0} nodes)
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Hostname" hint="Lowercase letters, digits and hyphens. Must be unique.">
              <input
                value={hostname}
                pattern="[a-z0-9][a-z0-9-]*"
                onChange={(e) => setHostname(e.target.value)}
                required
              />
            </Field>

            <Field label="CPU">
              <input value={cpu} onChange={(e) => setCpu(e.target.value)} required />
            </Field>

            <Field label="Memory (MB)">
              <input
                type="number"
                min={1}
                value={memoryMb}
                onChange={(e) => setMemoryMb(Number(e.target.value))}
                required
              />
            </Field>

            <h3 className="sub">GPUs ({gpus.length} of 8)</h3>
            {gpus.map((gpu, index) => (
              <div className="gpu-row" key={index}>
                <input
                  aria-label="vendor"
                  value={gpu.vendor}
                  onChange={(e) => updateGpu(index, { vendor: e.target.value })}
                />
                <input
                  aria-label="model"
                  value={gpu.model}
                  onChange={(e) => updateGpu(index, { model: e.target.value })}
                />
                <input
                  aria-label="memory in MB"
                  type="number"
                  min={1}
                  value={gpu.memoryMb}
                  onChange={(e) => updateGpu(index, { memoryMb: Number(e.target.value) })}
                />
                <input
                  aria-label="serial number"
                  value={gpu.serialNumber}
                  onChange={(e) => updateGpu(index, { serialNumber: e.target.value })}
                />
                <button
                  type="button"
                  className="btn btn-ghost small"
                  onClick={() => setGpus((current) => current.filter((_, i) => i !== index))}
                >
                  remove
                </button>
              </div>
            ))}

            <div className="row gap wrap">
              <button
                type="button"
                className="btn btn-ghost small"
                disabled={gpus.length >= 8}
                onClick={() => setGpus((current) => [...current, emptyGpu(current.length)])}
              >
                Add GPU
              </button>
              <button
                type="button"
                className="btn btn-ghost small"
                onClick={() =>
                  setGpus((current) =>
                    current.length === 0
                      ? [{ ...emptyGpu(0), serialNumber: SEEDED_SERIAL }]
                      : current.map((gpu, i) =>
                          i === 0 ? { ...gpu, serialNumber: SEEDED_SERIAL } : gpu,
                        ),
                  )
                }
              >
                Use a duplicate serial
              </button>
            </div>
            <p className="muted small">
              “Use a duplicate serial” sets the first GPU to <code>{SEEDED_SERIAL}</code>, which is
              already seeded. The unique constraint fires inside the provisioning transaction, so
              the node <em>and</em> its GPUs roll back together — you get no half-built node.
            </p>

            <button type="submit" className="btn btn-primary block" disabled={!mayWrite || busy}>
              {busy ? 'Submitting…' : 'Provision (async)'}
            </button>
          </form>

          {error ? <ErrorBanner error={error} /> : null}
        </Card>

        <Card title="Job">
          {accepted ? (
            <>
              <div className="banner banner-ok">
                <strong>202 Accepted</strong>
                <p className="small">
                  The HTTP request is already finished. Poll target:{' '}
                  <code>GET {accepted.poll}</code>
                </p>
              </div>
              <JobWatcher jobId={accepted.jobId} />
            </>
          ) : (
            <Empty>Submit the form to watch a job run end to end.</Empty>
          )}
        </Card>
      </div>
    </>
  );
}
