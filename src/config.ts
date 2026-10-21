import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  RABBITMQ_URL: z.string().min(1),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('1h'),

  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),

  /// How long the worker pretends hardware provisioning takes.
  PROVISION_DELAY_MS: z.coerce.number().int().nonnegative().default(2000),
  /// Fraction of provisioning attempts that fail, to exercise the FAILED path.
  PROVISION_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const config = parsed.data;
export type Config = typeof config;
