import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: process.env.SERVICE_NAME ?? 'api' },
  redact: ['req.headers.authorization', 'password', '*.passwordHash'],
  ...(config.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }
    : {}),
});
