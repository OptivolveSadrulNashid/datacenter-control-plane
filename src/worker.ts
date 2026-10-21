import { logger } from './logger.js';
import { prisma } from './prisma.js';
import { AUDIT_QUEUE, JOB_QUEUE, closeQueue, consume, initQueue } from './queue.js';
import { jobMessageSchema, provisionNode } from './services/provisioningService.js';

/**
 * Two independent consumers in one process, kept separate on purpose:
 *
 *  - the job consumer executes commands ("provision this node");
 *  - the audit consumer reacts to events ("a node was provisioned").
 *
 * Nothing in the API calls either of them directly. Adding a billing or
 * notification consumer later means binding a new queue to the event exchange
 * and touching no existing code.
 */
async function main(): Promise<void> {
  await initQueue();

  await consume(
    JOB_QUEUE,
    async (payload, msg) => {
      const message = jobMessageSchema.parse(payload);
      const log = logger.child({
        jobId: message.jobId,
        correlationId: msg.properties.correlationId ?? null,
      });
      log.info('job received');
      await provisionNode(message);
    },
    // One job at a time per worker: provisioning is the slow part, so throughput
    // comes from running more worker replicas, not from buffering work in one.
    { prefetch: 1 },
  );

  await consume(AUDIT_QUEUE, async (payload) => {
    const event = payload as { type?: string };
    logger.info({ event }, `event observed: ${event.type ?? 'unknown'}`);
  });

  logger.info({ queues: [JOB_QUEUE, AUDIT_QUEUE] }, 'worker consuming');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'worker shutting down');
    await closeQueue();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
