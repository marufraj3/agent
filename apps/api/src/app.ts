import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { env } from './config/env.js';
import { loggerOptions } from './config/logger.js';
import { AppError } from './errors/app-error.js';
import { registerInfrastructure } from './infrastructure/register.js';
import { adminRoutes } from './modules/admin/routes/admin.routes.js';
import { aiTestRoutes } from './modules/ai/routes/ai-test.routes.js';
import { audioRoutes } from './modules/audio/routes/audio.routes.js';
import { chatRoutes } from './modules/conversations/routes/chat.routes.js';
import { conversationAdminRoutes } from './modules/conversations/routes/conversation-admin.routes.js';
import { imageRoutes } from './modules/images/routes/image.routes.js';
import { productRoutes } from './modules/products/routes/product.routes.js';
import { productSyncRoutes } from './modules/products/routes/product-sync.routes.js';
import { healthRoutes } from './routes/health.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: loggerOptions });

  await app.register(cors, {
    origin: env.FRONTEND_URL,
    credentials: true,
  });
  await registerInfrastructure(app);
  await app.register(healthRoutes);
  await app.register(adminRoutes);
  await app.register(aiTestRoutes);
  await app.register(audioRoutes);
  await app.register(chatRoutes);
  await app.register(conversationAdminRoutes);
  await app.register(imageRoutes);
  await app.register(productRoutes);
  await app.register(productSyncRoutes);

  app.setNotFoundHandler(async (_request, reply) => {
    return reply.code(404).send({
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    });
  });

  app.setErrorHandler(async (error, request, reply) => {
    const isAppError = error instanceof AppError;
    const statusCode = isAppError ? error.statusCode : 500;
    const code = isAppError ? error.code : 'INTERNAL_ERROR';

    request.log.error({ err: error }, 'Request failed');

    return reply.code(statusCode).send({
      error: {
        code,
        message: isAppError ? error.message : 'An unexpected error occurred',
        requestId: request.id,
      },
    });
  });

  return app;
}
