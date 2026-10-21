import { JobAction, type Job } from '@prisma/client';
import { prisma } from '../prisma.js';
import { NotFoundError } from '../domain/errors.js';
import { RoutingKey, publishCommand } from '../queue.js';
import type { ProvisionPayload } from './provisioningService.js';

/**
 * Accepting work is two steps in a deliberate order: persist the job first, then
 * publish. If the publish fails the job row still exists as QUEUED and can be
 * re-dispatched; publishing first would risk a worker picking up a job the API
 * never managed to record.
 */
export async function enqueueProvisionJob(input: {
  payload: ProvisionPayload;
  actor: string;
  correlationId?: string;
}): Promise<Job> {
  const job = await prisma.job.create({
    data: {
      action: JobAction.PROVISION_NODE,
      payload: input.payload,
      actor: input.actor,
    },
  });

  publishCommand(
    RoutingKey.ProvisionNode,
    { jobId: job.id, actor: input.actor, payload: input.payload },
    input.correlationId,
  );

  return job;
}

export async function getJob(id: string): Promise<Job> {
  const job = await prisma.job.findUnique({ where: { id } });
  if (!job) throw new NotFoundError('Job', id);
  return job;
}
