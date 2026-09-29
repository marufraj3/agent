import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../../admin/auth/require-admin.js';
import { PRODUCT_SYNC_JOB_NAME } from '../product-sync.queue.js';

export async function productSyncRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/admin/product-sync', async (request, reply) => {
    requireAdmin(request);

    const job = await app.productSyncQueue.add(PRODUCT_SYNC_JOB_NAME, {});
    request.log.info({ jobId: job.id }, 'Product sync job queued');

    return reply.code(202).send({
      success: true,
      message: 'Product sync job queued',
      jobId: job.id,
    });
  });

  app.get('/api/admin/product-sync/status', async (request) => {
    requireAdmin(request);

    const logs = await app.prisma.systemLog.findMany({
      where: {
        type: {
          in: ['PRODUCT_SYNC_STARTED', 'PRODUCT_SYNC_COMPLETED', 'PRODUCT_SYNC_FAILED'],
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        level: true,
        type: true,
        message: true,
        metadata: true,
        createdAt: true,
      },
    });

    return { success: true, latest: logs[0] ?? null, history: logs };
  });
}
