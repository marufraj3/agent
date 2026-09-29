import type { FastifyInstance } from 'fastify';
import { env } from '../../../config/env.js';
import { AppError } from '../../../errors/app-error.js';
import { enforceRateLimit } from '../../../infrastructure/rate-limit.js';
import { requireAdmin } from '../../admin/auth/require-admin.js';
import { enforceAIRateLimit } from '../../ai/ai-rate-limit.js';
import { AudioFetchError } from '../../audio/audio.service.js';
import { AudioValidationError } from '../../audio/audio-validation.service.js';
import { ImageFetchError } from '../../images/image.service.js';
import { OrderEngineError } from '../../orders/order.types.js';
import { ImageValidationError } from '../../images/image-validation.service.js';
import { createChatService } from '../chat.factory.js';
import { ConversationAccessError } from '../chat.service.js';
import { chatRequestSchema } from '../conversation.schemas.js';
import { conversationChannels } from '../conversation.types.js';

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  const chat = createChatService(app.prisma, app.log);

  app.post(
    '/api/ai/chat',
    {
      preHandler: [requireAdmin, enforceAIRateLimit],
      bodyLimit:
        Math.ceil(Math.max(env.MAX_IMAGE_SIZE_MB, env.MAX_AUDIO_SIZE_MB) * 1024 * 1024 * (4 / 3)) +
        100_000,
    },
    async (request) => {
      const parsed = chatRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        const message = parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
          .join('; ');
        throw new AppError(message, 400, 'VALIDATION_ERROR');
      }

      await enforceRateLimit(
        app.redis, 'ai-customer',
        `${parsed.data.customer.platform}:${parsed.data.customer.platformUserId}`, 60, 60,
      );
      if (parsed.data.conversationId) {
        await enforceRateLimit(app.redis, 'ai-conversation', parsed.data.conversationId, 30, 60);
      }
      const platformChannel = conversationChannels.find(
        (channel) => channel === parsed.data.customer.platform.toLowerCase(),
      );
      try {
        const data = await chat.send({
          ...parsed.data,
          channel: parsed.data.channel ?? platformChannel ?? 'web',
          includeDebug: true,
        });
        return { success: true, data };
      } catch (error) {
        if (error instanceof ConversationAccessError) {
          throw new AppError(error.message, 409, 'CONVERSATION_UNAVAILABLE');
        }
        if (error instanceof ImageValidationError) {
          throw new AppError(error.message, 400, error.code);
        }
        if (error instanceof ImageFetchError) {
          throw new AppError(error.message, 422, 'IMAGE_FETCH_FAILED');
        }
        if (error instanceof AudioValidationError) {
          throw new AppError(error.message, 400, error.code);
        }
        if (error instanceof AudioFetchError) {
          throw new AppError(error.message, 422, 'AUDIO_FETCH_FAILED');
        }
        if (error instanceof OrderEngineError) {
          throw new AppError(error.message, error.statusCode, error.code);
        }
        request.log.error(
          { errorType: error instanceof Error ? error.name : 'UnknownError' },
          'Persistent AI chat failed',
        );
        throw new AppError(
          'Conversation memory is temporarily unavailable. Please try again.',
          503,
          'CONVERSATION_MEMORY_UNAVAILABLE',
        );
      }
    },
  );
}
