import { createQueue } from '../../../infrastructure/queue.js';
import type { MessengerJobData } from './messenger.types.js';
import { env } from '../../../config/env.js';

export const MESSENGER_QUEUE_NAME = 'messenger-events';
export const MESSENGER_JOB_NAME = 'process-messenger-event';
export type MessengerEventQueue = ReturnType<typeof createMessengerEventQueue>;

export function createMessengerEventQueue() { return createQueue(MESSENGER_QUEUE_NAME); }

export function enqueueMessengerEvent(queue: MessengerEventQueue, data: MessengerJobData) {
  return queue.add(MESSENGER_JOB_NAME, data, {
    jobId: data.event.externalEventId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200),
    attempts: 4,
    delay: data.event.eventType === 'message' && data.event.messageType === 'text' ? env.MESSENGER_DEBOUNCE_MS : 0,
    priority: /(?:confirm|yes|হ্যাঁ|জি|order|অর্ডার)/iu.test(data.event.text) ? 1 : 5,
    backoff: { type: 'exponential', delay: 2_000 },
  });
}
