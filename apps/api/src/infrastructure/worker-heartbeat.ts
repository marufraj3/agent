import type { Redis } from 'ioredis';

export function startWorkerHeartbeat(redis: Redis, queueName: string) {
  const key = `worker:heartbeat:${queueName}`;
  const beat = () => redis.set(key, new Date().toISOString(), 'EX', 30).catch(() => undefined);
  void beat();
  const timer = setInterval(() => void beat(), 10_000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await redis.del(key).catch(() => undefined);
  };
}
