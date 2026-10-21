import { NodeStatus, Role } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorOf } from '../auth/plugin.js';
import { ALLOWED_TRANSITIONS } from '../domain/lifecycle.js';
import { keyset, pageQuerySchema, toPage } from '../http/pagination.js';
import { notDeleted, prisma } from '../prisma.js';
import { enqueueProvisionJob } from '../services/jobService.js';
import {
  getNode,
  getNodeHistory,
  retireAndSoftDeleteNode,
  updateNodeStatus,
} from '../services/nodeService.js';
import { provisionPayloadSchema } from '../services/provisioningService.js';

const idParam = z.object({ id: z.string().uuid() });

const listQuerySchema = pageQuerySchema.extend({
  status: z.nativeEnum(NodeStatus).optional(),
  rackId: z.string().uuid().optional(),
  hostname: z.string().optional(),
});

const statusSchema = z.object({
  status: z.nativeEnum(NodeStatus),
  /** The version the client last read. This is what makes the write safe. */
  version: z.number().int().positive(),
  reason: z.string().max(500).optional(),
});

export async function nodeRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Asynchronous by design. Real provisioning takes minutes, so the API records
   * the intent, hands it to the queue and answers 202 immediately with a job to
   * poll. The HTTP request is never held open waiting on hardware.
   */
  app.post('/nodes', { preHandler: [app.authorize(Role.ADMIN, Role.OPERATOR)] }, async (req, reply) => {
    const payload = provisionPayloadSchema.parse(req.body);

    const job = await enqueueProvisionJob({
      payload,
      actor: actorOf(req),
      correlationId: req.id,
    });

    return reply
      .status(202)
      .header('location', `/jobs/${job.id}`)
      .send({
        jobId: job.id,
        status: job.status,
        action: job.action,
        poll: `/jobs/${job.id}`,
      });
  });

  app.get(
    '/nodes',
    { preHandler: [app.authorize(Role.ADMIN, Role.OPERATOR, Role.VIEWER)] },
    async (req) => {
      const { status, rackId, hostname, ...page } = listQuerySchema.parse(req.query);
      const rows = await prisma.node.findMany({
        where: {
          ...notDeleted,
          ...(status ? { status } : {}),
          ...(rackId ? { rackId } : {}),
          ...(hostname ? { hostname: { contains: hostname } } : {}),
        },
        include: { _count: { select: { gpus: { where: notDeleted } } } },
        ...keyset(page),
      });
      return toPage(rows, page.limit);
    },
  );

  app.get(
    '/nodes/:id',
    { preHandler: [app.authorize(Role.ADMIN, Role.OPERATOR, Role.VIEWER)] },
    async (req) => {
      const { id } = idParam.parse(req.params);
      const node = await getNode(id);
      return { ...node, allowedTransitions: ALLOWED_TRANSITIONS[node.status] };
    },
  );

  /**
   * Optimistic locking in one endpoint: the client sends the `version` it read,
   * and a concurrent writer that got there first turns this into a 409 rather
   * than a silently lost update.
   */
  app.patch(
    '/nodes/:id/status',
    { preHandler: [app.authorize(Role.ADMIN, Role.OPERATOR)] },
    async (req) => {
      const { id } = idParam.parse(req.params);
      const body = statusSchema.parse(req.body);

      const { node, from } = await updateNodeStatus({
        id,
        to: body.status,
        expectedVersion: body.version,
        actor: actorOf(req),
        reason: body.reason,
      });

      return { ...node, previousStatus: from, allowedTransitions: ALLOWED_TRANSITIONS[node.status] };
    },
  );

  app.get(
    '/nodes/:id/history',
    { preHandler: [app.authorize(Role.ADMIN, Role.OPERATOR, Role.VIEWER)] },
    async (req) => {
      const { id } = idParam.parse(req.params);
      return { nodeId: id, events: await getNodeHistory(id) };
    },
  );

  app.delete('/nodes/:id', { preHandler: [app.authorize(Role.ADMIN)] }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    await retireAndSoftDeleteNode(id, actorOf(req));
    return reply.status(204).send();
  });
}
