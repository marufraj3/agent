import type { FastifyInstance, FastifyRequest } from 'fastify';
import { env } from '../../../config/env.js';
import { AppError } from '../../../errors/app-error.js';
import { requireAdmin } from '../../admin/auth/require-admin.js';
import { createAIService } from '../ai.factory.js';
import { aiInputSchema } from '../ai.types.js';

const requestsByAddress = new Map<string, number[]>();

function enforceRateLimit(request: FastifyRequest): void {
  const now = Date.now();
  const cutoff = now - 60_000;
  const recent = (requestsByAddress.get(request.ip) ?? []).filter((timestamp) => timestamp > cutoff);
  if (recent.length >= env.AI_TEST_RATE_LIMIT_PER_MINUTE) {
    throw new AppError('AI test rate limit exceeded. Try again shortly.', 429, 'RATE_LIMITED');
  }
  recent.push(now);
  requestsByAddress.set(request.ip, recent);
}

export async function aiTestRoutes(app: FastifyInstance): Promise<void> {
  const service = createAIService(app.prisma, app.log);

  app.post(
    '/api/ai/test',
    { preHandler: [requireAdmin, enforceRateLimit] },
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
