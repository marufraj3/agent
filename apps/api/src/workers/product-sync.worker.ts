import { prisma } from '@alzeena/database';
import { UnrecoverableError, Worker } from 'bullmq';
import pino from 'pino';
import { env } from '../config/env.js';
import { createRedisConnection } from '../infrastructure/redis.js';
import { startWorkerHeartbeat } from '../infrastructure/worker-heartbeat.js';
import { ProductFeedResponseError } from '../modules/products/product-feed.client.js';
import { createProductFeedClient } from '../modules/products/product-feed.factory.js';
import {
  PRODUCT_SYNC_JOB_NAME,
  PRODUCT_SYNC_QUEUE_NAME,
  createProductSyncQueue,
  type ProductSyncJobData,
} from '../modules/products/product-sync.queue.js';
import { ProductSyncService, type ProductSyncResult } from '../modules/products/product-sync.service.js';

const logger = pino({
  level: env.LOG_LEVEL,
  redact: ['req.headers.authorization', 'req.headers.cookie', '*.ADMIN_PASSWORD'],
});
const connection = createRedisConnection();
const controlQueue = createProductSyncQueue();
await controlQueue.setGlobalConcurrency(env.PRODUCT_SYNC_WORKER_CONCURRENCY);
const stopHeartbeat = startWorkerHeartbeat(connection, PRODUCT_SYNC_QUEUE_NAME);

const worker = new Worker<ProductSyncJobData, ProductSyncResult>(
  PRODUCT_SYNC_QUEUE_NAME,
  async (job) => {
    if (job.name !== PRODUCT_SYNC_JOB_NAME) {
      throw new Error(`Unsupported product sync job: ${job.name}`);
    }
    const paused = await prisma.setting.findFirst({ where: { key: { in: ['product_sync.paused','system.maintenance_mode'] }, value: 'true' }, select: { key: true } });
    if (paused) throw new UnrecoverableError(`Product synchronization paused by ${paused.key}`);

    const service = new ProductSyncService({
      prisma,
      logger,
      jobId: job.id,
      feedClient: createProductFeedClient((details) => {
        logger.warn(details, 'Retrying product feed request');
      }),
      onProgress: async (progress) => job.updateProgress(progress),
    });

    try {
      const result = await service.synchronize();
      await connection.incr('product:cache:version');
      return result;
    } catch (error) {
      await prisma.messengerAlert.create({ data: { type: 'PRODUCT_SYNC_FAILED', severity: 'ERROR', message: (error instanceof Error ? error.message : 'Product synchronization failed').slice(0, 500), metadata: { source: 'products', jobId: job.id, errorType: error instanceof Error ? error.name : 'UnknownError' } } }).catch(() => undefined);
      if (error instanceof ProductFeedResponseError) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  },
  {
    connection,
    concurrency: env.PRODUCT_SYNC_WORKER_CONCURRENCY,
    prefix: 'alzeena',
  },
);

worker.on('completed', (job, result) => {
  logger.info({ jobId: job.id, result }, 'Product sync job completed');
});

worker.on('failed', (job, error) => {
  logger.error({ jobId: job?.id, err: error }, 'Product sync job failed');
});

worker.on('error', (error) => {
  logger.error({ err: error }, 'Product sync worker error');
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Stopping product sync worker');
  await worker.close();
  await stopHeartbeat();
  await Promise.allSettled([controlQueue.close(), connection.quit(), prisma.$disconnect()]);
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

logger.info({ queue: PRODUCT_SYNC_QUEUE_NAME }, 'Product sync worker started');
