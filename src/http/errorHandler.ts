import { Prisma } from '@prisma/client';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from '../domain/errors.js';

interface ErrorBody {
  error: { code: string; message: string; details?: unknown; correlationId: string };
}

function body(
  code: string,
  message: string,
  correlationId: string,
  details?: unknown,
): ErrorBody {
  return { error: { code, message, correlationId, ...(details === undefined ? {} : { details }) } };
}

/**
 * One place that turns every failure mode into the same JSON envelope, so
 * clients never have to guess whether a 4xx came from Zod, Prisma or us.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    const correlationId = req.id;

    if (err instanceof AppError) {
      req.log.info({ code: err.code, statusCode: err.statusCode }, 'request rejected');
      return reply.status(err.statusCode).send(body(err.code, err.message, correlationId, err.details));
    }

    if (err instanceof ZodError) {
      return reply.status(400).send(
        body(
          'VALIDATION_ERROR',
          'Request payload failed validation',
          correlationId,
          err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        ),
      );
    }

    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      // P2002 unique violation, P2003 FK violation, P2025 record not found.
      if (err.code === 'P2002') {
        const target = (err.meta?.['target'] as string[] | undefined)?.join(', ') ?? 'field';
        return reply
          .status(409)
          .send(body('DUPLICATE', `A record with that ${target} already exists`, correlationId));
      }
      if (err.code === 'P2003' || err.code === 'P2025') {
        return reply
          .status(404)
          .send(body('NOT_FOUND', 'A referenced record does not exist', correlationId));
      }
    }

    if (err.statusCode === 401 || err.code?.startsWith('FST_JWT')) {
      return reply
        .status(401)
        .send(body('UNAUTHORIZED', 'Missing or invalid bearer token', correlationId));
    }

    if (err.statusCode === 429) {
      return reply
        .status(429)
        .send(body('RATE_LIMITED', err.message, correlationId));
    }

    if (err.statusCode && err.statusCode < 500) {
      return reply
        .status(err.statusCode)
        .send(body(err.code ?? 'BAD_REQUEST', err.message, correlationId));
    }

    req.log.error({ err }, 'unhandled error');
    return reply
      .status(500)
      .send(body('INTERNAL_ERROR', 'An unexpected error occurred', correlationId));
  });

  app.setNotFoundHandler((req, reply) => {
    reply
      .status(404)
      .send(body('ROUTE_NOT_FOUND', `${req.method} ${req.url} is not a route`, req.id));
  });
}
