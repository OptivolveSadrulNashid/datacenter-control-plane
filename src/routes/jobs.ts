import { Role } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorOf } from '../auth/plugin.js';
import { enqueueProvisionJob, getJob } from '../services/jobService.js';
import { provisionPayloadSchema } from '../services/provisioningService.js';

const idParam = z.object({ id: z.string().uuid() });

const createSchema = z.object({
  action: z.literal('PROVISION_NODE'),
  payload: provisionPayloadSchema,
});

export async function jobRoutes(app: FastifyInstance): Promise<void> {
  app.post('/jobs', { preHandler: [app.authorize(Role.ADMIN, Role.OPERATOR)] }, async (req, reply) => {
    const body = createSchema.parse(req.body);

    const job = await enqueueProvisionJob({
      payload: body.payload,
      actor: actorOf(req),
      correlationId: req.id,
    });

    return reply.status(202).header('location', `/jobs/${job.id}`).send(job);
  });

  app.get(
    '/jobs/:id',
    { preHandler: [app.authorize(Role.ADMIN, Role.OPERATOR, Role.VIEWER)] },
    async (req) => {
      const { id } = idParam.parse(req.params);
      return getJob(id);
    },
  );
}
