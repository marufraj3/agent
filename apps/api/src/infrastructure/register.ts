import { prisma } from '@alzeena/database';
import type { FastifyInstance } from 'fastify';
import { createRedisConnection } from './redis.js';

export async function registerInfrastructure(app: FastifyInstance): Promise<void> {
  const redis = createRedisConnection();

  app.decorate('prisma', prisma);
  app.decorate('redis', redis);

  app.addHook('onReady', async () => {
    await Promise.all([prisma.$connect(), redis.connect()]);
    app.log.info('PostgreSQL and Redis connections established');
  });

  app.addHook('onClose', async () => {
    await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
  });
}
