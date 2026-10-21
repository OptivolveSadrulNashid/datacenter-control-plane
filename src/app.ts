import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { registerAuth } from './auth/plugin.js';
import { config } from './config.js';
import { registerErrorHandler } from './http/errorHandler.js';
import { logger } from './logger.js';
import { redis } from './redis.js';
import { authRoutes } from './routes/auth.js';
import { clusterRoutes } from './routes/clusters.js';
import { gpuRoutes } from './routes/gpus.js';
import { healthRoutes } from './routes/health.js';
import { jobRoutes } from './routes/jobs.js';
import { nodeRoutes } from './routes/nodes.js';
import { rackRoutes } from './routes/racks.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    // Widened to Fastify's logger interface so the instance keeps its default
    // generics and route handlers stay assignable to plain FastifyInstance.
    loggerInstance: logger as FastifyBaseLogger,
    // Trust an inbound correlation id so one request can be traced across the
    // API, the worker and the logs of both.
    genReqId: (req) => (req.headers['x-correlation-id'] as string) ?? randomUUID(),
    requestIdHeader: 'x-correlation-id',
    requestIdLogLabel: 'correlationId',
    bodyLimit: 1_048_576,
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-correlation-id', req.id);
  });

  // Redis-backed so the limit is shared across every API replica rather than
  // being per-process (which would multiply the real limit by the replica count).
  //
  // Keyed by IP, not by user: this hook runs at onRequest, before the JWT is
  // verified, so there is no trustworthy identity yet. Bucketing on an
  // unverified token's `sub` would let a forged token burn a real user's quota.
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW,
    redis,
    keyGenerator: (req) => req.ip,
    nameSpace: 'icp:rl:',
  });

  await registerAuth(app);
  registerErrorHandler(app);

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(clusterRoutes);
  await app.register(rackRoutes);
  await app.register(nodeRoutes);
  await app.register(gpuRoutes);
  await app.register(jobRoutes);

  return app;
}
