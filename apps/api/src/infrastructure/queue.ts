import { Queue, type QueueOptions } from 'bullmq';
import { createRedisConnection } from './redis.js';

export const queueRetryPolicy: QueueOptions['defaultJobOptions'] = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: 500,
  removeOnFail: 2_000,
};

/**
 * Creates a queue without coupling infrastructure to a business module.
 * Future modules own their queue names, processors, and lifecycle.
 */
export function createQueue(name: string): Queue {
  return new Queue(name, {
    connection: createRedisConnection(),
    defaultJobOptions: queueRetryPolicy,
    prefix: 'alzeena',
  });
}
