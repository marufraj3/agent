import { statfsSync } from 'node:fs';
import type { FastifyInstance } from "fastify";
import { ValidationError, NotFoundError } from "../errors/app-error.js";
import { circuitBreakerSnapshots } from "../infrastructure/circuit-breaker.js";
import {
  queueNames,
  type QueueName,
} from "../infrastructure/queue-registry.js";
import { requireAdmin } from "../modules/admin/auth/require-admin.js";

const SECRET_KEY = /token|secret|password|authorization|cookie|api[-_]?key/i;
const SECRET_VALUE = /(?:bearer\s+|ea[a-z0-9]{20,}|api[_-]?key\s*[=:])\S+/gi;
export function sanitizeText(value: unknown, max = 1_000): string | null {
  if (typeof value !== 'string') return null;
  return value.replace(SECRET_VALUE, '[REDACTED]').slice(0, max);
}
export function sanitizeMetadata(value: unknown, depth = 0): unknown {
  if (depth > 3) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeMetadata(item, depth + 1));
  if (!value || typeof value !== 'object') return typeof value === 'string' ? sanitizeText(value, 300) : value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 30).map(([key, item]) => [key, SECRET_KEY.test(key) ? '[REDACTED]' : sanitizeMetadata(item, depth + 1)]));
}
async function boundedStatus(check: Promise<unknown>, timeoutMs = 2_000): Promise<'up'|'down'> {
  let timer: NodeJS.Timeout | undefined;
  try { await Promise.race([check, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('dependency timeout')), timeoutMs); })]); return 'up'; }
  catch { return 'down'; }
  finally { if (timer) clearTimeout(timer); }
}
async function audit(app: FastifyInstance, type: string, metadata: Record<string, unknown>) {
  await app.prisma.systemLog.create({ data: { level: 'INFO', type, event: type, module: 'admin', message: type.replaceAll('_', ' ').toLowerCase(), metadata: sanitizeMetadata(metadata) as any } }).catch(() => undefined);
}
export function queueName(value: unknown): QueueName {
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
            "waiting",
            "active",
            "delayed",
            "completed",
            "failed",
          ),
          paused: await queue.isPaused(),
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
          paused: false,
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
        boundedStatus(app.prisma.$queryRaw`SELECT 1`),
        boundedStatus(app.redis.ping()),
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
    const alerts = queues.flatMap((queue) => {
      const counts = queue.counts as Record<string, number>;
      const backlog = Number(counts.waiting ?? 0) + Number(counts.delayed ?? 0);
      const failed = Number(counts.failed ?? 0);
      return [
        ...(backlog >= 1_000
          ? [{ type: 'QUEUE_BACKLOG_HIGH', queue: queue.name, value: backlog }]
          : []),
        ...(failed >= 100
          ? [{ type: 'QUEUE_FAILURE_COUNT_HIGH', queue: queue.name, value: failed }]
          : []),
      ];
    });
    const workers = await Promise.all(
      Object.values(queueNames).map(async (name) => ({
        name,
        heartbeat: await app.redis
          .get(`worker:heartbeat:${name}`)
          .catch(() => null),
      })),
    );
    let disk: { totalBytes: number; freeBytes: number } | null = null;
    try {
      const filesystem = statfsSync(process.cwd());
      disk = {
        totalBytes: filesystem.blocks * filesystem.bsize,
        freeBytes: filesystem.bavail * filesystem.bsize,
      };
    } catch (error) {
      app.log.warn({ err: error }, 'Could not read filesystem capacity metrics');
    }
    const [componentErrors, outgoing, media] = await Promise.all([
      app.prisma.systemLog.findMany({ where: { level: 'ERROR' }, orderBy: { createdAt: 'desc' }, take: 20, select: { module: true, type: true, message: true, createdAt: true } }).catch(() => []),
      (app.prisma as any).messengerOutgoingMessage.groupBy({ by: ['status'], _count: { _all: true } }).catch(() => []),
      Promise.all([
        (app.prisma as any).imageProcessing.count({ where: { status: 'FAILED' } }).catch(() => 0),
        (app.prisma as any).audioTranscription.count({ where: { status: 'FAILED' } }).catch(() => 0),
      ]),
    ]);
    const checkedAt = new Date().toISOString();
    const circuits = circuitBreakerSnapshots();
    const lastError = (modules: string[]) => {
      const item = componentErrors.find((entry: any) => modules.includes(String(entry.module ?? '').toLowerCase()) || modules.some((module) => String(entry.type).toLowerCase().includes(module)));
      return item ? { message: sanitizeText(item.message, 300), at: item.createdAt } : null;
    };
    const workerState = workers.some((worker) => worker.heartbeat) ? (workers.every((worker) => worker.heartbeat) ? 'up' : 'degraded') : 'down';
    const messengerFailed = outgoing.filter((item: any) => ['FAILED','PERMANENT_FAILURE'].includes(item.status)).reduce((sum: number, item: any) => sum + item._count._all, 0);
    const component = (name: string, status: string, error: any = null, latencyMs: number | null = null) => ({ name, status, checkedAt, latencyMs, lastError: error });
    const components = [
      component('Database', database, lastError(['database'])),
      component('Redis', redis, lastError(['redis'])),
      component('Gemini', circuits.find((item) => item.service === 'gemini')?.state ?? 'ready', lastError(['ai','gemini'])),
      component('Product sync', latestSync ? 'up' : 'unknown', lastError(['products','product_sync'])),
      component('Messenger webhook', 'up', lastError(['webhook'])),
      component('Messenger outgoing', messengerFailed ? 'degraded' : 'up', lastError(['messenger'])),
      component('Order API', circuits.find((item) => item.service === 'order-api')?.state ?? 'ready', lastError(['orders','order_api'])),
      component('Workers', workerState, lastError(['worker','queue'])),
      component('File & image processing', media[0] + media[1] > 0 ? 'degraded' : 'up', lastError(['image','audio','media'])),
    ];
    return {
      success: true,
      data: {
        status: database === "up" && redis === "up" ? "ok" : "degraded",
        database,
        redis,
        queues,
        workers,
        alerts,
        circuits,
        components,
        latestProductSync: latestSync,
        productMetrics,
        uptimeSeconds: Math.floor(process.uptime()),
        memory: process.memoryUsage(),
        disk,
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
          error: sanitizeText(job.failedReason, 1_000),
          metadata: sanitizeMetadata(job.data),
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
    const parsedPage = Number(query.page ?? 1);
    const parsedLimit = Number(query.limit ?? 25);
    if (!Number.isInteger(parsedPage) || parsedPage < 1 || !Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      throw new ValidationError('Invalid logs pagination');
    }
    if (query.search && query.search.length > 200) throw new ValidationError('Search is too long');
    if (query.cursor && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(query.cursor)) {
      throw new ValidationError('Invalid logs cursor');
    }
    const page = parsedPage;
    const limit = parsedLimit;
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
    const db = app.prisma as any;
    const cursor = query.cursor
      ? await db.systemLog.findUnique({
          where: { id: query.cursor },
          select: { id: true, createdAt: true },
        })
      : null;
    if (query.cursor && !cursor) throw new ValidationError('Logs cursor was not found');
    const baseWhere: any = conditions.length ? { AND: conditions } : {};
    const cursorCondition = cursor
      ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }
      : null;
    const itemWhere = cursorCondition
      ? { AND: [...conditions, cursorCondition] }
      : baseWhere;
    const [items, total] = await Promise.all([
      db.systemLog.findMany({
        where: itemWhere,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: cursor ? 0 : (page - 1) * limit,
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
      db.systemLog.count({ where: baseWhere }),
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
        nextCursor: items.length === limit ? items.at(-1)?.id ?? null : null,
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
      await audit(app, 'ADMIN_JOB_RETRIED', { queue: request.params.queue, jobId: request.params.id });
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
      if ((await job.getState()) === "active") throw new ValidationError("Active jobs cannot be removed");
      await job.remove();
      await audit(app, 'ADMIN_FAILED_JOB_REMOVED', { queue: request.params.queue, jobId: request.params.id });
      return { success: true, message: "Job removed" };
    },
  );

  app.post('/api/admin/system/queues/:queue/action', protectedRoute, async (request) => {
    const name = queueName((request.params as any).queue);
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (body.confirm !== true) throw new ValidationError('Explicit confirmation is required');
    const action = body.action;
    if (!['pause','resume','retry-failed','clean-completed'].includes(String(action))) throw new ValidationError('Invalid queue action');
    const queue = app.queues[name];
    let affected = 0;
    if (action === 'pause') await queue.pause();
    if (action === 'resume') await queue.resume();
    if (action === 'retry-failed') {
      const jobs = await queue.getJobs(['failed'], 0, 99);
      for (const job of jobs) { await job.retry(); affected += 1; }
    }
    if (action === 'clean-completed') affected = (await queue.clean(24 * 60 * 60 * 1_000, 1_000, 'completed')).length;
    await audit(app, 'ADMIN_QUEUE_ACTION', { queue: name, action, affected, reason: sanitizeText(body.reason, 200) });
    return { success: true, data: { queue: name, action, affected } };
  });

  app.post('/api/admin/system/jobs/retry-selected', protectedRoute, async (request) => {
    const body = (request.body ?? {}) as any;
    if (body.confirm !== true || !Array.isArray(body.jobs) || body.jobs.length < 1 || body.jobs.length > 100) throw new ValidationError('One to 100 jobs and confirmation are required');
    let retried = 0;
    for (const selected of body.jobs) {
      const name = queueName(selected?.queue);
      if (typeof selected?.id !== 'string' || selected.id.length > 200) throw new ValidationError('Invalid job identifier');
      const job = await app.queues[name].getJob(selected.id);
      if (job && await job.getState() === 'failed') { await job.retry(); retried += 1; }
    }
    await audit(app, 'ADMIN_JOBS_BULK_RETRIED', { requested: body.jobs.length, retried });
    return { success: true, data: { retried } };
  });

  app.get('/api/admin/ai-monitoring', protectedRoute, async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const page = Math.max(1, Number(query.page) || 1); const limit = Math.min(100, Math.max(1, Number(query.limit) || 25));
    const from = query.from ? new Date(query.from) : new Date(Date.now() - 7 * 86_400_000); const to = query.to ? new Date(query.to) : new Date();
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from || to.getTime() - from.getTime() > 366 * 86_400_000) throw new ValidationError('Invalid AI monitoring date range');
    const db = app.prisma as any;
    const rows = await db.$queryRawUnsafe(`SELECT COUNT(*)::int AS requests, COUNT(*) FILTER (WHERE type='AI_RESPONSE_FAILED')::int AS errors, COUNT(*) FILTER (WHERE metadata->>'provider' <> 'gemini')::int AS fallbacks, COUNT(*) FILTER (WHERE COALESCE((metadata->>'latencyMs')::numeric,0) >= 3000)::int AS slow, ROUND(AVG(COALESCE((metadata->>'latencyMs')::numeric,0)))::int AS "averageLatencyMs", COUNT(*) FILTER (WHERE metadata->>'requiresHuman'='true')::int AS handovers, COUNT(*) FILTER (WHERE metadata ? 'selectedProductIds')::int AS recommendations FROM system_logs WHERE module='ai' AND created_at >= $1 AND created_at < $2`, from, to).catch(() => [{ requests: 0, errors: 0, fallbacks: 0, slow: 0, averageLatencyMs: 0, handovers: 0, recommendations: 0 }]);
    const where: any = { module: 'ai', level: 'ERROR', createdAt: { gte: from, lt: to }, ...(query.search ? { OR: [{ type: { contains: query.search, mode: 'insensitive' } }, { message: { contains: query.search, mode: 'insensitive' } }] } : {}) };
    const [errors, total, intents] = await Promise.all([
      db.systemLog.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit, select: { id: true, type: true, message: true, createdAt: true, metadata: true } }),
      db.systemLog.count({ where }),
      db.$queryRawUnsafe(`SELECT COALESCE(metadata->>'intent','unknown') AS intent, COUNT(*)::int AS count FROM system_logs WHERE module='ai' AND created_at >= $1 AND created_at < $2 GROUP BY 1 ORDER BY 2 DESC LIMIT 30`, from, to).catch(() => []),
    ]);
    return { success: true, data: { metrics: rows[0], intents, errors: errors.map((item: any) => ({ ...item, message: sanitizeText(item.message), metadata: sanitizeMetadata(item.metadata) })), page, limit, total, pages: Math.ceil(total / limit), from, to } };
  });

  const controlKeys = ['system.maintenance_mode','ai.emergency_disabled','messenger.emergency_stop','orders.submission_paused','product_sync.paused'] as const;
  app.get('/api/admin/system/controls', protectedRoute, async () => {
    const settings = await app.prisma.setting.findMany({ where: { key: { in: [...controlKeys] } }, select: { key: true, value: true, updatedAt: true } });
    return { success: true, data: Object.fromEntries(controlKeys.map((key) => [key, settings.find((item: { key: string }) => item.key === key) ?? { key, value: 'false', updatedAt: null }])) };
  });
  app.put('/api/admin/system/controls/:key', protectedRoute, async (request) => {
    const key = decodeURIComponent(String((request.params as any).key)); const body = (request.body ?? {}) as any;
    if (!controlKeys.includes(key as any)) throw new ValidationError('Unknown operational control');
    if (typeof body.enabled !== 'boolean' || body.confirm !== true || typeof body.reason !== 'string' || body.reason.trim().length < 4 || body.reason.length > 300) throw new ValidationError('Confirmation and a reason are required');
    await app.prisma.$transaction([
      app.prisma.setting.upsert({ where: { key }, create: { key, value: String(body.enabled), description: 'Emergency operational control' }, update: { value: String(body.enabled) } }),
      app.prisma.systemLog.create({ data: { level: body.enabled ? 'WARN' : 'INFO', type: 'ADMIN_OPERATIONAL_CONTROL_CHANGED', event: 'ADMIN_OPERATIONAL_CONTROL_CHANGED', module: 'admin', message: `${key} ${body.enabled ? 'enabled' : 'disabled'}`, metadata: { key, enabled: body.enabled, reason: body.reason.trim() } } }),
    ]);
    return { success: true, data: { key, enabled: body.enabled } };
  });

  app.get('/api/admin/activity-log', protectedRoute, async (request) => {
    const query = request.query as Record<string, string | undefined>; const page = Math.max(1, Number(query.page) || 1); const limit = Math.min(100, Math.max(1, Number(query.limit) || 25));
    const where: any = { OR: [{ module: { in: ['admin','inbox','handovers'] } }, { type: { startsWith: 'ADMIN_' } }], ...(query.search ? { AND: [{ OR: [{ type: { contains: query.search, mode: 'insensitive' } }, { message: { contains: query.search, mode: 'insensitive' } }] }] } : {}) };
    const [items,total] = await Promise.all([app.prisma.systemLog.findMany({ where, orderBy: [{ createdAt: 'desc' },{ id: 'desc' }], skip: (page-1)*limit, take: limit, select: { id:true,createdAt:true,level:true,type:true,message:true,module:true,metadata:true } }), app.prisma.systemLog.count({ where })]);
    return { success: true, data: { items: items.map((item: any) => ({ ...item, metadata: sanitizeMetadata(item.metadata) })), page, limit, total, pages: Math.ceil(total/limit) } };
  });

  app.get('/api/admin/global-search', protectedRoute, async (request) => {
    const term = String((request.query as any).q ?? '').trim(); if (term.length < 2 || term.length > 100) throw new ValidationError('Search must be 2 to 100 characters');
    const uuid = /^[0-9a-f-]{36}$/i.test(term); const numeric = /^\d+$/.test(term) ? Number(term) : null; const db = app.prisma as any;
    const [customers,conversations,orders,products] = await Promise.all([
      db.customer.findMany({ where: { OR: [{ name: { contains: term, mode:'insensitive' } },{ phone: { contains: term } }] }, take: 10, select: { id:true,name:true,phone:true } }),
      db.conversation.findMany({ where: uuid ? { id: term } : { customer: { is: { OR: [{ name:{ contains:term,mode:'insensitive' } },{ phone:{ contains:term } }] } } }, take: 10, select: { id:true,status:true,channel:true,lastMessageAt:true } }),
      db.order.findMany({ where: { OR: [...(uuid ? [{ id:term },{ conversationId:term }] : []),{ orderCode:{ contains:term,mode:'insensitive' } },{ externalOrderId:{ contains:term,mode:'insensitive' } },{ customer:{ is:{ OR:[{ name:{ contains:term,mode:'insensitive' } },{ phone:{ contains:term } }] } } }] }, take:10, select:{ id:true,orderCode:true,externalOrderId:true,status:true,totalAmount:true } }),
      db.product.findMany({ where:{ OR:[...(numeric === null ? [] : [{ websiteProductId:numeric }]),{ productCode:{ contains:term,mode:'insensitive' } },{ productName:{ contains:term,mode:'insensitive' } }] }, take:10, select:{ id:true,websiteProductId:true,productCode:true,productName:true,presentInFeed:true } }),
    ]);
    return { success:true,data:{ customers,conversations,orders,products } };
  });

  app.get('/api/admin/system/notifications', protectedRoute, async (request) => {
    const query=request.query as any; const page=Math.max(1,Number(query.page)||1); const limit=Math.min(100,Math.max(1,Number(query.limit)||25)); const unresolved=query.resolved==='true'?{}:{ resolvedAt:null }; const db=app.prisma as any;
    const [items,total]=await Promise.all([db.messengerAlert.findMany({where:unresolved,orderBy:{createdAt:'desc'},skip:(page-1)*limit,take:limit,select:{id:true,pageId:true,type:true,severity:true,message:true,metadata:true,resolvedAt:true,createdAt:true}}),db.messengerAlert.count({where:unresolved})]);
    return {success:true,data:{items:items.map((item:any)=>({...item,source:(item.metadata as any)?.source??(item.pageId?'messenger':'system'),metadata:undefined})),page,limit,total,pages:Math.ceil(total/limit)}};
  });
  app.post('/api/admin/system/notifications/:id/resolve', protectedRoute, async (request) => { const id=String((request.params as any).id); await (app.prisma as any).messengerAlert.update({where:{id},data:{resolvedAt:new Date()}}).catch(()=>{throw new NotFoundError('Notification not found');}); await audit(app,'ADMIN_NOTIFICATION_RESOLVED',{notificationId:id}); return {success:true}; });
}
