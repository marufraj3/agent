import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { env } from '../../../config/env.js';
import { AppError } from '../../../errors/app-error.js';
import { PRODUCT_SYNC_JOB_NAME } from '../product-sync.queue.js';

function requireAdminPassword(request: FastifyRequest): void {
  if (!env.ADMIN_PASSWORD) {
    throw new AppError('Admin operations are not configured', 503, 'ADMIN_NOT_CONFIGURED');
  }

  const supplied = request.headers['x-admin-password'];
  if (typeof supplied !== 'string') {
    throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  }

  const expectedBuffer = Buffer.from(env.ADMIN_PASSWORD);
  const suppliedBuffer = Buffer.from(supplied);
  const matches =
    expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);

  if (!matches) throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
}

export async function productSyncRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/admin/product-sync', async (request, reply) => {
    requireAdminPassword(request);

    const job = await app.productSyncQueue.add(PRODUCT_SYNC_JOB_NAME, {});
    request.log.info({ jobId: job.id }, 'Product sync job queued');

    return reply.code(202).send({
      success: true,
      message: 'Product sync job queued',
      jobId: job.id,
    });
  });

  app.get('/api/admin/product-sync/status', async (request) => {
    requireAdminPassword(request);

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
