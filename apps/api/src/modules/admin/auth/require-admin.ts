import type { FastifyRequest } from 'fastify';
import { env } from '../../../config/env.js';
import { AppError } from '../../../errors/app-error.js';
import { isAdminPasswordValid } from './admin-password.js';

export function requireAdmin(request: FastifyRequest): void {
  if (!env.ADMIN_PASSWORD) {
    throw new AppError('Admin operations are not configured', 503, 'ADMIN_NOT_CONFIGURED');
  }

  if (!isAdminPasswordValid(request.headers['x-admin-password'], env.ADMIN_PASSWORD)) {
    throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  }
}
