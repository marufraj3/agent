import { prisma } from '@alzeena/database';
import { Worker, UnrecoverableError } from 'bullmq';
import pino from 'pino';
import { createRedisConnection } from '../infrastructure/redis.js';
import { createQueueRegistry } from '../infrastructure/queue-registry.js';
import { startWorkerHeartbeat } from '../infrastructure/worker-heartbeat.js';
import { getMessengerConfig } from '../modules/channels/messenger/messenger.config.js';
import { MessengerSender } from '../modules/channels/messenger/messenger.sender.js';
import { MessengerFollowUpDeliveryProvider } from '../modules/automation/follow-up-delivery.js';
import { OrderService } from '../modules/orders/order.service.js';
import { WebsiteOrderApiClient } from '../modules/orders/website-order-api.client.js';
import { env } from '../config/env.js';
import { FOLLOW_UP_QUEUE_NAME, FOLLOW_UP_JOB_NAME, ABANDONMENT_SCAN_JOB, createFollowUpQueue } from '../modules/automation/follow-up.queue.js';
import { FollowUpService } from '../modules/automation/follow-up.service.js';

const CLEANUP_JOB = 'operations-retention-cleanup';
const logger = pino();
const connection = createRedisConnection();
const queue = createFollowUpQueue();
const service = new FollowUpService(prisma, queue, new MessengerFollowUpDeliveryProvider(new MessengerSender(getMessengerConfig())), new OrderService(prisma, new WebsiteOrderApiClient(env.ORDER_API_TIMEOUT_MS), logger));
await prisma.$connect();
await queue.upsertJobScheduler('abandoned-order-scan', { every: 5 * 60 * 1000 }, { name: ABANDONMENT_SCAN_JOB, data: {} });
await queue.upsertJobScheduler('operations-retention-cleanup', { every: 24 * 60 * 60 * 1000 }, { name: CLEANUP_JOB, data: {} });
const stopHeartbeat = startWorkerHeartbeat(connection, FOLLOW_UP_QUEUE_NAME);

async function cleanupRetention() {
  const now = new Date();
  const logBefore = new Date(now.getTime() - env.SYSTEM_LOG_RETENTION_DAYS * 86_400_000);
  const eventBefore = new Date(now.getTime() - env.EVENT_RETENTION_DAYS * 86_400_000);
  const [logs, events, images, audio] = await prisma.$transaction([
    prisma.systemLog.deleteMany({ where: { createdAt: { lt: logBefore }, module: { not: 'admin' }, NOT: { type: { startsWith: 'ADMIN_' } } } }),
    prisma.messengerEventLog.deleteMany({ where: { receivedAt: { lt: eventBefore }, status: { in: ['PROCESSED', 'IGNORED'] } } }),
    prisma.imageProcessing.updateMany({ where: { retainedUntil: { lt: now }, providerUrl: { not: null }, status: { in: ['COMPLETED', 'FAILED', 'UNSUPPORTED', 'EXPIRED'] } }, data: { providerUrl: null } }),
    prisma.audioTranscription.updateMany({ where: { retainedUntil: { lt: now }, providerUrl: { not: null }, status: { in: ['COMPLETED', 'FAILED', 'UNSUPPORTED', 'EXPIRED'] } }, data: { providerUrl: null } }),
  ]);
  const queues = createQueueRegistry({ [FOLLOW_UP_QUEUE_NAME]: queue });
  let completedJobs = 0;
  try {
    for (const operationalQueue of Object.values(queues)) completedJobs += (await operationalQueue.clean(env.QUEUE_COMPLETED_RETENTION_HOURS * 3_600_000, 1_000, 'completed')).length;
  } finally {
    await Promise.allSettled(Object.entries(queues).filter(([name]) => name !== FOLLOW_UP_QUEUE_NAME).map(([, operationalQueue]) => operationalQueue.close()));
  }
  await prisma.systemLog.create({ data: { level: 'INFO', type: 'RETENTION_CLEANUP_COMPLETED', event: 'RETENTION_CLEANUP_COMPLETED', module: 'system', message: 'retention cleanup completed', metadata: { logs: logs.count, events: events.count, images: images.count, audio: audio.count, completedJobs } } });
  return { logs: logs.count, events: events.count, images: images.count, audio: audio.count, completedJobs };
}

const worker = new Worker(FOLLOW_UP_QUEUE_NAME, async (job) => {
  if (job.name === ABANDONMENT_SCAN_JOB) return service.detectAbandoned();
  if (job.name === CLEANUP_JOB) return cleanupRetention();
  if (job.name === FOLLOW_UP_JOB_NAME) {
    try { return await service.execute(String(job.data.followUpId)); }
    catch (error) {
      if (job.attemptsMade + 1 >= Number(job.opts.attempts ?? 1)) await service.failAfterRetries(String(job.data.followUpId), 'Retry limit exhausted');
      throw error;
    }
  }
  throw new UnrecoverableError('Unsupported follow-up job');
}, { connection, concurrency: env.FOLLOWUP_WORKER_CONCURRENCY, prefix: 'alzeena' });
worker.on('failed', (job, error) => logger.error({ jobId: job?.id, errorType: error.name }, 'Follow-up failed'));
worker.on('completed', (job) => logger.info({ jobId: job.id }, 'Follow-up processed'));
async function shutdown() { await worker.close(); await stopHeartbeat(); await Promise.allSettled([queue.close(), connection.quit(), prisma.$disconnect()]); process.exit(0); }
process.once('SIGINT', () => void shutdown()); process.once('SIGTERM', () => void shutdown());
logger.info({ queue: FOLLOW_UP_QUEUE_NAME }, 'Customer follow-up worker started');
