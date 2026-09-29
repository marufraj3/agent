import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };
const queryEvents = process.env.NODE_ENV !== 'production';
export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  log: queryEvents
    ? [{ emit: 'event', level: 'query' }, { emit: 'stdout', level: 'warn' }, { emit: 'stdout', level: 'error' }]
    : [{ emit: 'stdout', level: 'error' }],
});
if (queryEvents) {
  const threshold = Math.max(50, Number(process.env.SLOW_QUERY_LOG_MS) || 500);
  prisma.$on('query', (event: { duration: number; target: string }) => {
    if (event.duration >= threshold) console.warn(JSON.stringify({ event: 'DATABASE_SLOW_QUERY', durationMs: event.duration, target: event.target, timestamp: new Date().toISOString() }));
  });
}
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
export { Prisma } from '@prisma/client';
export type { PrismaClient } from '@prisma/client';
