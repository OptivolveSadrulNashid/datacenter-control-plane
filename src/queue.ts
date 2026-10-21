import amqplib, { type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib';
import { config } from './config.js';
import { logger } from './logger.js';

/** Commands: "do this piece of work". Routed directly to the worker queue. */
export const COMMAND_EXCHANGE = 'icp.commands';
/** Events: "this happened". Fan out to any number of independent consumers. */
export const EVENT_EXCHANGE = 'icp.events';

export const JOB_QUEUE = 'icp.jobs';
export const AUDIT_QUEUE = 'icp.events.audit';

export const RoutingKey = {
  ProvisionNode: 'job.provision_node',
  DecommissionNode: 'job.decommission_node',
} as const;

export type DomainEvent =
  | { type: 'NodeProvisioned'; nodeId: string; hostname: string; jobId: string; actor: string }
  | { type: 'NodeProvisioningFailed'; jobId: string; reason: string; actor: string }
  | { type: 'NodeStatusChanged'; nodeId: string; from: string; to: string; actor: string }
  | { type: 'GpuAttached'; gpuId: string; nodeId: string; serialNumber: string; actor: string };

let connection: ChannelModel | null = null;
let channel: Channel | null = null;

/**
 * Declares the topology and returns a shared channel. Topology declaration is
 * idempotent, so both the API and the worker can safely call this on boot and
 * neither has to start before the other.
 */
export async function initQueue(): Promise<Channel> {
  if (channel) return channel;

  connection = await amqplib.connect(config.RABBITMQ_URL);
  connection.on('error', (err) => logger.error({ err }, 'rabbitmq connection error'));
  connection.on('close', () => logger.warn('rabbitmq connection closed'));

  const ch = await connection.createChannel();
  await ch.assertExchange(COMMAND_EXCHANGE, 'direct', { durable: true });
  await ch.assertExchange(EVENT_EXCHANGE, 'topic', { durable: true });

  await ch.assertQueue(JOB_QUEUE, { durable: true });
  for (const key of Object.values(RoutingKey)) {
    await ch.bindQueue(JOB_QUEUE, COMMAND_EXCHANGE, key);
  }

  await ch.assertQueue(AUDIT_QUEUE, { durable: true });
  await ch.bindQueue(AUDIT_QUEUE, EVENT_EXCHANGE, '#');

  channel = ch;
  return ch;
}

export async function closeQueue(): Promise<void> {
  await channel?.close().catch(() => undefined);
  await connection?.close().catch(() => undefined);
  channel = null;
  connection = null;
}

function requireChannel(): Channel {
  if (!channel) throw new Error('Queue not initialised — call initQueue() first');
  return channel;
}

export function publishCommand(routingKey: string, body: unknown, correlationId?: string): void {
  requireChannel().publish(COMMAND_EXCHANGE, routingKey, Buffer.from(JSON.stringify(body)), {
    persistent: true,
    contentType: 'application/json',
    ...(correlationId ? { correlationId } : {}),
  });
}

/**
 * Publishers name what happened, not who should care. Adding a billing or
 * notification consumer later needs no change here.
 */
export function publishEvent(event: DomainEvent, correlationId?: string): void {
  const routingKey = `node.${event.type}`;
  requireChannel().publish(EVENT_EXCHANGE, routingKey, Buffer.from(JSON.stringify(event)), {
    persistent: true,
    contentType: 'application/json',
    ...(correlationId ? { correlationId } : {}),
  });
}

export async function consume(
  queue: string,
  handler: (payload: unknown, msg: ConsumeMessage) => Promise<void>,
  opts: { prefetch?: number } = {},
): Promise<void> {
  const ch = requireChannel();
  await ch.prefetch(opts.prefetch ?? 1);
  await ch.consume(queue, (msg) => {
    if (!msg) return;
    void (async () => {
      try {
        await handler(JSON.parse(msg.content.toString()), msg);
      } catch (err) {
        logger.error({ err, queue }, 'message handler threw');
      } finally {
        // The handler owns durable outcome recording (job row), so a message is
        // never redelivered on its own. Retries are deliberate, not accidental.
        ch.ack(msg);
      }
    })();
  });
}
