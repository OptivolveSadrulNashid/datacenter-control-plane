import { JobStatus, NodeStatus } from '@prisma/client';
import { z } from 'zod';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { prisma } from '../prisma.js';
import { publishEvent } from '../queue.js';
import {
  assertHostnameFree,
  assertRackExists,
  recordLifecycleEvent,
  updateNodeStatus,
} from './nodeService.js';

export const provisionPayloadSchema = z.object({
  rackId: z.string().uuid(),
  hostname: z
    .string()
    .min(3)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'hostname must be lowercase alphanumeric with dashes'),
  cpu: z.string().min(1).max(120),
  memoryMb: z.number().int().positive(),
  gpus: z
    .array(
      z.object({
        vendor: z.string().min(1).max(60),
        model: z.string().min(1).max(60),
        memoryMb: z.number().int().positive(),
        serialNumber: z.string().min(3).max(60),
      }),
    )
    .max(8)
    .default([]),
});

export type ProvisionPayload = z.infer<typeof provisionPayloadSchema>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The job body arrives from a queue, so it has crossed a process boundary and is
 * untrusted no matter who enqueued it — validate again on the way in.
 */
export const jobMessageSchema = z.object({
  jobId: z.string().uuid(),
  actor: z.string().min(1),
  payload: provisionPayloadSchema,
});

/**
 * Provisioning a node is four writes that must agree: the node row, its GPUs,
 * its audit events, and the job outcome.
 *
 * Step 1 puts node + GPUs + audit events in ONE transaction — the doc's failure
 * case (node exists, GPU doesn't) is impossible because a failed GPU insert
 * rolls the node back with it.
 *
 * Step 2, the slow "talk to hardware" part, runs OUTSIDE any transaction. Holding
 * a Postgres transaction open for ten minutes would pin a connection and block
 * vacuum; instead the node sits in PROVISIONING, visible to readers, until the
 * work resolves either way.
 */
export async function provisionNode(input: {
  jobId: string;
  actor: string;
  payload: ProvisionPayload;
}): Promise<void> {
  const { jobId, actor, payload } = input;
  const log = logger.child({ jobId, hostname: payload.hostname });

  await prisma.job.update({
    where: { id: jobId },
    data: { status: JobStatus.RUNNING, startedAt: new Date() },
  });

  let nodeId: string;
  try {
    // ---- Step 1: atomic inventory write -------------------------------------
    const node = await prisma.$transaction(async (tx) => {
      await assertRackExists(tx, payload.rackId);
      await assertHostnameFree(tx, payload.hostname);

      const created = await tx.node.create({
        data: {
          rackId: payload.rackId,
          hostname: payload.hostname,
          cpu: payload.cpu,
          memoryMb: payload.memoryMb,
          status: NodeStatus.CREATED,
        },
      });

      await recordLifecycleEvent(tx, {
        nodeId: created.id,
        eventType: 'CREATED',
        oldStatus: null,
        newStatus: NodeStatus.CREATED,
        actor,
        reason: `Created by job ${jobId}`,
      });

      if (payload.gpus.length > 0) {
        // A duplicate serial number here aborts the whole transaction, taking
        // the node row with it. No half-built node is ever visible.
        await tx.gpu.createMany({
          data: payload.gpus.map((gpu) => ({ ...gpu, nodeId: created.id })),
        });
      }

      const moved = await tx.node.update({
        where: { id: created.id },
        data: { status: NodeStatus.PROVISIONING, version: { increment: 1 } },
      });

      await recordLifecycleEvent(tx, {
        nodeId: created.id,
        eventType: 'PROVISIONING_STARTED',
        oldStatus: NodeStatus.CREATED,
        newStatus: NodeStatus.PROVISIONING,
        actor,
      });

      await tx.job.update({ where: { id: jobId }, data: { nodeId: created.id } });
      return moved;
    });

    nodeId = node.id;

    for (const gpu of payload.gpus) {
      const attached = await prisma.gpu.findUnique({ where: { serialNumber: gpu.serialNumber } });
      if (attached) {
        publishEvent({
          type: 'GpuAttached',
          gpuId: attached.id,
          nodeId,
          serialNumber: attached.serialNumber,
          actor,
        });
      }
    }

    // ---- Step 2: the slow part, deliberately outside the transaction --------
    await sleep(config.PROVISION_DELAY_MS);
    if (Math.random() < config.PROVISION_FAILURE_RATE) {
      throw new Error('Hardware agent did not respond in time');
    }

    // ---- Step 3: publish the outcome ---------------------------------------
    const activated = await updateNodeStatus({
      id: nodeId,
      to: NodeStatus.ACTIVE,
      expectedVersion: node.version,
      actor,
      reason: `Provisioned by job ${jobId}`,
    });

    await prisma.job.update({
      where: { id: jobId },
      data: { status: JobStatus.SUCCEEDED, finishedAt: new Date() },
    });

    publishEvent({
      type: 'NodeProvisioned',
      nodeId: activated.node.id,
      hostname: activated.node.hostname,
      jobId,
      actor,
    });

    log.info({ nodeId }, 'node provisioned');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'provisioning failed');

    await markJobFailed(jobId, reason);

    // If the node row made it in, park it in FAILED rather than leaving it
    // stuck in PROVISIONING forever.
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (job?.nodeId) {
      const current = await prisma.node.findUnique({ where: { id: job.nodeId } });
      if (current && current.status === NodeStatus.PROVISIONING) {
        await updateNodeStatus({
          id: current.id,
          to: NodeStatus.FAILED,
          expectedVersion: current.version,
          actor,
          reason,
        }).catch((e) => log.error({ err: e }, 'could not mark node FAILED'));
      }
    }

    publishEvent({ type: 'NodeProvisioningFailed', jobId, reason, actor });
  }
}

async function markJobFailed(jobId: string, reason: string): Promise<void> {
  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: JobStatus.FAILED,
      error: reason.slice(0, 500),
      retries: { increment: 1 },
      finishedAt: new Date(),
    },
  });
}
