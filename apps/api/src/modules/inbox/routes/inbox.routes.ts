import type { FastifyInstance } from 'fastify';
import type { ZodType } from 'zod';
import { env } from '../../../config/env.js';
import { AppError } from '../../../errors/app-error.js';
import { requireAdmin } from '../../admin/auth/require-admin.js';
import { HumanHandoverService, DEFAULT_ADMIN_ACTOR } from '../../handovers/human-handover.service.js';
import { HandoverError } from '../../handovers/handover.types.js';
import { AdminInboxService, InboxError } from '../admin-inbox.service.js';
import {
  conversationParamsSchema, handoverListSchema, handoverRequestSchema,
  humanMessageSchema, inboxQuerySchema, noteSchema,
} from '../inbox.schemas.js';

function parse<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new AppError(result.error.issues.map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; '), 400, 'VALIDATION_ERROR');
}

function mapError(error: unknown): never {
  if (error instanceof InboxError || error instanceof HandoverError) {
    throw new AppError(error.message, error.statusCode, error.code);
  }
  throw error;
}

export async function inboxRoutes(app: FastifyInstance): Promise<void> {
  const inbox = new AdminInboxService(app.prisma);
  const handovers = new HumanHandoverService(app.prisma);
  const protectedRoute = { preHandler: requireAdmin };

  app.get('/api/admin/inbox', protectedRoute, async (request) => {
    const query = parse(inboxQuerySchema, request.query);
    const data = await inbox.list({ ...query, limit: query.limit ?? env.INBOX_PAGE_SIZE });
    return { success: true, data };
  });

  app.post('/api/admin/conversations/:id/messages', protectedRoute, async (request) => {
    const { id } = parse(conversationParamsSchema, request.params);
    const { content } = parse(humanMessageSchema, request.body);
    try { return { success: true, data: await inbox.sendHumanMessage(id, content) }; }
    catch (error) { mapError(error); }
  });

  const assign = async (request: any) => {
    const { id } = parse(conversationParamsSchema, request.params);
    try { return { success: true, data: await inbox.take(id) }; }
    catch (error) { mapError(error); }
  };
  app.post('/api/admin/conversations/:id/take', protectedRoute, assign);
  app.post('/api/admin/conversations/:id/assign', protectedRoute, assign);

  app.post('/api/admin/conversations/:id/release', protectedRoute, async (request) => {
    const { id } = parse(conversationParamsSchema, request.params);
    try { return { success: true, data: await inbox.release(id) }; }
    catch (error) { mapError(error); }
  });

  app.post('/api/admin/conversations/:id/return-to-ai', protectedRoute, async (request) => {
    const { id } = parse(conversationParamsSchema, request.params);
    const { note } = parse(noteSchema, request.body ?? {});
    try { return { success: true, data: await inbox.returnToAi(id, note) }; }
    catch (error) { mapError(error); }
  });

  app.post('/api/admin/conversations/:id/close', protectedRoute, async (request) => {
    const { id } = parse(conversationParamsSchema, request.params);
    const { note } = parse(noteSchema, request.body ?? {});
    try { return { success: true, data: await inbox.close(id, note) }; }
    catch (error) { mapError(error); }
  });

  app.post('/api/admin/conversations/:id/reopen', protectedRoute, async (request) => {
    const { id } = parse(conversationParamsSchema, request.params);
    try { return { success: true, data: await inbox.reopen(id) }; }
    catch (error) { mapError(error); }
  });

  app.post('/api/admin/conversations/:id/handover', protectedRoute, async (request) => {
    const { id } = parse(conversationParamsSchema, request.params);
    const body = parse(handoverRequestSchema, request.body);
    try { return { success: true, data: await inbox.requestHandover(id, body.reason, body.note) }; }
    catch (error) { mapError(error); }
  });

  app.get('/api/admin/handovers', protectedRoute, async (request) => {
    const query = parse(handoverListSchema, request.query);
    const data = query.status === 'assigned'
      ? await handovers.getAssignedHandovers(DEFAULT_ADMIN_ACTOR, query.page, query.limit)
      : await handovers.getPendingHandovers(query.page, query.limit);
    return { success: true, data };
  });

  app.post('/api/admin/handovers/:id/resolve', protectedRoute, async (request) => {
    const { id } = parse(conversationParamsSchema, request.params);
    const { note } = parse(noteSchema, request.body ?? {});
    try { return { success: true, data: await handovers.resolveHandover(id, DEFAULT_ADMIN_ACTOR, note, true) }; }
    catch (error) { mapError(error); }
  });
}
