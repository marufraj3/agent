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
  // Prisma's generated client erases event names when a cached global client is
  // unioned with an event-enabled client. The runtime subscription remains
  // valid because the development client above explicitly configures query
  // events with `emit: 'event'`.
  const eventClient = prisma as unknown as {
    $on(event: 'query', callback: (event: { duration: number; target: string }) => void): void;
  };
  eventClient.$on('query', (event) => {
    if (event.duration >= threshold) console.warn(JSON.stringify({ event: 'DATABASE_SLOW_QUERY', durationMs: event.duration, target: event.target, timestamp: new Date().toISOString() }));
  });
}
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
export { Prisma } from '@prisma/client';
export type { PrismaClient } from '@prisma/client';
