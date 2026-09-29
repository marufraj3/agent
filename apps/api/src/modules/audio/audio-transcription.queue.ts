import { createQueue } from '../../infrastructure/queue.js';

export const AUDIO_TRANSCRIPTION_QUEUE_NAME = 'audio-transcription';
export const AUDIO_TRANSCRIPTION_JOB_NAME = 'transcribe-audio';
export const AUDIO_BATCH_JOB_NAME = 'process-audio-batch';

export interface AudioTranscriptionJobData {
  messageId: string;
  eventLogId: string;
  senderId: string;
  requestId?: string;
  retranscribeOnly?: boolean;
}

export interface AudioBatchJobData {
  conversationId: string;
  senderId: string;
  eventLogId: string;
}

export type AudioTranscriptionQueue = ReturnType<typeof createAudioTranscriptionQueue>;
export function createAudioTranscriptionQueue() { return createQueue(AUDIO_TRANSCRIPTION_QUEUE_NAME); }

export function enqueueAudioTranscription(queue: AudioTranscriptionQueue, data: AudioTranscriptionJobData) {
  return queue.add(AUDIO_TRANSCRIPTION_JOB_NAME, data, {
    jobId: data.retranscribeOnly ? `audio_retranscribe_${data.messageId}_${Date.now()}` : `audio_${data.messageId}`,
    attempts: 3,
    backoff: { type: 'exponential', delay: 2_000 },
  });
}

export function enqueueAudioBatch(
  queue: AudioTranscriptionQueue,
  data: AudioBatchJobData,
  debounceMs: number,
) {
  // The short time bucket coalesces ordinary consecutive notes. Every batch processor
  // atomically claims only completed/unprocessed records, so overlapping buckets are safe.
  const bucket = Math.floor(Date.now() / Math.max(1, debounceMs || 1));
  return queue.add(AUDIO_BATCH_JOB_NAME, data, {
    jobId: `audio_batch_${data.conversationId}_${bucket}`,
    delay: debounceMs,
    attempts: 3,
    backoff: { type: 'exponential', delay: 2_000 },
  });
}
