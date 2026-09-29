import { prisma } from '@alzeena/database';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import pino from 'pino';
import { env } from '../config/env.js';
import { createRedisConnection } from '../infrastructure/redis.js';
import { startWorkerHeartbeat } from '../infrastructure/worker-heartbeat.js';
import { createFollowUpQueue } from '../modules/automation/follow-up.queue.js';
import { createVoiceUnderstandingService } from '../modules/audio/audio.factory.js';
import {
  AUDIO_BATCH_JOB_NAME, AUDIO_TRANSCRIPTION_JOB_NAME, AUDIO_TRANSCRIPTION_QUEUE_NAME,
  createAudioTranscriptionQueue, type AudioBatchJobData, type AudioTranscriptionJobData,
} from '../modules/audio/audio-transcription.queue.js';
import { AudioTranscriptionProcessor, PermanentAudioError } from '../modules/audio/audio-transcription.processor.js';
import { getMessengerConfig } from '../modules/channels/messenger/messenger.config.js';
import { MessengerSender } from '../modules/channels/messenger/messenger.sender.js';
import { createChatService } from '../modules/conversations/chat.factory.js';

const logger = pino({
  level: env.LOG_LEVEL,
  redact: [
    'req.headers.authorization', 'req.headers.cookie', '*.providerUrl', '*.url', '*.audio', '*.transcript',
    '*.GEMINI_API_KEY', '*.FACEBOOK_APP_SECRET', '*.FACEBOOK_PAGE_ACCESS_TOKEN', '*.FACEBOOK_VERIFY_TOKEN',
  ],
});
const connection = createRedisConnection();
const queue = createAudioTranscriptionQueue();
const followUpQueue = createFollowUpQueue();
await prisma.$connect();
const stopHeartbeat = startWorkerHeartbeat(connection, AUDIO_TRANSCRIPTION_QUEUE_NAME);
const processor = new AudioTranscriptionProcessor(
  prisma,
  createVoiceUnderstandingService(prisma),
  createChatService(prisma, logger as any, followUpQueue),
  new MessengerSender(getMessengerConfig()),
  queue,
  connection,
  logger,
  env.STT_PROVIDER,
  env.STT_MODEL,
  env.AUDIO_RETENTION_HOURS,
  env.AUDIO_DEBOUNCE_MS,
);

const worker = new Worker<AudioTranscriptionJobData | AudioBatchJobData>(
  AUDIO_TRANSCRIPTION_QUEUE_NAME,
  async (job: Job<AudioTranscriptionJobData | AudioBatchJobData>) => {
    try {
      if (job.name === AUDIO_TRANSCRIPTION_JOB_NAME) {
        return await processor.transcribe(
          job.data as AudioTranscriptionJobData,
          job.attemptsMade + 1,
          Number(job.opts.attempts ?? 3),
        );
      }
      if (job.name === AUDIO_BATCH_JOB_NAME) return processor.processBatch(job.data as AudioBatchJobData);
      if (job.name === 'expire-retained-audio') return processor.expireRetainedAudio();
      throw new PermanentAudioError('UNSUPPORTED_JOB');
    } catch (error) {
      if (error instanceof PermanentAudioError) throw new UnrecoverableError(error.message);
      throw error;
    }
  },
  { connection, concurrency: 3, prefix: 'alzeena' },
);

await queue.upsertJobScheduler('expire-retained-audio', { every: 15 * 60_000 }, { name: 'expire-retained-audio', data: {} as AudioBatchJobData });
worker.on('completed', (job) => logger.info({ jobId: job.id, jobName: job.name }, 'Audio job completed'));
worker.on('failed', (job, error) => logger.error({ jobId: job?.id, jobName: job?.name, errorType: error.name }, 'Audio job failed'));
worker.on('error', (error) => logger.error({ errorType: error.name }, 'Audio worker error'));

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Stopping audio transcription worker');
  await worker.close();
  await stopHeartbeat();
  await Promise.allSettled([queue.close(), followUpQueue.close(), connection.quit(), prisma.$disconnect()]);
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
logger.info({ queue: AUDIO_TRANSCRIPTION_QUEUE_NAME, provider: env.STT_PROVIDER, model: env.STT_MODEL }, 'Audio transcription worker started');
