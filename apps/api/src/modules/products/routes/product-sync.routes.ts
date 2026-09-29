import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../../admin/auth/require-admin.js';
import { PRODUCT_SYNC_JOB_NAME } from '../product-sync.queue.js';
import { AppError, NotFoundError, ValidationError } from '../../../errors/app-error.js';

export async function productSyncRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/admin/product-sync', async (request, reply) => {
    requireAdmin(request);

    const [controls, counts] = await Promise.all([
      app.prisma.setting.findMany({ where: { key: { in: ['product_sync.paused','system.maintenance_mode'] }, value: 'true' }, select: { key: true } }),
      app.productSyncQueue.getJobCounts('active','waiting','delayed'),
    ]);
    if (controls.length) throw new AppError('Product synchronization is paused by an operational control', 503, 'PRODUCT_SYNC_PAUSED');
    if (Number(counts.active) + Number(counts.waiting) + Number(counts.delayed) > 0) throw new AppError('A product synchronization is already queued or running', 409, 'PRODUCT_SYNC_IN_PROGRESS');
    const acquired = await app.redis.set('control:product-sync:enqueue', String(Date.now()), 'PX', 60_000, 'NX');
    if (!acquired) throw new AppError('A product synchronization was just requested', 409, 'PRODUCT_SYNC_IN_PROGRESS');
    let job;
    try { job = await app.productSyncQueue.add(PRODUCT_SYNC_JOB_NAME, {}); }
    catch (error) { await app.redis.del('control:product-sync:enqueue'); throw error; }
    await app.prisma.systemLog.create({ data: { level: 'INFO', type: 'ADMIN_PRODUCT_SYNC_QUEUED', event: 'ADMIN_PRODUCT_SYNC_QUEUED', module: 'admin', message: 'manual product sync queued', metadata: { jobId: job.id } } });
    request.log.info({ jobId: job.id }, 'Product sync job queued');

    return reply.code(202).send({
      success: true,
      message: 'Product sync job queued',
      data: { jobId: job.id },
    });
  });

  app.get('/api/admin/product-sync/status', async (request) => {
    requireAdmin(request);
    const query = request.query as Record<string,string|undefined>; const page = Math.max(1, Number(query.page) || 1); const limit = Math.min(100, Math.max(1, Number(query.limit) || 25));
    const where = {
        type: {
          in: ['PRODUCT_SYNC_STARTED', 'PRODUCT_SYNC_COMPLETED', 'PRODUCT_SYNC_FAILED'],
        },
      };
    const [logs,total,counts,paused] = await Promise.all([app.prisma.systemLog.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        level: true,
        type: true,
        message: true,
        metadata: true,
        createdAt: true,
      },
    }), app.prisma.systemLog.count({ where }), app.productSyncQueue.getJobCounts('active','waiting','delayed','failed'), app.prisma.setting.findUnique({where:{key:'product_sync.paused'},select:{value:true}})]);

    return { success: true, data: { latest: logs[0] ?? null, history: logs, counts, paused: paused?.value === 'true', page, limit, total, pages: Math.ceil(total / limit) } };
  });

  app.post('/api/admin/product-sync/jobs/:id/retry', async (request) => {
    requireAdmin(request); const id = String((request.params as any).id); const body = (request.body ?? {}) as any;
    if (body.confirm !== true) throw new ValidationError('Confirmation is required');
    const job = await app.productSyncQueue.getJob(id); if (!job) throw new NotFoundError('Product sync job not found');
    if (await job.getState() !== 'failed') throw new ValidationError('Only failed product sync jobs can be retried');
    const active = await app.productSyncQueue.getJobCounts('active','waiting','delayed'); if (Number(active.active ?? 0) + Number(active.waiting ?? 0) + Number(active.delayed ?? 0) > 0) throw new AppError('A product sync is already queued or running',409,'PRODUCT_SYNC_IN_PROGRESS');
    await job.retry(); await app.prisma.systemLog.create({data:{level:'INFO',type:'ADMIN_PRODUCT_SYNC_RETRIED',event:'ADMIN_PRODUCT_SYNC_RETRIED',module:'admin',message:'product sync retried',metadata:{jobId:id}}});
    return {success:true,data:{jobId:id}};
  });

}
