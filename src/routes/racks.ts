import { Role } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotFoundError } from '../domain/errors.js';
import { keyset, pageQuerySchema, toPage } from '../http/pagination.js';
import { notDeleted, prisma } from '../prisma.js';

const createSchema = z.object({
  clusterId: z.string().uuid(),
  name: z.string().min(1).max(60),
});

const listQuerySchema = pageQuerySchema.extend({
  clusterId: z.string().uuid().optional(),
});

export async function rackRoutes(app: FastifyInstance): Promise<void> {
  app.post('/racks', { preHandler: [app.authorize(Role.ADMIN)] }, async (req, reply) => {
    const body = createSchema.parse(req.body);

    const cluster = await prisma.cluster.findFirst({ where: { id: body.clusterId, ...notDeleted } });
    if (!cluster) throw new NotFoundError('Cluster', body.clusterId);

    const rack = await prisma.rack.create({ data: body });
    return reply.status(201).send(rack);
  });

  app.get(
    '/racks',
    { preHandler: [app.authorize(Role.ADMIN, Role.OPERATOR, Role.VIEWER)] },
    async (req) => {
      const { clusterId, ...page } = listQuerySchema.parse(req.query);
      const rows = await prisma.rack.findMany({
        where: { ...notDeleted, ...(clusterId ? { clusterId } : {}) },
        include: { _count: { select: { nodes: { where: notDeleted } } } },
        ...keyset(page),
      });
      return toPage(rows, page.limit);
    },
  );
}
