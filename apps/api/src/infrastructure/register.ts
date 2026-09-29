import { prisma } from '@alzeena/database';
import type { FastifyInstance } from 'fastify';
import { createProductSyncQueue } from '../modules/products/product-sync.queue.js';
import { createMessengerEventQueue } from '../modules/channels/messenger/messenger.queue.js';
import { createAudioTranscriptionQueue } from '../modules/audio/audio-transcription.queue.js';
import { createImageAnalysisQueue } from '../modules/images/image-analysis.queue.js';
import { createRedisConnection } from './redis.js';
import { createQueueRegistry, queueNames } from './queue-registry.js';

export async function registerInfrastructure(app: FastifyInstance): Promise<void> {
  const redis = createRedisConnection();
  const productSyncQueue = createProductSyncQueue();
  const messengerEventQueue = createMessengerEventQueue();
  const audioTranscriptionQueue = createAudioTranscriptionQueue();
  const imageAnalysisQueue = createImageAnalysisQueue();
  const queues = createQueueRegistry({
    [queueNames.productSync]: productSyncQueue,
    [queueNames.messengerEvents]: messengerEventQueue,
    [queueNames.audioTranscription]: audioTranscriptionQueue,
    [queueNames.imageAnalysis]: imageAnalysisQueue,
  });

  app.decorate('prisma', prisma);
  app.decorate('redis', redis);
  app.decorate('productSyncQueue', productSyncQueue);
  app.decorate('messengerEventQueue', messengerEventQueue);
  app.decorate('audioTranscriptionQueue', audioTranscriptionQueue);
  app.decorate('imageAnalysisQueue', imageAnalysisQueue);
  app.decorate('queues', queues);

  app.addHook('onReady', async () => {
    await Promise.all([
      prisma.$connect(),
      redis.connect(),
      productSyncQueue.setGlobalConcurrency(1),
      messengerEventQueue.setGlobalConcurrency(1),
      audioTranscriptionQueue.setGlobalConcurrency(3),
      imageAnalysisQueue.setGlobalConcurrency(3),
    ]);
    app.log.info('PostgreSQL and Redis connections established');
  });

  app.addHook('onClose', async () => {
    await Promise.allSettled([
      ...Object.values(queues).map((queue) => queue.close()), prisma.$disconnect(), redis.quit(),
    ]);
  });
}
