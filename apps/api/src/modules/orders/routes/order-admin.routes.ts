import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../../../config/env.js";
import { AppError } from "../../../errors/app-error.js";
import { requireAdmin } from "../../admin/auth/require-admin.js";
import { OrderService } from "../order.service.js";
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
        "CANCELLED",
      ])
      .optional(),
    search: z.string().trim().max(200).optional(),
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

  app.get("/api/admin/orders", protectedRoute, async (request) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success)
      throw new AppError("Invalid order list query", 400, "VALIDATION_ERROR");
    const { page, limit, status, search } = parsed.data;
    const where = {
      ...(status ? { status } : {}),
      ...(search
        ? {
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
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
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
    ]);
    return {
      success: true,
      data: rows,
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
      return {
        success: true,
        message: "Order cancelled",
        data: await orders.cancelOrder(parsed.data.id),
      };
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
