import type { FastifyInstance } from 'fastify';
import { AppError } from '../../../errors/app-error.js';
import { requireAdmin } from '../../admin/auth/require-admin.js';
import { createAIService } from '../ai.factory.js';
import { enforceAIRateLimit } from '../ai-rate-limit.js';
import { aiInputSchema } from '../ai.types.js';

export async function aiTestRoutes(app: FastifyInstance): Promise<void> {
  const service = createAIService(app.prisma, app.log);

  app.post(
    '/api/ai/test',
    { preHandler: [requireAdmin, enforceAIRateLimit] },
    async (request) => {
      const parsed = aiInputSchema.safeParse(request.body);
      if (!parsed.success) {
        const message = parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
          .join('; ');
        throw new AppError(message, 400, 'VALIDATION_ERROR');
      }

      const data = await service.respond(parsed.data);
      return { success: true, data };
    },
  );
}
