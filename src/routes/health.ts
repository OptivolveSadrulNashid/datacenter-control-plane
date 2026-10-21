import type { FastifyInstance } from 'fastify';
import { prisma } from '../prisma.js';
import { redis } from '../redis.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  /** Liveness: is the process up? Cheap, no dependencies. */
  app.get('/healthz', async () => ({ status: 'ok' }));

  /** Readiness: can this instance actually serve traffic right now? */
  app.get('/readyz', async (_req, reply) => {
    const checks = await Promise.allSettled([
      prisma.$queryRaw`SELECT 1`,
      redis.ping(),
    ]);

    const [db, cache] = checks.map((c) => (c.status === 'fulfilled' ? 'up' : 'down'));
    const ready = db === 'up' && cache === 'up';

    return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'degraded', db, cache });
  });
}
