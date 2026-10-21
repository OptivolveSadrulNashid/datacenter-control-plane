import { Role } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ConflictError, NotFoundError } from '../domain/errors.js';
import { keyset, pageQuerySchema, toPage } from '../http/pagination.js';
import { notDeleted, prisma } from '../prisma.js';

const idParam = z.object({ id: z.string().uuid() });

const createSchema = z.object({
  name: z.string().min(2).max(80),
  location: z.string().min(2).max(120),
});

const patchSchema = createSchema.partial().refine((v) => Object.keys(v).length > 0, {
  message: 'Provide at least one field to update',
});

export async function clusterRoutes(app: FastifyInstance): Promise<void> {
  app.post('/clusters', { preHandler: [app.authorize(Role.ADMIN)] }, async (req, reply) => {
    const body = createSchema.parse(req.body);
    const cluster = await prisma.cluster.create({ data: body });
    return reply.status(201).send(cluster);
  });

  app.get(
    '/clusters',
    { preHandler: [app.authorize(Role.ADMIN, Role.OPERATOR, Role.VIEWER)] },
    async (req) => {
      const query = pageQuerySchema.parse(req.query);
      const rows = await prisma.cluster.findMany({ where: notDeleted, ...keyset(query) });
      return toPage(rows, query.limit);
    },
  );

  app.get(
    '/clusters/:id',
    { preHandler: [app.authorize(Role.ADMIN, Role.OPERATOR, Role.VIEWER)] },
    async (req) => {
      const { id } = idParam.parse(req.params);
      const cluster = await prisma.cluster.findFirst({
        where: { id, ...notDeleted },
        include: {
          racks: {
            where: notDeleted,
            include: { _count: { select: { nodes: { where: notDeleted } } } },
          },
        },
      });
      if (!cluster) throw new NotFoundError('Cluster', id);
      return cluster;
    },
  );

  app.patch('/clusters/:id', { preHandler: [app.authorize(Role.ADMIN)] }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = patchSchema.parse(req.body);

    const existing = await prisma.cluster.findFirst({ where: { id, ...notDeleted } });
    if (!existing) throw new NotFoundError('Cluster', id);

    return prisma.cluster.update({ where: { id }, data: body });
  });

  app.delete('/clusters/:id', { preHandler: [app.authorize(Role.ADMIN)] }, async (req, reply) => {
    const { id } = idParam.parse(req.params);

    const cluster = await prisma.cluster.findFirst({
      where: { id, ...notDeleted },
      include: { _count: { select: { racks: { where: notDeleted } } } },
    });
    if (!cluster) throw new NotFoundError('Cluster', id);
    if (cluster._count.racks > 0) {
      throw new ConflictError('Cluster still has racks — remove them first', {
        rackCount: cluster._count.racks,
      });
    }

    await prisma.cluster.update({ where: { id }, data: { deletedAt: new Date() } });
    return reply.status(204).send();
  });
}
