import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_request, reply) => {
    const checks = await Promise.allSettled([
      app.prisma.$queryRaw`SELECT 1`,
      app.redis.ping(),
    ]);

    const database = checks[0].status === 'fulfilled' ? 'up' : 'down';
    const redis = checks[1].status === 'fulfilled' ? 'up' : 'down';
    const healthy = database === 'up' && redis === 'up';

    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      service: 'alzeena-api',
      timestamp: new Date().toISOString(),
      dependencies: { database, redis },
    });
  });
}
