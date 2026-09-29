import type { Queue } from 'bullmq';
import { createQueue, queueRetryPolicy } from './queue.js';

export const queueNames = {
  productSync: 'product-sync',
  messengerEvents: 'messenger-events',
  messengerOutgoing: 'messenger-outgoing',
  aiProcessing: 'ai-processing',
  orderProcessing: 'order-processing',
  notifications: 'notifications',
  customerFollowups: 'customer-followups',
  audioTranscription: 'audio-transcription',
  imageAnalysis: 'image-analysis',
} as const;
export type QueueName = (typeof queueNames)[keyof typeof queueNames];
export type QueueRegistry = Record<QueueName, Queue>;

export function createQueueRegistry(existing: Partial<QueueRegistry> = {}): QueueRegistry {
  return Object.fromEntries(
    Object.values(queueNames).map((name) => [name, existing[name] ?? createQueue(name)]),
  ) as QueueRegistry;
}

export { queueRetryPolicy };
