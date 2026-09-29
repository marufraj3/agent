import type { Redis } from 'ioredis';
import { RateLimitError } from '../errors/app-error.js';

export async function enforceRateLimit(
  redis: Redis,
  scope: string,
  identity: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const bucket = Math.floor(Date.now() / (windowSeconds * 1_000));
  const key = `rate:${scope}:${identity}:${bucket}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSeconds + 2);
  if (count > limit) throw new RateLimitError();
}
