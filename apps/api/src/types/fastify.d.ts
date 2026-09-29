import type { PrismaClient } from '@alzeena/database';
import type { Redis } from 'ioredis';
import type { ProductSyncQueue } from '../modules/products/product-sync.queue.js';
import type { MessengerEventQueue } from '../modules/channels/messenger/messenger.queue.js';
import type { AudioTranscriptionQueue } from '../modules/audio/audio-transcription.queue.js';
import type { QueueRegistry } from '../infrastructure/queue-registry.js';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
    redis: Redis;
    productSyncQueue: ProductSyncQueue;
    messengerEventQueue: MessengerEventQueue;
    audioTranscriptionQueue: AudioTranscriptionQueue;
    queues: QueueRegistry;
  }
}
