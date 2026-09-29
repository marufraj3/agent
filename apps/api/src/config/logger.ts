import type { FastifyServerOptions } from 'fastify';
import { env } from './env.js';

export const loggerOptions: FastifyServerOptions['logger'] = {
  level: env.LOG_LEVEL,
  ...(env.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard' },
        },
      }
    : {}),
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-admin-password"]',
      'req.headers["x-hub-signature-256"]',
      '*.FACEBOOK_APP_SECRET',
      '*.FACEBOOK_PAGE_ACCESS_TOKEN',
      '*.FACEBOOK_VERIFY_TOKEN',
      'res.headers["set-cookie"]',
    ],
    censor: '[REDACTED]',
  },
};
