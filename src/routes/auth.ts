import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import { prisma } from '../prisma.js';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/login', async (req, reply) => {
    const { email, password } = loginSchema.parse(req.body);

    const user = await prisma.user.findUnique({ where: { email } });
    // Compare against a dummy hash when the user is unknown so the response
    // time doesn't reveal which emails exist.
    const hash = user?.passwordHash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
    const ok = await bcrypt.compare(password, hash);

    if (!user || !ok) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    }

    const token = app.jwt.sign({ sub: user.id, email: user.email, role: user.role });
    return reply.send({ token, user: { id: user.id, email: user.email, role: user.role } });
  });

  app.get('/auth/me', { preHandler: [app.authenticate] }, async (req) => req.user);
}
