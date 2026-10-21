import { buildApp } from './app.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { prisma } from './prisma.js';
import { closeQueue, initQueue } from './queue.js';
import { redis } from './redis.js';

async function main(): Promise<void> {
  await initQueue();
  const app = await buildApp();

  await app.listen({ port: config.PORT, host: config.HOST });
  logger.info({ port: config.PORT }, 'api listening');

  // Drain in-flight requests before dropping the connections they depend on,
  // so a rolling deploy never returns a 500 to a request already accepted.
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    try {
      await app.close();
      await closeQueue();
      await prisma.$disconnect();
      redis.disconnect();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'unclean shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'api failed to start');
  process.exit(1);
});
