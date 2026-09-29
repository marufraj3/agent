import type { FastifyInstance } from "fastify";
import { AppError } from "../../../errors/app-error.js";
import { requireAdmin } from "../../admin/auth/require-admin.js";
import { AdminInboxService } from "../../inbox/admin-inbox.service.js";
import { listQuerySchema } from "../conversation.schemas.js";
import { channelToPrisma, statusToPrisma } from "../conversation.types.js";

function parseListQuery(query: unknown) {
  const parsed = listQuerySchema.safeParse(query);
  if (!parsed.success)
    throw new AppError("Invalid pagination or filter", 400, "VALIDATION_ERROR");
  return parsed.data;
}

export async function conversationAdminRoutes(
  app: FastifyInstance,
): Promise<void> {
  const inbox = new AdminInboxService(app.prisma);
  app.get(
    "/api/admin/conversations",
    { preHandler: requireAdmin },
    async (request) => {
      const query = parseListQuery(request.query);
      const where = {
        ...(query.status ? { status: statusToPrisma[query.status] } : {}),
        ...(query.channel ? { channel: channelToPrisma[query.channel] } : {}),
      };
      const [items, total] = await Promise.all([
        app.prisma.conversation.findMany({
          where,
          include: {
            customer: {
              select: {
                id: true,
                name: true,
                platform: true,
                platformUserId: true,
              },
            },
            _count: { select: { messages: true } },
          },
          orderBy: { lastMessageAt: "desc" },
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
        app.prisma.conversation.count({ where }),
      ]);
      return {
        success: true,
        data: { items, total, page: query.page, limit: query.limit },
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/admin/conversations/:id",
    { preHandler: requireAdmin },
    async (request) => {
      try {
        const query = request.query as {
          messagePage?: string;
          messageLimit?: string;
        };
        const messagePage = Math.max(1, Number(query.messagePage) || 1);
        const messageLimit = Math.min(
          100,
          Math.max(1, Number(query.messageLimit) || 50),
        );
        return {
          success: true,
          data: await inbox.getConversation(
            request.params.id,
            true,
            messagePage,
            messageLimit,
          ),
        };
      } catch (error) {
        if (error instanceof Error && error.name === "InboxError") {
          throw new AppError(error.message, 404, "CONVERSATION_NOT_FOUND");
        }
        throw error;
      }
    },
  );

  app.get(
    "/api/admin/customers",
    { preHandler: requireAdmin },
    async (request) => {
      const raw = request.query as Record<string, string | undefined>;
      const page = Math.max(1, Number(raw.page) || 1);
      const limit = Math.min(100, Math.max(1, Number(raw.limit) || 25));
      const search = raw.search?.trim();
      const where = search
        ? {
            OR: [
              { name: { contains: search, mode: "insensitive" } },
              { phone: { contains: search } },
              { platformUserId: { contains: search, mode: "insensitive" } },
            ],
          }
        : {};
      const db = app.prisma as any;
      const [items, total] = await Promise.all([
        db.customer.findMany({
          where,
          include: {
            _count: {
              select: { conversations: true, messages: true, orders: true },
            },
          },
          orderBy: { updatedAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        db.customer.count({ where }),
      ]);
      const spending = items.length
        ? await db.order.groupBy({
            by: ["customerId"],
            where: {
              customerId: { in: items.map((item: any) => item.id) },
              status: { in: ["SUBMITTED", "COMPLETED"] },
            },
            _sum: { totalAmount: true },
          })
        : [];
      const totals = new Map(
        spending.map((row: any) => [
          row.customerId,
          row._sum.totalAmount?.toString() ?? "0",
        ]),
      );
      return {
        success: true,
        data: {
          items: items.map((item: any) => ({
            ...item,
            totalSpent: totals.get(item.id) ?? "0",
          })),
          total,
          page,
          limit,
          pages: Math.ceil(total / limit),
        },
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/admin/customers/:id",
    { preHandler: requireAdmin },
    async (request) => {
      const customer = await app.prisma.customer.findUnique({
        where: { id: request.params.id },
        include: {
          conversations: {
            orderBy: { lastMessageAt: "desc" },
            take: 50,
            include: { _count: { select: { messages: true } } },
          },
          orders: {
            orderBy: { createdAt: "desc" },
            take: 50,
            include: { items: true },
          },
          messages: {
            orderBy: { createdAt: "desc" },
            take: 50,
            select: {
              id: true,
              conversationId: true,
              role: true,
              content: true,
              messageType: true,
              metadata: true,
              createdAt: true,
            },
          },
          activities: { orderBy: { createdAt: "desc" }, take: 100 },
          _count: {
            select: { messages: true, conversations: true, orders: true },
          },
        },
      });
      if (!customer)
        throw new AppError("Customer not found", 404, "CUSTOMER_NOT_FOUND");
      return { success: true, data: customer };
    },
  );
}
