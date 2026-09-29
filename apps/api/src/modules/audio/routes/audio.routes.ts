import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../../config/env.js';
import { AppError } from '../../../errors/app-error.js';
import { requireAdmin } from '../../admin/auth/require-admin.js';
import { enforceAIRateLimit } from '../../ai/ai-rate-limit.js';
import { createVoiceUnderstandingService } from '../audio.factory.js';
import { AudioFetchError } from '../audio.service.js';
import { audioInputSchema, supportedAudioMimeTypes } from '../audio.types.js';
import { AudioValidationError } from '../audio-validation.service.js';
import {
  SpeechToTextDurationError,
  SpeechToTextError,
} from '../speech-to-text.service.js';

const transcribeRequestSchema = z
  .object({
    audioUrl: z.url().max(2_048).optional(),
    audioData: z.string().min(1).optional(),
    mimeType: z.enum(supportedAudioMimeTypes).optional(),
    duration: z.number().positive().optional(),
  })
  .strict()
  .refine((input) => Boolean(input.audioUrl) !== Boolean(input.audioData), {
    message: 'Provide exactly one of audioUrl or audioData',
  });

export async function audioRoutes(app: FastifyInstance): Promise<void> {
  const voice = createVoiceUnderstandingService(app.prisma);

  app.post(
    '/api/ai/transcribe',
    {
      preHandler: [requireAdmin, enforceAIRateLimit],
      bodyLimit: Math.ceil(env.MAX_AUDIO_SIZE_MB * 1024 * 1024 * (4 / 3)) + 100_000,
    },
    async (request) => {
      const parsed = transcribeRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        const message = parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
          .join('; ');
        throw new AppError(message, 400, 'VALIDATION_ERROR');
      }

      try {
        const input = audioInputSchema.parse({
          type: 'audio',
          ...(parsed.data.audioUrl ? { url: parsed.data.audioUrl } : { data: parsed.data.audioData }),
          ...(parsed.data.mimeType ? { mimeType: parsed.data.mimeType } : {}),
          ...(parsed.data.duration ? { duration: parsed.data.duration } : {}),
          source: 'admin_test',
        });
        const audio = await voice.prepare(input);
        const transcription = await voice.transcribe(audio);
        return { success: true, data: transcription };
      } catch (error) {
        if (error instanceof AudioValidationError) {
          throw new AppError(error.message, 400, error.code);
        }
        if (error instanceof AudioFetchError) {
          throw new AppError(error.message, 422, 'AUDIO_FETCH_FAILED');
        }
        if (error instanceof SpeechToTextDurationError) {
          throw new AppError(error.message, 400, 'AUDIO_TOO_LONG');
        }
        if (error instanceof SpeechToTextError) {
          throw new AppError('Audio transcription is temporarily unavailable', 503, 'TRANSCRIPTION_FAILED');
        }
        request.log.error(
          { errorType: error instanceof Error ? error.name : 'UnknownError' },
          'Audio transcription request failed',
        );
        throw new AppError('Audio transcription is temporarily unavailable', 503, 'TRANSCRIPTION_FAILED');
      }
    },
  );
}
