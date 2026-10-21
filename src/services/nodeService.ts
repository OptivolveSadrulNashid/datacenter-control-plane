import { NodeStatus, type Node, type Prisma } from '@prisma/client';
import { prisma, notDeleted } from '../prisma.js';
import { assertTransition } from '../domain/lifecycle.js';
import { ConflictError, NotFoundError, VersionConflictError } from '../domain/errors.js';
import { publishEvent } from '../queue.js';

/** Transaction-or-client, so helpers work inside and outside a transaction. */
export type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Appends to the audit trail. Never updates or deletes: the history of a node is
 * the sequence of these rows, and it is the only record of where a node has been.
 */
export async function recordLifecycleEvent(
  db: Db,
  input: {
    nodeId: string;
    eventType: string;
    oldStatus: NodeStatus | null;
    newStatus: NodeStatus;
    actor: string;
    reason?: string | undefined;
  },
) {
  return db.lifecycleEvent.create({
    data: {
      nodeId: input.nodeId,
      eventType: input.eventType,
      oldStatus: input.oldStatus,
      newStatus: input.newStatus,
      actor: input.actor,
      reason: input.reason ?? null,
    },
  });
}

export async function getNode(id: string) {
  const node = await prisma.node.findFirst({
    where: { id, ...notDeleted },
    include: { gpus: { where: notDeleted }, rack: { include: { cluster: true } } },
  });
  if (!node) throw new NotFoundError('Node', id);
  return node;
}

/**
 * Moves a node to a new status under optimistic locking.
 *
 * Three things have to hold, and all three are checked inside one transaction so
 * the audit event and the status change either both land or neither does:
 *   1. the node still exists and is not soft-deleted;
 *   2. the caller's `expectedVersion` is still the current version;
 *   3. the transition is legal per the lifecycle state machine.
 *
 * The real guard is the `version` predicate in the UPDATE. If a concurrent
 * request committed first, the UPDATE matches zero rows and we surface 409
 * instead of silently overwriting the other engineer's change.
 */
export async function updateNodeStatus(input: {
  id: string;
  to: NodeStatus;
  expectedVersion: number;
  actor: string;
  reason?: string | undefined;
}): Promise<{ node: Node; from: NodeStatus }> {
  const result = await prisma.$transaction(async (tx) => {
    const node = await tx.node.findFirst({ where: { id: input.id, ...notDeleted } });
    if (!node) throw new NotFoundError('Node', input.id);

    if (node.version !== input.expectedVersion) {
      throw new VersionConflictError(input.expectedVersion, node.version);
    }

    assertTransition(node.status, input.to);

    const updated = await tx.node.updateMany({
      where: { id: input.id, version: input.expectedVersion, ...notDeleted },
      data: { status: input.to, version: { increment: 1 } },
    });

    if (updated.count === 0) {
      // Lost the race between the read above and this write.
      const current = await tx.node.findUnique({ where: { id: input.id } });
      throw new VersionConflictError(input.expectedVersion, current?.version ?? -1);
    }

    await recordLifecycleEvent(tx, {
      nodeId: input.id,
      eventType: 'STATUS_CHANGED',
      oldStatus: node.status,
      newStatus: input.to,
      actor: input.actor,
      reason: input.reason,
    });

    const fresh = await tx.node.findUniqueOrThrow({ where: { id: input.id } });
    return { node: fresh, from: node.status };
  });

  // Published after commit: no consumer should ever see an event for a
  // transaction that later rolled back.
  publishEvent({
    type: 'NodeStatusChanged',
    nodeId: result.node.id,
    from: result.from,
    to: result.node.status,
    actor: input.actor,
  });

  return result;
}

/**
 * Soft delete. The row stays so its lifecycle history and any GPU serial numbers
 * remain auditable, and an admin can restore it later.
 */
export async function retireAndSoftDeleteNode(id: string, actor: string) {
  return prisma.$transaction(async (tx) => {
    const node = await tx.node.findFirst({ where: { id, ...notDeleted } });
    if (!node) throw new NotFoundError('Node', id);

    if (node.status !== NodeStatus.RETIRED) {
      assertTransition(node.status, NodeStatus.RETIRED);
      await recordLifecycleEvent(tx, {
        nodeId: id,
        eventType: 'RETIRED',
        oldStatus: node.status,
        newStatus: NodeStatus.RETIRED,
        actor,
        reason: 'Node deleted via API',
      });
    }

    // Detach hardware so the GPUs return to the free inventory pool.
    await tx.gpu.updateMany({ where: { nodeId: id }, data: { nodeId: null } });

    return tx.node.update({
      where: { id },
      data: { status: NodeStatus.RETIRED, deletedAt: new Date(), version: { increment: 1 } },
    });
  });
}

export async function getNodeHistory(id: string) {
  // Deliberately not filtered by deletedAt: history outlives the node.
  const node = await prisma.node.findUnique({ where: { id }, select: { id: true } });
  if (!node) throw new NotFoundError('Node', id);
  return prisma.lifecycleEvent.findMany({
    where: { nodeId: id },
    orderBy: { createdAt: 'asc' },
  });
}

export async function assertRackExists(db: Db, rackId: string) {
  const rack = await db.rack.findFirst({ where: { id: rackId, ...notDeleted } });
  if (!rack) throw new NotFoundError('Rack', rackId);
  return rack;
}

export async function assertHostnameFree(db: Db, hostname: string) {
  const existing = await db.node.findUnique({ where: { hostname } });
  if (existing) throw new ConflictError(`Hostname ${hostname} is already in use`);
}
