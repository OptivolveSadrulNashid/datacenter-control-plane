/**
 * Hand-written mirrors of the API's response shapes. Deliberately not generated:
 * the API surface is small and stable, and a hand-written file documents which
 * fields the UI actually depends on.
 *
 * Enums match `prisma/schema.prisma`.
 */

export const NODE_STATUSES = [
  'CREATED',
  'PROVISIONING',
  'ACTIVE',
  'MAINTENANCE',
  'FAILED',
  'RETIRED',
] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

export const GPU_HEALTHS = ['HEALTHY', 'DEGRADED', 'FAILED'] as const;
export type GpuHealth = (typeof GPU_HEALTHS)[number];

export type JobStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
export type Role = 'ADMIN' | 'OPERATOR' | 'VIEWER';

/** A job status nothing will move away from — the signal to stop polling. */
export function isTerminalJobStatus(status: JobStatus): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED';
}

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
}

export interface LoginResponse {
  token: string;
  user: AuthUser;
}

export interface Cluster {
  id: string;
  name: string;
  location: string;
  createdAt: string;
  updatedAt: string;
}

export interface Rack {
  id: string;
  clusterId: string;
  name: string;
  createdAt: string;
  /** Present on list responses, which include a filtered relation count. */
  _count?: { nodes: number };
}

/** `GET /clusters/:id` includes its racks. */
export interface ClusterDetail extends Cluster {
  racks: Rack[];
}

export interface Gpu {
  id: string;
  nodeId: string | null;
  vendor: string;
  model: string;
  memoryMb: number;
  serialNumber: string;
  healthStatus: GpuHealth;
  createdAt: string;
}

export interface Node {
  id: string;
  rackId: string;
  hostname: string;
  status: NodeStatus;
  cpu: string;
  memoryMb: number;
  /** The optimistic-locking token. Every status change must echo it back. */
  version: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  _count?: { gpus: number };
}

/**
 * `GET /nodes/:id` and `PATCH /nodes/:id/status` both return the legal next
 * states, so the UI never has to hardcode the lifecycle graph.
 */
export interface NodeDetail extends Node {
  allowedTransitions: NodeStatus[];
  gpus?: Gpu[];
  rack?: Rack & { cluster?: Cluster };
}

/** `PATCH /nodes/:id/status` — the node plus where it came from. */
export interface StatusChangeResponse extends Node {
  previousStatus: NodeStatus;
  allowedTransitions: NodeStatus[];
}

export interface LifecycleEvent {
  id: string;
  nodeId: string;
  eventType: string;
  oldStatus: NodeStatus | null;
  newStatus: NodeStatus;
  actor: string;
  reason: string | null;
  createdAt: string;
}

export interface Job {
  id: string;
  nodeId: string | null;
  action: 'PROVISION_NODE' | 'DECOMMISSION_NODE';
  status: JobStatus;
  payload: unknown;
  retries: number;
  error: string | null;
  actor: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The 202 body from `POST /nodes`. */
export interface EnqueuedJob {
  jobId: string;
  status: JobStatus;
  action: string;
  poll: string;
}

export interface GpuInput {
  vendor: string;
  model: string;
  memoryMb: number;
  serialNumber: string;
}

export interface ProvisionInput {
  rackId: string;
  hostname: string;
  cpu: string;
  memoryMb: number;
  gpus: GpuInput[];
}

/** Every list endpoint is keyset-paginated through this envelope. */
export interface Page<T> {
  data: T[];
  page: { limit: number; hasMore: boolean; nextCursor: string | null };
}

/** `details` payload of a 409 VERSION_CONFLICT. */
export interface VersionConflictDetails {
  expectedVersion: number;
  currentVersion: number;
}

/** `details` payload of a 422 INVALID_TRANSITION. */
export interface InvalidTransitionDetails {
  from: NodeStatus;
  to: NodeStatus;
  allowed: NodeStatus[];
}
