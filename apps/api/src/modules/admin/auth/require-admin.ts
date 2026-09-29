import type { FastifyRequest } from 'fastify';
import { env } from '../../../config/env.js';
import { AppError } from '../../../errors/app-error.js';
import { isAdminPasswordValid } from './admin-password.js';
import { ADMIN_SESSION_COOKIE, parseCookies, verifyAdminSession } from './admin-session.js';

/** Server-side guard. Cookie sessions are preferred; the constant-time header check remains for CLI/backward compatibility. */
export function requireAdmin(request: FastifyRequest): void {
  if (!env.ADMIN_PASSWORD) throw new AppError('Admin operations are not configured', 503, 'ADMIN_NOT_CONFIGURED');
  const cookie = parseCookies(request.headers.cookie)[ADMIN_SESSION_COOKIE];
  if (verifyAdminSession(cookie, env.ADMIN_PASSWORD)) return;
  if (isAdminPasswordValid(request.headers['x-admin-password'], env.ADMIN_PASSWORD)) return;
  throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
}
