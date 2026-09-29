import type { FastifyInstance } from 'fastify';
import type { ZodType } from 'zod';
import { AppError } from '../../../errors/app-error.js';
import { knowledgeBaseUpdateSchema, settingsUpdateSchema } from '../admin.schemas.js';
import { requireAdmin } from '../auth/require-admin.js';
import { KnowledgeBaseService } from '../knowledge-base.service.js';
import { SettingsService } from '../settings.service.js';

function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;

  const message = result.error.issues
    .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
    .join('; ');
  throw new AppError(message, 400, 'VALIDATION_ERROR');
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const knowledgeBase = new KnowledgeBaseService(app.prisma);
  const settings = new SettingsService(app.prisma);
  const protectedRoute = { preHandler: requireAdmin };

  app.get('/api/admin/knowledge-base', protectedRoute, async () => {
    const active = await knowledgeBase.getActiveKnowledgeBase();
    return { success: true, data: active };
  });

  app.put('/api/admin/knowledge-base', protectedRoute, async (request) => {
    const body = parseBody(knowledgeBaseUpdateSchema, request.body);
    const updated = await knowledgeBase.updateKnowledgeBase(body.content);
    return { success: true, message: 'Knowledge Base saved', data: updated };
  });

  app.get('/api/admin/settings', protectedRoute, async () => {
    const data = await settings.getBusinessSettings();
    return { success: true, data };
  });

  app.put('/api/admin/settings', protectedRoute, async (request) => {
    const body = parseBody(settingsUpdateSchema, request.body);
    const data = await settings.updateBusinessSettings(body);
    return { success: true, message: 'Settings saved', data };
  });
}
