import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../../../config/env.js";
import { AppError } from "../../../errors/app-error.js";
import { requireAdmin } from "../../admin/auth/require-admin.js";
import { OrderService } from "../order.service.js";
import { CustomerJourneyService } from "../../automation/customer-journey.service.js";
import { OrderEngineError } from "../order.types.js";
import { WebsiteOrderApiClient } from "../website-order-api.client.js";

const listQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    status: z
      .enum([
        "DRAFT",
        "AWAITING_INFORMATION",
        "AWAITING_CONFIRMATION",
        "CONFIRMED",
        "SUBMITTED",
        "COMPLETED",
        "FAILED",
        "ABANDONED",
        "EXPIRED",
        "CANCELLED",
        "RETURNED",
      ])
      .optional(),
    search: z.string().trim().max(200).optional(),
    source: z.enum(['AI','HUMAN','ADMIN']).optional(),
    customer: z.string().trim().max(200).optional(),
    order: z.string().trim().max(200).optional(),
    conversationId: z.uuid().optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .strict();

const paramsSchema = z.object({ id: z.uuid() }).strict();

export async function orderAdminRoutes(app: FastifyInstance): Promise<void> {
  const db = app.prisma as any;
  const orders = new OrderService(
    app.prisma,
    new WebsiteOrderApiClient(env.ORDER_API_TIMEOUT_MS),
    app.log,
  );
  const protectedRoute = { preHandler: requireAdmin };
  const journey = new CustomerJourneyService(app.prisma);

  app.get("/api/admin/orders", protectedRoute, async (request) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success)
      throw new AppError("Invalid order list query", 400, "VALIDATION_ERROR");
    const { page, limit, status, search, source, customer, order, conversationId, from, to } = parsed.data;
    if (from && to && to <= from) throw new AppError('Invalid order date range',400,'VALIDATION_ERROR');
    const baseWhere = {
      ...(source ? { source } : {}),
      ...(conversationId ? { conversationId } : {}),
      ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
      ...(customer ? { customer: { is: { OR: [{ name: { contains: customer, mode: 'insensitive' } }, { phone: { contains: customer } }] } } } : {}),
    };
    const where = {
      AND: [baseWhere, ...(order ? [{ OR: [{ orderCode: { contains: order, mode:'insensitive' } }, { externalOrderId: { contains: order, mode:'insensitive' } }, ...(z.string().uuid().safeParse(order).success ? [{ id: order }] : [])] }] : []), ...(search
        ? [{
            OR: [
              ...(z.string().uuid().safeParse(search).success
                ? [{ id: search }]
                : []),
              { orderCode: { contains: search, mode: "insensitive" } },
              { externalOrderId: { contains: search, mode: "insensitive" } },
              {
                customer: {
                  is: { name: { contains: search, mode: "insensitive" } },
                },
              },
              { customer: { is: { phone: { contains: search } } } },
            ],
          }]
        : []),
        ...(status ? [{ status }] : []),
      ],
    };
    const [rows, total, summaryRows] = await Promise.all([
      db.order.findMany({
        where,
        include: {
          items: true,
          customer: { select: { id: true, name: true, phone: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      db.order.count({ where }),
      db.order.groupBy({ by: ['status'], where: baseWhere, _count: { _all: true }, _sum: { totalAmount: true } }),
    ]);
    return {
      success: true,
      data: rows,
      summary: summaryRows.map((item: any) => ({ status: item.status, count: item._count._all, totalAmount: item._sum.totalAmount })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  });

  app.get("/api/admin/orders/:id", protectedRoute, async (request) => {
    const parsed = paramsSchema.safeParse(request.params);
    if (!parsed.success)
      throw new AppError("Invalid order ID", 400, "VALIDATION_ERROR");
    const order = await orders.getOrder(parsed.data.id);
    if (!order) throw new AppError("Order not found", 404, "ORDER_NOT_FOUND");
    return { success: true, data: order };
  });

  app.post("/api/admin/orders/:id/cancel", protectedRoute, async (request) => {
    const parsed = paramsSchema.safeParse(request.params);
    if (!parsed.success)
      throw new AppError("Invalid order ID", 400, "VALIDATION_ERROR");
    try {
      const data = await orders.cancelOrder(parsed.data.id);
      await db.followUp.updateMany({ where: { orderId: data.id, status: "PENDING" }, data: { status: "CANCELLED", cancelledAt: new Date(), failureReason: "order_cancelled" } });
      await journey.transition(data.customerId, "CANCELLED", "ORDER_CANCELLED", { summary: "Order cancelled", conversationId: data.conversationId, orderId: data.id }).catch(() => undefined);
      await db.systemLog.create({data:{level:'INFO',type:'ADMIN_ORDER_CANCELLED',event:'ADMIN_ORDER_CANCELLED',module:'admin',message:'admin cancelled order',metadata:{orderId:data.id}}});
      return { success: true, message: "Order cancelled", data };
    } catch (error) {
      if (error instanceof OrderEngineError)
        throw new AppError(error.message, error.statusCode, error.code);
      throw error;
    }
  });

  app.post("/api/admin/orders/:id/retry", protectedRoute, async (request) => {
    const parsed = paramsSchema.safeParse(request.params);
    if (!parsed.success)
      throw new AppError("Invalid order ID", 400, "VALIDATION_ERROR");
    try {
      const order = await orders.retryOrderSubmission(parsed.data.id);
      await db.systemLog.create({data:{level:'INFO',type:'ADMIN_ORDER_SUBMISSION_RETRIED',event:'ADMIN_ORDER_SUBMISSION_RETRIED',module:'admin',message:'admin retried order submission',metadata:{orderId:parsed.data.id}}});
      return {
        success: true,
        message: "Order submission retried",
        data: order,
      };
    } catch (error) {
      if (error instanceof OrderEngineError) {
        throw new AppError(error.message, error.statusCode, error.code);
      }
      throw error;
    }
  });
}
