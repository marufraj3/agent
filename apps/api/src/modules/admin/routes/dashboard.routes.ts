import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../../../errors/app-error.js";
import { circuitBreakerSnapshots } from "../../../infrastructure/circuit-breaker.js";
import { queueNames } from "../../../infrastructure/queue-registry.js";
import {
  getMessengerConfig,
  isMessengerConfigured,
} from "../../channels/messenger/messenger.config.js";
import { requireAdmin } from "../auth/require-admin.js";
import { dashboardDateRange } from "../dashboard-range.js";

const querySchema = z
  .object({
    range: z
      .enum(["today", "yesterday", "7d", "30d", "custom"])
      .default("today"),
    from: z.string().optional(),
    to: z.string().optional(),
  })
  .strict();

export async function dashboardRoutes(app: FastifyInstance) {
  app.get(
    "/api/admin/dashboard",
    { preHandler: requireAdmin },
    async (request) => {
      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success)
        throw new AppError(
          "Invalid dashboard date filter",
          400,
          "VALIDATION_ERROR",
        );
      const dates = dashboardDateRange(
        parsed.data.range,
        parsed.data.from,
        parsed.data.to,
      );
      if (!dates)
        throw new AppError(
          "A valid custom date range of no more than one year is required",
          400,
          "INVALID_DATE_RANGE",
        );
      const createdAt = { gte: dates.from, lt: dates.to };
      const db = app.prisma as any;
      const [
        conversations,
        messengerMessages,
        orders,
        confirmedOrders,
        handovers,
        orderGroups,
        aiLogs,
        products,
        variations,
        lastSync,
        database,
        redis,
        pendingFollowUps,
        sentFollowUps,
        cancelledFollowUps,
        failedFollowUps,
        abandonedOrders,
      ] = await Promise.all([
        db.conversation.count({ where: { createdAt } }),
        db.message.count({
          where: { createdAt, conversation: { is: { channel: "MESSENGER" } } },
        }),
        db.order.count({ where: { createdAt } }),
        db.order.count({
          where: { createdAt, confirmationStatus: "CONFIRMED" },
        }),
        db.conversationHandover.count({ where: { createdAt } }),
        db.order.groupBy({
          by: ["status"],
          where: { createdAt },
          _count: { _all: true },
        }),
        db.systemLog.findMany({
          where: {
            createdAt,
            type: { in: ["AI_RESPONSE_GENERATED", "AI_RESPONSE_FAILED"] },
          },
          select: { type: true, metadata: true },
        }),
        db.product.count({ where: { presentInFeed: true } }),
        db.productVariation.count({ where: { active: true } }),
        db.systemLog.findFirst({
          where: {
            type: {
              in: [
                "PRODUCT_SYNC_COMPLETED",
                "PRODUCT_SYNC_FAILED",
                "PRODUCT_SYNC_STARTED",
              ],
            },
          },
          orderBy: { createdAt: "desc" },
          select: { type: true, level: true, createdAt: true, metadata: true },
        }),
        db.$queryRaw`SELECT 1`.then(() => "up").catch(() => "down"),
        app.redis
          .ping()
          .then(() => "up")
          .catch(() => "down"),
        db.followUp.count({ where: { status: "PENDING" } }),
        db.followUp.count({ where: { status: "SENT", sentAt: createdAt } }),
        db.followUp.count({ where: { status: "CANCELLED" } }),
        db.followUp.count({ where: { status: { in: ["FAILED", "BLOCKED", "NOT_ELIGIBLE"] } } }),
        db.order.count({ where: { status: "ABANDONED" } }),
      ]);
      const orderStats = Object.fromEntries(
        orderGroups.map((row: any) => [
          String(row.status).toLowerCase(),
          row._count._all,
        ]),
      );
      let latency = 0;
      let failures = 0;
      for (const log of aiLogs) {
        if (log.type === "AI_RESPONSE_FAILED") failures += 1;
        const value = Number(log.metadata?.latencyMs);
        if (Number.isFinite(value)) latency += value;
      }
      const workers = await Promise.all(
        [queueNames.productSync, queueNames.messengerEvents, queueNames.customerFollowups].map(async (name) =>
          Boolean(
            await app.redis.get(`worker:heartbeat:${name}`).catch(() => null),
          ),
        ),
      );
      const circuits = Object.fromEntries(
        circuitBreakerSnapshots().map((item) => [item.service, item.state]),
      );
      const [queueMetrics, unresolvedAlerts] = await Promise.all([
        Promise.all(Object.entries(app.queues).map(async ([name, queue]) => ({ name, paused: await queue.isPaused().catch(() => false), counts: await queue.getJobCounts('waiting','active','delayed','failed').catch(() => ({})) }))),
        (db.messengerAlert?.count ? db.messengerAlert.count({ where: { resolvedAt: null } }) : Promise.resolve(0)),
      ]);
      const facebook = getMessengerConfig();
      return {
        success: true,
        data: {
          range: {
            key: parsed.data.range,
            from: dates.from.toISOString(),
            to: dates.to.toISOString(),
          },
          today: {
            conversations,
            messengerMessages,
            orders,
            confirmedOrders,
            handovers,
          },
          system: {
            api: "up",
            database,
            redis,
            workers: workers.some(Boolean)
              ? workers.every(Boolean)
                ? "up"
                : "degraded"
              : "down",
            gemini: circuits.gemini ?? "ready",
            facebook: isMessengerConfigured(facebook)
              ? (circuits.facebook ?? "connected")
              : "not_configured",
            websiteApi:
              circuits["order-api"] ?? circuits["product-api"] ?? "ready",
          },
          productSync: {
            lastSync,
            products,
            variations,
            status:
              lastSync?.type === "PRODUCT_SYNC_FAILED"
                ? "failed"
                : lastSync?.type === "PRODUCT_SYNC_STARTED"
                  ? "running"
                  : lastSync
                    ? "completed"
                    : "never",
          },
          ai: {
            requests: aiLogs.length,
            failures,
            fallbacks: failures,
            averageResponseTimeMs: aiLogs.length
              ? Math.round(latency / aiLogs.length)
              : 0,
          },
          automation: { pendingFollowUps, sentToday: sentFollowUps, cancelled: cancelledFollowUps, failed: failedFollowUps, abandonedOrders },
          queues: queueMetrics,
          unresolvedAlerts,
          orders: {
            draft: orderStats.draft ?? 0,
            awaitingInformation: orderStats.awaiting_information ?? 0,
            awaitingConfirmation: orderStats.awaiting_confirmation ?? 0,
            confirmed: orderStats.confirmed ?? 0,
            submitted: orderStats.submitted ?? 0,
            completed: orderStats.completed ?? 0,
            cancelled: orderStats.cancelled ?? 0,
            failed: orderStats.failed ?? 0,
            abandoned: orderStats.abandoned ?? 0,
            expired: orderStats.expired ?? 0,
            returned: orderStats.returned ?? 0,
          },
        },
      };
    },
  );
}
