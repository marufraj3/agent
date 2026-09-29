import { createQueue } from '../../infrastructure/queue.js';

export const IMAGE_ANALYSIS_QUEUE_NAME = 'image-analysis';
export const IMAGE_ANALYSIS_JOB_NAME = 'analyze-image';
export const IMAGE_EXPIRY_JOB_NAME = 'expire-retained-images';

export interface ImageAnalysisJobData {
  messageId: string;
  eventLogId: string;
  senderId: string;
  requestId?: string;
  reanalyzeOnly?: boolean;
}
export type ImageAnalysisQueue = ReturnType<typeof createImageAnalysisQueue>;
export function createImageAnalysisQueue() { return createQueue(IMAGE_ANALYSIS_QUEUE_NAME); }
export function enqueueImageAnalysis(queue: ImageAnalysisQueue, data: ImageAnalysisJobData) {
  return queue.add(IMAGE_ANALYSIS_JOB_NAME, data, {
    jobId: data.reanalyzeOnly ? `image_reanalyze_${data.messageId}_${Date.now()}` : `image_${data.messageId}`,
    attempts: 3, backoff: { type: 'exponential', delay: 2_000 },
  });
}
