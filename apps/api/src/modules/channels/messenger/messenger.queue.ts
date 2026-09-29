import { createQueue } from '../../../infrastructure/queue.js';
import type { MessengerJobData } from './messenger.types.js';

export const MESSENGER_QUEUE_NAME = 'messenger-events';
export const MESSENGER_JOB_NAME = 'process-messenger-event';
export type MessengerEventQueue = ReturnType<typeof createMessengerEventQueue>;

export function createMessengerEventQueue() { return createQueue(MESSENGER_QUEUE_NAME); }

export function enqueueMessengerEvent(queue: MessengerEventQueue, data: MessengerJobData) {
  return queue.add(MESSENGER_JOB_NAME, data, {
    jobId: data.event.externalEventId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200),
    attempts: 4,
    backoff: { type: 'exponential', delay: 2_000 },
  });
}
