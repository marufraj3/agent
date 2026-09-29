import { prisma } from '@alzeena/database';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import pino from 'pino';
import { env } from '../config/env.js';
import { createRedisConnection } from '../infrastructure/redis.js';
import { startWorkerHeartbeat } from '../infrastructure/worker-heartbeat.js';
import { createFollowUpQueue } from '../modules/automation/follow-up.queue.js';
import { getMessengerConfig } from '../modules/channels/messenger/messenger.config.js';
import { MessengerSender } from '../modules/channels/messenger/messenger.sender.js';
import { createChatService } from '../modules/conversations/chat.factory.js';
import { ImageAnalysisProcessor, PermanentImageError } from '../modules/images/image-analysis.processor.js';
import { createMessengerOutgoingQueue } from '../modules/channels/messenger/messenger-outgoing.queue.js';
import { MessengerOutgoingService } from '../modules/channels/messenger/messenger-outgoing.service.js';
import { IMAGE_ANALYSIS_JOB_NAME, IMAGE_ANALYSIS_QUEUE_NAME, IMAGE_EXPIRY_JOB_NAME, createImageAnalysisQueue, type ImageAnalysisJobData } from '../modules/images/image-analysis.queue.js';
import { createImageProductService } from '../modules/images/image.factory.js';

const logger = pino({ level: env.LOG_LEVEL, redact: ['*.providerUrl', '*.url', '*.image', '*.ocr', '*.GEMINI_API_KEY', '*.FACEBOOK_PAGE_ACCESS_TOKEN', '*.FACEBOOK_APP_SECRET'] });
const connection = createRedisConnection(); const queue = createImageAnalysisQueue(); const followUpQueue = createFollowUpQueue(); const outgoingQueue = createMessengerOutgoingQueue();
await prisma.$connect();
const stopHeartbeat = startWorkerHeartbeat(connection, IMAGE_ANALYSIS_QUEUE_NAME);
const processor = new ImageAnalysisProcessor(prisma, createImageProductService(prisma), createChatService(prisma, logger as any, followUpQueue), new MessengerSender(getMessengerConfig()), connection, logger, env.IMAGE_RETENTION_HOURS, new MessengerOutgoingService(prisma, outgoingQueue));
const worker = new Worker<ImageAnalysisJobData>(IMAGE_ANALYSIS_QUEUE_NAME, async (job: Job<ImageAnalysisJobData>) => {
  try {
    if (job.name === IMAGE_ANALYSIS_JOB_NAME) return await processor.process(job.data, job.attemptsMade + 1, Number(job.opts.attempts ?? 3));
    if (job.name === IMAGE_EXPIRY_JOB_NAME) return processor.expireRetainedImages();
    throw new PermanentImageError('UNSUPPORTED_JOB');
  } catch (error) { if (error instanceof PermanentImageError) throw new UnrecoverableError(error.message); throw error; }
}, { connection, concurrency: 3, prefix: 'alzeena' });
await queue.upsertJobScheduler(IMAGE_EXPIRY_JOB_NAME, { every: 15 * 60_000 }, { name: IMAGE_EXPIRY_JOB_NAME, data: {} as ImageAnalysisJobData });
worker.on('completed', (job) => logger.info({ jobId: job.id, jobName: job.name }, 'Image job completed'));
worker.on('failed', (job, error) => logger.error({ jobId: job?.id, jobName: job?.name, errorType: error.name }, 'Image job failed'));
worker.on('error', (error) => logger.error({ errorType: error.name }, 'Image worker error'));
let shuttingDown = false;
async function shutdown(signal: string) { if (shuttingDown) return; shuttingDown = true; logger.info({ signal }, 'Stopping image analysis worker'); await worker.close(); await stopHeartbeat(); await Promise.allSettled([queue.close(), followUpQueue.close(), outgoingQueue.close(), connection.quit(), prisma.$disconnect()]); process.exit(0); }
process.once('SIGINT', () => void shutdown('SIGINT')); process.once('SIGTERM', () => void shutdown('SIGTERM'));
logger.info({ queue: IMAGE_ANALYSIS_QUEUE_NAME, provider: env.VISION_PROVIDER, model: env.VISION_MODEL }, 'Image analysis worker started');
