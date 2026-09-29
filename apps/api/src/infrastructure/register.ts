import { prisma } from '@alzeena/database';
import type { FastifyInstance } from 'fastify';
import { createProductSyncQueue } from '../modules/products/product-sync.queue.js';
import { createMessengerEventQueue } from '../modules/channels/messenger/messenger.queue.js';
import { createRedisConnection } from './redis.js';

export async function registerInfrastructure(app: FastifyInstance): Promise<void> {
  const redis = createRedisConnection();
  const productSyncQueue = createProductSyncQueue();
  const messengerEventQueue = createMessengerEventQueue();

  app.decorate('prisma', prisma);
  app.decorate('redis', redis);
  app.decorate('productSyncQueue', productSyncQueue);
  app.decorate('messengerEventQueue', messengerEventQueue);

  app.addHook('onReady', async () => {
    await Promise.all([
      prisma.$connect(),
      redis.connect(),
      productSyncQueue.setGlobalConcurrency(1),
      messengerEventQueue.setGlobalConcurrency(1),
    ]);
    app.log.info('PostgreSQL and Redis connections established');
  });

  app.addHook('onClose', async () => {
    await Promise.allSettled([
      productSyncQueue.close(), messengerEventQueue.close(), prisma.$disconnect(), redis.quit(),
    ]);
  });
}
