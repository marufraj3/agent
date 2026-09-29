import type { FastifyInstance } from 'fastify';
import { env } from '../../../config/env.js';
import { AppError } from '../../../errors/app-error.js';
import { requireAdmin } from '../../admin/auth/require-admin.js';
import { createAIService } from '../../ai/ai.factory.js';
import { ChatService, ConversationAccessError } from '../chat.service.js';
import { chatRequestSchema } from '../conversation.schemas.js';
import { conversationChannels } from '../conversation.types.js';

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  const chat = new ChatService(
    app.prisma,
    createAIService(app.prisma, app.log),
    env.CONVERSATION_HISTORY_LIMIT,
    env.AI_MAX_PRODUCTS,
  );

  app.post('/api/ai/chat', { preHandler: requireAdmin }, async (request) => {
    const parsed = chatRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
        .join('; ');
      throw new AppError(message, 400, 'VALIDATION_ERROR');
    }

    const platformChannel = conversationChannels.find(
      (channel) => channel === parsed.data.customer.platform.toLowerCase(),
    );
    try {
      const data = await chat.send({
        ...parsed.data,
        channel: parsed.data.channel ?? platformChannel ?? 'web',
      });
      return { success: true, data };
    } catch (error) {
      if (error instanceof ConversationAccessError) {
        throw new AppError(error.message, 409, 'CONVERSATION_UNAVAILABLE');
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
  });
}
