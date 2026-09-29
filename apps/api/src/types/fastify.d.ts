import type { PrismaClient } from '@alzeena/database';
import type { Redis } from 'ioredis';
import type { ProductSyncQueue } from '../modules/products/product-sync.queue.js';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
    redis: Redis;
    productSyncQueue: ProductSyncQueue;
  }
}
