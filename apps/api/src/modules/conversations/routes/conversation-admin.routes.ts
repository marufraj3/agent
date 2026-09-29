import type { FastifyInstance } from 'fastify';
import { AppError } from '../../../errors/app-error.js';
import { requireAdmin } from '../../admin/auth/require-admin.js';
import { listQuerySchema } from '../conversation.schemas.js';
import { channelToPrisma, statusToPrisma } from '../conversation.types.js';

function parseListQuery(query: unknown) {
  const parsed = listQuerySchema.safeParse(query);
  if (!parsed.success) throw new AppError('Invalid pagination or filter', 400, 'VALIDATION_ERROR');
  return parsed.data;
}

export async function conversationAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/conversations', { preHandler: requireAdmin }, async (request) => {
    const query = parseListQuery(request.query);
    const where = {
      ...(query.status ? { status: statusToPrisma[query.status] } : {}),
      ...(query.channel ? { channel: channelToPrisma[query.channel] } : {}),
    };
    const [items, total] = await Promise.all([
      app.prisma.conversation.findMany({
        where,
        include: {
          customer: { select: { id: true, name: true, platform: true, platformUserId: true } },
          _count: { select: { messages: true } },
        },
        orderBy: { lastMessageAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      app.prisma.conversation.count({ where }),
    ]);
    return { success: true, data: { items, total, page: query.page, limit: query.limit } };
  });

  app.get<{ Params: { id: string } }>(
    '/api/admin/conversations/:id',
    { preHandler: requireAdmin },
    async (request) => {
      const conversation = await app.prisma.conversation.findUnique({
        where: { id: request.params.id },
        include: {
          customer: true,
          messages: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 5_000 },
          _count: { select: { messages: true } },
        },
      });
      if (!conversation) throw new AppError('Conversation not found', 404, 'CONVERSATION_NOT_FOUND');
      return { success: true, data: conversation };
    },
  );

  app.get('/api/admin/customers', { preHandler: requireAdmin }, async (request) => {
    const query = parseListQuery(request.query);
    const [items, total] = await Promise.all([
      app.prisma.customer.findMany({
        include: {
          _count: { select: { conversations: true, messages: true } },
        },
        orderBy: { updatedAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      app.prisma.customer.count(),
    ]);
    return { success: true, data: { items, total, page: query.page, limit: query.limit } };
  });

  app.get<{ Params: { id: string } }>(
    '/api/admin/customers/:id',
    { preHandler: requireAdmin },
    async (request) => {
      const customer = await app.prisma.customer.findUnique({
        where: { id: request.params.id },
        include: {
          conversations: {
            orderBy: { lastMessageAt: 'desc' },
            include: { _count: { select: { messages: true } } },
          },
          _count: { select: { messages: true, conversations: true } },
        },
      });
      if (!customer) throw new AppError('Customer not found', 404, 'CUSTOMER_NOT_FOUND');
      return { success: true, data: customer };
    },
  );
}
