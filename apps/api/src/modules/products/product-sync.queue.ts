import type { Queue } from 'bullmq';
import { createQueue } from '../../infrastructure/queue.js';
import type { ProductSyncResult } from './product-sync.service.js';

export const PRODUCT_SYNC_QUEUE_NAME = 'product-sync';
export const PRODUCT_SYNC_JOB_NAME = 'synchronize-product-feed';

export type ProductSyncJobData = Record<string, never>;
export type ProductSyncQueue = Queue<ProductSyncJobData, ProductSyncResult>;

export function createProductSyncQueue(): ProductSyncQueue {
  return createQueue(PRODUCT_SYNC_QUEUE_NAME) as ProductSyncQueue;
}
