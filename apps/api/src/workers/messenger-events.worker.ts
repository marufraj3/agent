import { prisma } from '@alzeena/database';
import { UnrecoverableError, Worker } from 'bullmq';
import pino from 'pino';
import { env } from '../config/env.js';
import { createRedisConnection } from '../infrastructure/redis.js';
import { startWorkerHeartbeat } from '../infrastructure/worker-heartbeat.js';
import { createChatService } from '../modules/conversations/chat.factory.js';
import { getMessengerConfig } from '../modules/channels/messenger/messenger.config.js';
import {
  MESSENGER_JOB_NAME, MESSENGER_QUEUE_NAME, createMessengerEventQueue,
} from '../modules/channels/messenger/messenger.queue.js';
import { MessengerSender } from '../modules/channels/messenger/messenger.sender.js';
import { MessengerProcessingError, MessengerService } from '../modules/channels/messenger/messenger.service.js';
import type { MessengerJobData } from '../modules/channels/messenger/messenger.types.js';
import { createFollowUpQueue } from '../modules/automation/follow-up.queue.js';
import { createAudioTranscriptionQueue } from '../modules/audio/audio-transcription.queue.js';
import { AudioIngestionService } from '../modules/audio/audio-ingestion.service.js';
import { createImageAnalysisQueue } from '../modules/images/image-analysis.queue.js';
import { ImageIngestionService } from '../modules/images/image-ingestion.service.js';
import { createMessengerOutgoingQueue } from '../modules/channels/messenger/messenger-outgoing.queue.js';
import { MessengerOutgoingService } from '../modules/channels/messenger/messenger-outgoing.service.js';

const logger = pino({
  level: env.LOG_LEVEL,
  redact: [
    'req.headers.authorization', 'req.headers.cookie', '*.ADMIN_PASSWORD',
    '*.FACEBOOK_APP_SECRET', '*.FACEBOOK_PAGE_ACCESS_TOKEN', '*.FACEBOOK_VERIFY_TOKEN',
  ],
});
const connection = createRedisConnection();
const controlQueue = createMessengerEventQueue();
const followUpQueue = createFollowUpQueue();
const audioQueue = createAudioTranscriptionQueue();
const imageQueue = createImageAnalysisQueue();
const outgoingQueue = createMessengerOutgoingQueue();
await Promise.all([prisma.$connect(), controlQueue.setGlobalConcurrency(env.MESSENGER_WORKER_CONCURRENCY), outgoingQueue.setGlobalConcurrency(env.MESSENGER_SEND_WORKER_CONCURRENCY)]);
const stopHeartbeat = startWorkerHeartbeat(connection, MESSENGER_QUEUE_NAME);
const service = new MessengerService(
  prisma,
  createChatService(prisma, logger as any, followUpQueue),
  new MessengerSender(getMessengerConfig()),
  connection,
  new AudioIngestionService(prisma, audioQueue, connection, env.AUDIO_RATE_LIMIT_PER_MINUTE),
  new ImageIngestionService(prisma, imageQueue),
  new MessengerOutgoingService(prisma, outgoingQueue),
);

const worker = new Worker<MessengerJobData>(
  MESSENGER_QUEUE_NAME,
  async (job) => {
    if (job.name !== MESSENGER_JOB_NAME) throw new UnrecoverableError(`Unsupported Messenger job: ${job.name}`);
    try { return await service.process(job.data); }
    catch (error) {
      if (error instanceof MessengerProcessingError && !error.retryable) throw new UnrecoverableError(error.message);
      throw error;
    }
  },
  { connection, concurrency: env.MESSENGER_WORKER_CONCURRENCY, prefix: 'alzeena' },
);

worker.on('completed', (job) => logger.info({ event: 'MESSENGER_EVENT_PROCESSED', jobId: job.id, pageId: job.data.event.pageId, correlationId: job.data.correlationId }, 'Messenger event processed'));
worker.on('failed', (job, error) => logger.error({ event: 'MESSENGER_EVENT_FAILED', jobId: job?.id, pageId: job?.data.event.pageId, correlationId: job?.data.correlationId, errorType: error.name }, 'Messenger event failed'));
worker.on('error', (error) => logger.error({ errorType: error.name }, 'Messenger worker error'));

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Stopping Messenger worker');
  await worker.close();
  await stopHeartbeat();
  await Promise.allSettled([controlQueue.close(), followUpQueue.close(), audioQueue.close(), imageQueue.close(), outgoingQueue.close(), connection.quit(), prisma.$disconnect()]);
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
logger.info({ queue: MESSENGER_QUEUE_NAME }, 'Messenger event worker started');
