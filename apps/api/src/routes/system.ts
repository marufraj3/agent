import type { FastifyInstance } from "fastify";
import { ValidationError, NotFoundError } from "../errors/app-error.js";
import { circuitBreakerSnapshots } from "../infrastructure/circuit-breaker.js";
import {
  queueNames,
  type QueueName,
} from "../infrastructure/queue-registry.js";
import { requireAdmin } from "../modules/admin/auth/require-admin.js";

function queueName(value: unknown): QueueName {
  if (
    typeof value !== "string" ||
    !Object.values(queueNames).includes(value as QueueName)
  ) {
    throw new ValidationError("Unknown queue");
  }
  return value as QueueName;
}

async function queueSnapshot(app: FastifyInstance, includeFailed = false) {
  return Promise.all(
    Object.entries(app.queues).map(async ([name, queue]) => {
      try {
        return {
          name,
          available: true,
          counts: await queue.getJobCounts(
            "wait",
            "active",
            "delayed",
            "completed",
            "failed",
          ),
          ...(includeFailed
            ? {
                failedJobs: (await queue.getJobs(["failed"], 0, 49)).map(
                  (job) => ({
                    id: job.id,
                    name: job.name,
                    failedReason: job.failedReason?.slice(0, 300),
                    attemptsMade: job.attemptsMade,
                    timestamp: job.timestamp,
                  }),
                ),
              }
            : {}),
        };
      } catch {
        return {
          name,
          available: false,
          counts: {},
          ...(includeFailed ? { failedJobs: [] } : {}),
        };
      }
    }),
  );
}

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  const protectedRoute = { preHandler: requireAdmin };

  app.get("/api/admin/system/health", protectedRoute, async () => {
    const started = Date.now();
    const [database, redis, queues, latestSync, productMetrics] =
      await Promise.all([
        app.prisma.$queryRaw`SELECT 1`
          .then(() => "up" as const)
          .catch(() => "down" as const),
        app.redis
          .ping()
          .then(() => "up" as const)
          .catch(() => "down" as const),
        queueSnapshot(app),
        app.prisma.systemLog
          .findFirst({
            where: { type: "PRODUCT_SYNC_COMPLETED" },
            orderBy: { createdAt: "desc" },
            select: { createdAt: true, metadata: true },
          })
          .catch(() => null),
        Promise.all([
          app.prisma.product.count({ where: { presentInFeed: true } }),
          app.prisma.product.count({
            where: {
              OR: [
                { lastSyncedAt: null },
                { lastSyncedAt: { lt: new Date(Date.now() - 86_400_000) } },
              ],
            },
          }),
        ])
          .then(([available, stale]) => ({
            available,
            stale,
            staleAfterHours: 24,
          }))
          .catch(() => null),
      ]);
    const workers = await Promise.all(
      Object.values(queueNames).map(async (name) => ({
        name,
        heartbeat: await app.redis
          .get(`worker:heartbeat:${name}`)
          .catch(() => null),
      })),
    );
    return {
      success: true,
      data: {
        status: database === "up" && redis === "up" ? "ok" : "degraded",
        database,
        redis,
        queues,
        workers,
        circuits: circuitBreakerSnapshots(),
        latestProductSync: latestSync,
        productMetrics,
        uptimeSeconds: Math.floor(process.uptime()),
        memory: process.memoryUsage(),
        checkedInMs: Date.now() - started,
        timestamp: new Date().toISOString(),
      },
    };
  });

  app.get("/api/admin/system/analytics", protectedRoute, async () => {
    const now = Date.now();
    const windows = await Promise.all(
      [1, 7, 30].map(async (days) => {
        const since = new Date(now - days * 86_400_000);
        const [customers, conversations, orders, failedEvents] =
          await Promise.all([
            app.prisma.customer.count({ where: { createdAt: { gte: since } } }),
            app.prisma.conversation.count({
              where: { createdAt: { gte: since } },
            }),
            app.prisma.order.count({ where: { createdAt: { gte: since } } }),
            app.prisma.systemLog.count({
              where: { createdAt: { gte: since }, level: "ERROR" },
            }),
          ]);
        return { days, customers, conversations, orders, failedEvents };
      }),
    );
    return { success: true, data: windows };
  });

  app.get("/api/admin/system/jobs", protectedRoute, async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 25));
    const selected = query.queue ? queueName(query.queue) : null;
    const queues = selected
      ? [[selected, app.queues[selected]] as const]
      : Object.entries(app.queues);
    const allRows: any[] = [];
    for (const [name, queue] of queues) {
      const jobs = await queue.getJobs(["failed"], 0, page * limit - 1);
      allRows.push(
        ...jobs.map((job) => ({
          queue: name,
          id: job.id,
          name: job.name,
          attemptsMade: job.attemptsMade,
          createdAt: new Date(job.timestamp).toISOString(),
          failedAt: job.finishedOn
            ? new Date(job.finishedOn).toISOString()
            : null,
          error: job.failedReason?.slice(0, 1_000),
          stack: job.stacktrace?.join("\n").slice(0, 20_000) ?? null,
        })),
      );
    }
    allRows.sort(
      (a, b) =>
        Date.parse(b.failedAt ?? b.createdAt) -
        Date.parse(a.failedAt ?? a.createdAt),
    );
    const rows = allRows.slice((page - 1) * limit, page * limit);
    const counts = await queueSnapshot(app);
    const total = counts
      .filter((item) => !selected || item.name === selected)
      .reduce((sum, item) => sum + Number((item.counts as any).failed ?? 0), 0);
    return {
      success: true,
      data: {
        items: rows,
        queues: counts,
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  });

  app.get("/api/admin/system/logs", protectedRoute, async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 25));
    const levelMap: Record<string, string> = {
      info: "INFO",
      warning: "WARN",
      error: "ERROR",
    };
    const moduleMap: Record<string, string[]> = {
      ai: ["ai"],
      messenger: ["messenger"],
      orders: ["orders"],
      products: ["products"],
      system: ["system"],
    };
    const conditions: any[] = [];
    if (query.filter && levelMap[query.filter])
      conditions.push({ level: levelMap[query.filter] });
    if (query.filter && moduleMap[query.filter])
      conditions.push({
        OR: [
          { module: { in: moduleMap[query.filter] } },
          { type: { startsWith: query.filter.toUpperCase() } },
        ],
      });
    if (query.search)
      conditions.push({
        OR: [
          { requestId: { contains: query.search } },
          { event: { contains: query.search, mode: "insensitive" } },
          { type: { contains: query.search, mode: "insensitive" } },
        ],
      });
    const where: any = conditions.length ? { AND: conditions } : {};
    const db = app.prisma as any;
    const [items, total] = await Promise.all([
      db.systemLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          createdAt: true,
          level: true,
          module: true,
          event: true,
          type: true,
          message: true,
          requestId: true,
          conversationId: true,
          customerId: true,
          metadata: true,
        },
      }),
      db.systemLog.count({ where }),
    ]);
    const safeItems = items.map((item: any) => ({
      ...item,
      status:
        item.metadata && typeof item.metadata === "object"
          ? (item.metadata.status ?? null)
          : null,
      metadata: undefined,
    }));
    return {
      success: true,
      data: {
        items: safeItems,
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  });

  app.post<{ Params: { queue: string; id: string } }>(
    "/api/admin/system/jobs/:queue/:id/retry",
    protectedRoute,
    async (request) => {
      const queue = app.queues[queueName(request.params.queue)];
      const job = await queue.getJob(request.params.id);
      if (!job) throw new NotFoundError("Job not found");
      if ((await job.getState()) !== "failed")
        throw new ValidationError("Only failed jobs can be retried");
      await job.retry();
      return { success: true, message: "Job queued for retry" };
    },
  );

  app.delete<{ Params: { queue: string; id: string } }>(
    "/api/admin/system/jobs/:queue/:id",
    protectedRoute,
    async (request) => {
      const queue = app.queues[queueName(request.params.queue)];
      const job = await queue.getJob(request.params.id);
      if (!job) throw new NotFoundError("Job not found");
      if ((await job.getState()) === "active")
        throw new ValidationError("Active jobs cannot be removed");
      await job.remove();
      return { success: true, message: "Job removed" };
    },
  );
}
