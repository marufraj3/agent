import type { FastifyRequest } from 'fastify';
import { env } from '../../config/env.js';
import { AppError } from '../../errors/app-error.js';

const requestsByAddress = new Map<string, number[]>();

export function enforceAIRateLimit(request: FastifyRequest): void {
  const now = Date.now();
  const cutoff = now - 60_000;
  const recent = (requestsByAddress.get(request.ip) ?? []).filter((timestamp) => timestamp > cutoff);
  if (recent.length >= env.AI_TEST_RATE_LIMIT_PER_MINUTE) {
    throw new AppError('AI request rate limit exceeded. Try again shortly.', 429, 'RATE_LIMITED');
  }
  recent.push(now);
  requestsByAddress.set(request.ip, recent);

  if (requestsByAddress.size > 10_000) {
    for (const [address, timestamps] of requestsByAddress) {
      if (timestamps.every((timestamp) => timestamp <= cutoff)) requestsByAddress.delete(address);
      if (requestsByAddress.size <= 5_000) break;
    }
  }
}
