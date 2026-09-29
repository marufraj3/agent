import { prisma } from '@alzeena/database';
import { UnrecoverableError, Worker } from 'bullmq';
import pino from 'pino';
import { env } from '../config/env.js';
import { createRedisConnection } from '../infrastructure/redis.js';
import { startWorkerHeartbeat } from '../infrastructure/worker-heartbeat.js';
import { getMessengerConfig } from '../modules/channels/messenger/messenger.config.js';
import { decryptMessengerToken } from '../modules/channels/messenger/messenger.credentials.js';
import { MESSENGER_CLEANUP_JOB_NAME, MESSENGER_OUTGOING_JOB_NAME, MESSENGER_OUTGOING_QUEUE_NAME, createMessengerOutgoingQueue } from '../modules/channels/messenger/messenger-outgoing.queue.js';
import { MessengerOutgoingProcessor, MessengerSendError } from '../modules/channels/messenger/messenger-outgoing.processor.js';
import { MockMessengerProvider } from '../modules/channels/messenger/messenger.provider.js';
import { MetaMessengerProvider } from '../modules/channels/messenger/messenger.sender.js';
import type { MessengerOutgoingJobData } from '../modules/channels/messenger/messenger.types.js';

const logger = pino({ level: env.LOG_LEVEL, redact: ['*.token','*.accessToken','*.FACEBOOK_PAGE_ACCESS_TOKEN','*.FACEBOOK_APP_SECRET','*.FACEBOOK_VERIFY_TOKEN'] });
const connection = createRedisConnection(); const queue = createMessengerOutgoingQueue();
await Promise.all([prisma.$connect(), queue.setGlobalConcurrency(env.MESSENGER_SEND_WORKER_CONCURRENCY)]);
const config = getMessengerConfig();
const provider = env.MESSENGER_PROVIDER === 'mock' ? new MockMessengerProvider() : new MetaMessengerProvider(config, async (pageId) => {
  if (pageId === config.pageId && config.pageAccessToken) return config.pageAccessToken;
  const page = await (prisma as any).messengerPage.findUnique({ where: { pageId } });
  if (!page?.encryptedAccessToken || !env.MESSENGER_CREDENTIAL_ENCRYPTION_KEY) return undefined;
  return decryptMessengerToken(page.encryptedAccessToken, env.MESSENGER_CREDENTIAL_ENCRYPTION_KEY);
});
const processor = new MessengerOutgoingProcessor(prisma, provider, connection); const stopHeartbeat = startWorkerHeartbeat(connection, MESSENGER_OUTGOING_QUEUE_NAME);
const worker = new Worker<MessengerOutgoingJobData>(MESSENGER_OUTGOING_QUEUE_NAME, async (job) => {
  if (job.name === MESSENGER_CLEANUP_JOB_NAME) return processor.cleanupTechnicalLogs(env.MESSENGER_TECHNICAL_LOG_RETENTION_DAYS);
  if (job.name !== MESSENGER_OUTGOING_JOB_NAME) throw new UnrecoverableError(`Unsupported outgoing Messenger job: ${job.name}`);
  try { return await processor.process(job.data); } catch (error) { if (error instanceof MessengerSendError && !error.retryable) throw new UnrecoverableError(error.message); throw error; }
}, { connection, concurrency: env.MESSENGER_SEND_WORKER_CONCURRENCY, prefix: 'alzeena' });
await queue.upsertJobScheduler(MESSENGER_CLEANUP_JOB_NAME, { every: 24 * 60 * 60_000 }, { name: MESSENGER_CLEANUP_JOB_NAME, data: { outgoingId: '__cleanup__', correlationId: 'scheduled-cleanup' } });
worker.on('completed', (job) => logger.info({ event: 'MESSENGER_SEND_COMPLETED', jobId: job.id, correlationId: job.data.correlationId }, 'Messenger send completed'));
worker.on('failed', (job, error) => logger.error({ event: 'MESSENGER_SEND_FAILED', jobId: job?.id, correlationId: job?.data.correlationId, errorType: error.name }, 'Messenger send failed'));
let closing = false; async function shutdown(signal: string) { if (closing) return; closing = true; logger.info({ signal }, 'Stopping Messenger send worker'); await worker.close(); await stopHeartbeat(); await Promise.allSettled([queue.close(), connection.quit(), prisma.$disconnect()]); process.exit(0); }
process.once('SIGINT', () => void shutdown('SIGINT')); process.once('SIGTERM', () => void shutdown('SIGTERM'));
logger.info({ queue: MESSENGER_OUTGOING_QUEUE_NAME }, 'Messenger send worker started');
