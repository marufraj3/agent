import { Queue, type QueueOptions } from 'bullmq';
import { createRedisConnection } from './redis.js';

const defaultJobOptions: QueueOptions['defaultJobOptions'] = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: 100,
  removeOnFail: 500,
};

/**
 * Creates a queue without coupling infrastructure to a business module.
 * Future modules own their queue names, processors, and lifecycle.
 */
export function createQueue(name: string): Queue {
  return new Queue(name, {
    connection: createRedisConnection(),
    defaultJobOptions,
    prefix: 'alzeena',
  });
}
