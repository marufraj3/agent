import type { FastifyRequest } from "fastify";
import { env } from "../../../config/env.js";
import { AppError, RateLimitError } from "../../../errors/app-error.js";
import { isAdminPasswordValid } from "./admin-password.js";

const attempts = new Map<string, { window: number; count: number }>();
const MAX_ATTEMPTS_PER_MINUTE = 10;

export function requireAdmin(request: FastifyRequest): void {
  if (!env.ADMIN_PASSWORD) {
    throw new AppError(
      "Admin operations are not configured",
      503,
      "ADMIN_NOT_CONFIGURED",
    );
  }
  const window = Math.floor(Date.now() / 60_000);
  const current = attempts.get(request.ip);
  if (
    current &&
    current.window === window &&
    current.count >= MAX_ATTEMPTS_PER_MINUTE
  ) {
    throw new RateLimitError("Too many admin authentication attempts");
  }
  if (
    !isAdminPasswordValid(
      request.headers["x-admin-password"],
      env.ADMIN_PASSWORD,
    )
  ) {
    if (!current || current.window !== window)
      attempts.set(request.ip, { window, count: 1 });
    else current.count += 1;
    if (attempts.size > 10_000) attempts.clear();
    throw new AppError("Unauthorized", 401, "UNAUTHORIZED");
  }
  attempts.delete(request.ip);
}
