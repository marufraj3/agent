import { createQueue } from '../../../infrastructure/queue.js';
import type { MessengerOutgoingJobData } from './messenger.types.js';

export const MESSENGER_OUTGOING_QUEUE_NAME = 'messenger-outgoing';
export const MESSENGER_OUTGOING_JOB_NAME = 'send-messenger-message';
export const MESSENGER_CLEANUP_JOB_NAME = 'cleanup-messenger-technical-logs';
export type MessengerOutgoingQueue = ReturnType<typeof createMessengerOutgoingQueue>;
export function createMessengerOutgoingQueue() { return createQueue(MESSENGER_OUTGOING_QUEUE_NAME); }
export function enqueueMessengerOutgoing(queue: MessengerOutgoingQueue, data: MessengerOutgoingJobData, priority: 'HIGH'|'NORMAL'|'LOW' = 'NORMAL') {
  return queue.add(MESSENGER_OUTGOING_JOB_NAME, data, { jobId: data.outgoingId, attempts: 4, backoff: { type: 'exponential', delay: 2_000 }, priority: priority === 'HIGH' ? 1 : priority === 'LOW' ? 10 : 5, removeOnComplete: { age: 86_400, count: 10_000 }, removeOnFail: { age: 604_800, count: 10_000 } });
}
