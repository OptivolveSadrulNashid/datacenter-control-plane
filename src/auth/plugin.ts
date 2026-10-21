import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Role } from '@prisma/client';
import { config } from '../config.js';
import { ForbiddenError } from '../domain/errors.js';

export interface TokenPayload {
  sub: string;
  email: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** `preHandler` that rejects anything without a valid bearer token. */
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** `preHandler` factory that additionally requires one of `roles`. */
    authorize: (
      ...roles: Role[]
    ) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: TokenPayload;
    user: TokenPayload;
  }
}

export async function registerAuth(app: FastifyInstance): Promise<void> {
  await app.register(fastifyJwt, {
    secret: config.JWT_SECRET,
    sign: { expiresIn: config.JWT_EXPIRES_IN },
  });

  app.decorate('authenticate', async (req: FastifyRequest) => {
    // jwtVerify throws a Fastify JWT error, which the error handler maps to 401.
    await req.jwtVerify();
  });

  app.decorate('authorize', (...roles: Role[]) => async (req: FastifyRequest) => {
    await req.jwtVerify();
    if (!roles.includes(req.user.role)) {
      throw new ForbiddenError(roles, req.user.role);
    }
  });
}

/** Who to record in the audit trail for this request. */
export function actorOf(req: FastifyRequest): string {
  return req.user?.email ?? 'system';
}
