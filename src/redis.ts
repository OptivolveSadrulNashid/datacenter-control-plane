import { Redis } from 'ioredis';
import { config } from './config.js';

export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: false,
});
