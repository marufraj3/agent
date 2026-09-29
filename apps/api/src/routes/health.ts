import type { FastifyInstance } from 'fastify';

export async function bounded(check: Promise<unknown>, timeoutMs = 2_000): Promise<'up' | 'down'> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([check, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('health timeout')), timeoutMs); })]);
    return 'up';
  } catch { return 'down'; }
  finally { if (timer) clearTimeout(timer); }
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  const liveness = async () => ({ status: 'ok', service: 'alzeena-api', timestamp: new Date().toISOString(), uptimeSeconds: Math.floor(process.uptime()) });
  const readiness = async (_request: unknown, reply: any) => {
    const [database, redis] = await Promise.all([
      bounded(app.prisma.$queryRaw`SELECT 1`),
      bounded(app.redis.ping()),
    ]);
    const healthy = database === 'up' && redis === 'up';
    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded', service: 'alzeena-api',
      timestamp: new Date().toISOString(), uptimeSeconds: Math.floor(process.uptime()),
      dependencies: { database, redis },
    });
  };
  app.get('/health', liveness);
  app.get('/api/health', liveness);
  app.get('/ready', readiness);
  app.get('/api/health/readiness', readiness);
}
