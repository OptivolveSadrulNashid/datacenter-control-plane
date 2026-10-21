import type { ReactElement } from 'react';

/**
 * One badge for every enum in the system. The colour carries the meaning:
 * green = settled and healthy, amber = in flight, red = broken, grey = inert.
 */
const TONE: Record<string, string> = {
  // NodeStatus
  CREATED: 'grey',
  PROVISIONING: 'amber',
  ACTIVE: 'green',
  MAINTENANCE: 'blue',
  FAILED: 'red',
  RETIRED: 'grey',
  // JobStatus
  QUEUED: 'grey',
  RUNNING: 'amber',
  SUCCEEDED: 'green',
  // GpuHealth
  HEALTHY: 'green',
  DEGRADED: 'amber',
  // Role
  ADMIN: 'purple',
  OPERATOR: 'blue',
  VIEWER: 'grey',
};

export function StatusBadge({ value }: { value: string }): ReactElement {
  return <span className={`badge badge-${TONE[value] ?? 'grey'}`}>{value}</span>;
}
