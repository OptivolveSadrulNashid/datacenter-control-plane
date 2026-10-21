import { GpuHealth, NodeStatus, Role } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorOf } from '../auth/plugin.js';
import { ConflictError, NotFoundError } from '../domain/errors.js';
import { keyset, pageQuerySchema, toPage } from '../http/pagination.js';
import { notDeleted, prisma } from '../prisma.js';
import { publishEvent } from '../queue.js';

const createSchema = z.object({
  nodeId: z.string().uuid().optional(),
  vendor: z.string().min(1).max(60),
  model: z.string().min(1).max(60),
  memoryMb: z.number().int().positive(),
  serialNumber: z.string().min(3).max(60),
  healthStatus: z.nativeEnum(GpuHealth).default(GpuHealth.HEALTHY),
});

const listQuerySchema = pageQuerySchema.extend({
  vendor: z.string().optional(),
  healthStatus: z.nativeEnum(GpuHealth).optional(),
  nodeId: z.string().uuid().optional(),
  /**
   * `true` returns only spare inventory not attached to any node. Parsed from an
   * explicit literal rather than `z.coerce.boolean()`, which would read the
   * string "false" as true.
   */
  unassigned: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export async function gpuRoutes(app: FastifyInstance): Promise<void> {
  app.post('/gpus', { preHandler: [app.authorize(Role.ADMIN, Role.OPERATOR)] }, async (req, reply) => {
    const body = createSchema.parse(req.body);
    const actor = actorOf(req);

    const gpu = await prisma.$transaction(async (tx) => {
      if (body.nodeId) {
        const node = await tx.node.findFirst({ where: { id: body.nodeId, ...notDeleted } });
        if (!node) throw new NotFoundError('Node', body.nodeId);
        if (node.status === NodeStatus.RETIRED) {
          throw new ConflictError('Cannot attach hardware to a retired node');
        }
      }
      return tx.gpu.create({ data: body });
    });

    if (gpu.nodeId) {
      publishEvent(
        {
          type: 'GpuAttached',
          gpuId: gpu.id,
          nodeId: gpu.nodeId,
          serialNumber: gpu.serialNumber,
          actor,
        },
        req.id,
      );
    }

    return reply.status(201).send(gpu);
  });

  app.get(
    '/gpus',
    { preHandler: [app.authorize(Role.ADMIN, Role.OPERATOR, Role.VIEWER)] },
    async (req) => {
      const { vendor, healthStatus, nodeId, unassigned, ...page } = listQuerySchema.parse(req.query);
      const rows = await prisma.gpu.findMany({
        where: {
          ...notDeleted,
          ...(vendor ? { vendor } : {}),
          ...(healthStatus ? { healthStatus } : {}),
          ...(nodeId ? { nodeId } : {}),
          ...(unassigned ? { nodeId: null } : {}),
        },
        ...keyset(page),
      });
      return toPage(rows, page.limit);
    },
  );
}
