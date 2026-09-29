import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { env } from './config/env.js';
import { loggerOptions } from './config/logger.js';
import { AppError } from './errors/app-error.js';
import { registerInfrastructure } from './infrastructure/register.js';
import { enforceRateLimit } from './infrastructure/rate-limit.js';
import { adminRoutes } from './modules/admin/routes/admin.routes.js';
import { dashboardRoutes } from './modules/admin/routes/dashboard.routes.js';
import { aiTestRoutes } from './modules/ai/routes/ai-test.routes.js';
import { audioRoutes } from './modules/audio/routes/audio.routes.js';
import { automationRoutes } from './modules/automation/routes/automation.routes.js';
import { messengerRoutes } from './modules/channels/messenger/routes/messenger.routes.js';
import { chatRoutes } from './modules/conversations/routes/chat.routes.js';
import { conversationAdminRoutes } from './modules/conversations/routes/conversation-admin.routes.js';
import { imageRoutes } from './modules/images/routes/image.routes.js';
import { inboxRoutes } from './modules/inbox/routes/inbox.routes.js';
import { orderAdminRoutes } from './modules/orders/routes/order-admin.routes.js';
import { productRoutes } from './modules/products/routes/product.routes.js';
import { productSyncRoutes } from './modules/products/routes/product-sync.routes.js';
import { recommendationRoutes } from './modules/recommendations/routes/recommendation.routes.js';
import { salesIntelligenceRoutes } from './modules/sales-intelligence/routes/sales-intelligence.routes.js';
import { healthRoutes } from './routes/health.js';
import { systemRoutes } from './routes/system.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions,
    bodyLimit: env.API_BODY_LIMIT_BYTES,
    requestTimeout: 30_000,
    keepAliveTimeout: 72_000,
    genReqId: (request) => {
      const supplied = request.headers['x-request-id'];
      return typeof supplied === 'string' && /^[a-zA-Z0-9._:-]{8,128}$/.test(supplied)
        ? supplied
        : randomUUID();
    },
  });

  await app.register(cors, {
    origin: env.FRONTEND_URL,
    credentials: true,
  });
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (env.NODE_ENV === 'production') reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    return payload;
  });
  await registerInfrastructure(app);
  app.addHook('onRequest', async (request) => {
    const path = request.url.split('?')[0]!;
    if (path.startsWith('/api/admin/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      if (origin && origin !== env.FRONTEND_URL) throw new AppError('Forbidden origin', 403, 'FORBIDDEN_ORIGIN');
    }
    if (!path.startsWith('/api/') || path.startsWith('/api/webhooks/facebook')) return;
    const [scope, limit] = path === '/api/admin/session'
      ? ['admin-login', env.ADMIN_LOGIN_RATE_LIMIT_PER_15_MINUTES * 4]
      : path.startsWith('/api/admin/')
        ? ['admin-api', env.ADMIN_API_RATE_LIMIT_PER_MINUTE]
        : path.startsWith('/api/ai/')
          ? ['ai-api', env.AI_CUSTOMER_RATE_LIMIT_PER_MINUTE]
          : ['public-api', env.PUBLIC_API_RATE_LIMIT_PER_MINUTE];
    await enforceRateLimit(app.redis, scope, request.ip, limit, 60);
  });
  await app.register(healthRoutes);
  await app.register(systemRoutes);
  await app.register(adminRoutes);
  await app.register(dashboardRoutes);
  await app.register(aiTestRoutes);
  await app.register(audioRoutes);
  await app.register(automationRoutes);
  await app.register(messengerRoutes);
  await app.register(chatRoutes);
  await app.register(conversationAdminRoutes);
  await app.register(imageRoutes);
  await app.register(inboxRoutes);
  await app.register(orderAdminRoutes);
  await app.register(productRoutes);
  await app.register(productSyncRoutes);
  await app.register(recommendationRoutes);
  await app.register(salesIntelligenceRoutes);

  app.setNotFoundHandler(async (_request, reply) => {
    return reply.code(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Route not found', requestId: reply.request.id },
    });
  });

  app.setErrorHandler(async (error, request, reply) => {
    const isAppError = error instanceof AppError;
    const statusCode = isAppError ? error.statusCode : 500;
    const code = isAppError ? error.code : 'INTERNAL_ERROR';

    const message = isAppError && error.expose ? error.message : 'An unexpected error occurred';
    request.log.error(
      {
        requestId: request.id,
        errorCode: code,
        errorType: error instanceof Error ? error.name : 'UnknownError',
        ...(env.NODE_ENV === 'development' ? { err: error } : {}),
      },
      'Request failed',
    );

    if (statusCode === 429) reply.header('retry-after', '60');
    return reply.code(statusCode).send({
      success: false,
      error: { code, message, requestId: request.id },
    });
  });

  return app;
}
