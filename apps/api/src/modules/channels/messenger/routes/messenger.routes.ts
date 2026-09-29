import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { env } from '../../../../config/env.js';
import { AppError } from '../../../../errors/app-error.js';
import { requireAdmin } from '../../../admin/auth/require-admin.js';
import { getMessengerConfig, isMessengerConfigured } from '../messenger.config.js';
import { MessengerEventParser } from '../messenger.parser.js';
import { enqueueMessengerEvent } from '../messenger.queue.js';
import { verifyMessengerSignature } from '../messenger.signature.js';
import type { NormalizedMessengerEvent } from '../messenger.types.js';
import { AudioIngestionService, AudioRateLimitError } from '../../../audio/audio-ingestion.service.js';
import { ImageIngestionService } from '../../../images/image-ingestion.service.js';
import { enqueueMessengerOutgoing } from '../messenger-outgoing.queue.js';
import { decryptMessengerToken, encryptMessengerToken, maskMessengerToken } from '../messenger.credentials.js';
import { MetaGraphClient } from '../meta-graph.client.js';
import { queueNames } from '../../../../infrastructure/queue-registry.js';

async function enforceWebhookRate(app: FastifyInstance, request: FastifyRequest) {
  const key = `rate:messenger-webhook:${request.ip}:${Math.floor(Date.now() / 60_000)}`;
  const count = await app.redis.incr(key); if (count === 1) await app.redis.expire(key, 70);
  if (count > env.MESSENGER_WEBHOOK_RATE_LIMIT_PER_MINUTE) throw new AppError('Webhook rate limit exceeded', 429, 'RATE_LIMITED');
}

async function registerEvent(
  app: FastifyInstance,
  event: NormalizedMessengerEvent,
  requestId?: string,
  audioIngestion?: AudioIngestionService,
  imageIngestion?: ImageIngestionService,
) {
  const db = app.prisma as any;
  const correlationId = requestId ? `${requestId}:${event.externalEventId.slice(-32)}`.slice(0, 128) : randomUUID();
  let log = await db.messengerEventLog.findUnique({ where: { externalEventId: event.externalEventId } });
  if (log && ['QUEUED', 'PROCESSING', 'PROCESSED', 'IGNORED'].includes(log.status)) return false;
  if (!log) {
    try {
      log = await db.messengerEventLog.create({
        data: {
          externalEventId: event.externalEventId,
          externalMessageId: event.messageId,
          eventType: event.eventType === 'message' ? `message.${event.messageType}` : event.eventType,
          pageId: event.pageId,
          senderId: event.senderId,
          status: event.eventType === 'message_echo' ? 'QUEUED' : 'RECEIVED',
          correlationId,
          sanitizedPayload: { eventType: event.eventType, messageType: event.messageType, messageId: event.messageId || null, timestamp: event.timestamp, text: event.text ? event.text.slice(0, 4_000) : undefined, deliveryMessageIds: event.deliveryMessageIds, watermark: event.watermark },
          queuedAt: new Date(),
        },
      });
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')) throw error;
      log = await db.messengerEventLog.findUnique({ where: { externalEventId: event.externalEventId } });
      if (!log || ['QUEUED', 'PROCESSING', 'PROCESSED'].includes(log.status)) return false;
    }
  }
  try {
    if (event.eventType === 'message' && event.messageType === 'audio' && audioIngestion) {
      try {
        await audioIngestion.ingest(event, log.id, requestId);
      } catch (error) {
        if (!(error instanceof AudioRateLimitError)) throw error;
        // Customer-safe rate-limit replies are delivered by the normal Messenger worker.
        await enqueueMessengerEvent(app.messengerEventQueue, { eventLogId: log.id, event, requestId, correlationId });
      }
    } else if (event.eventType === 'message' && event.messageType === 'image' && imageIngestion) {
      await imageIngestion.ingest(event, log.id, requestId);
    } else {
      await enqueueMessengerEvent(app.messengerEventQueue, { eventLogId: log.id, event, requestId, correlationId });
    }
    await Promise.all([
      db.messengerEventLog.update({ where: { id: log.id }, data: { status: 'QUEUED', queuedAt: new Date(), errorMessage: null } }),
      ...(db.messengerPage?.upsert ? [db.messengerPage.upsert({ where: { pageId: event.pageId }, create: { pageId: event.pageId, connectionStatus: 'CONNECTED', aiEnabled: true, lastWebhookAt: new Date() }, update: { lastWebhookAt: new Date() } })] : []),
    ]);
    return true;
  } catch (error) {
    await db.messengerEventLog.update({ where: { id: log.id }, data: { status: 'RECEIVED', errorType: 'QUEUE_ERROR', retryCount: { increment: 1 }, errorMessage: 'Messenger queue is temporarily unavailable' } });
    if (db.messengerAlert?.create) await db.messengerAlert.create({ data: { pageId: event.pageId, type: 'WEBHOOK_QUEUE_ERROR', message: 'A validated webhook event could not be queued', metadata: { eventId: event.externalEventId, correlationId } } });
    throw error;
  }
}

export async function messengerRoutes(app: FastifyInstance): Promise<void> {
  const config = getMessengerConfig();
  const parser = new MessengerEventParser();
  const audioIngestion = app.audioTranscriptionQueue
    ? new AudioIngestionService(app.prisma, app.audioTranscriptionQueue, app.redis, env.AUDIO_RATE_LIMIT_PER_MINUTE)
    : undefined;
  const imageIngestion = app.imageAnalysisQueue
    ? new ImageIngestionService(app.prisma, app.imageAnalysisQueue)
    : undefined;

  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    (request as FastifyRequest & { rawBody?: Buffer }).rawBody = body as Buffer;
    try { done(null, JSON.parse((body as Buffer).toString('utf8'))); }
    catch (error) { done(error as Error, undefined); }
  });

  app.get('/api/webhooks/facebook', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    if (!config.verifyToken) throw new AppError('Facebook webhook is not configured', 503, 'MESSENGER_NOT_CONFIGURED');
    if (query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === config.verifyToken && typeof query['hub.challenge'] === 'string') {
      return reply.type('text/plain').send(query['hub.challenge']);
    }
    throw new AppError('Facebook webhook verification failed', 403, 'WEBHOOK_VERIFICATION_FAILED');
  });

  app.post('/api/webhooks/facebook', async (request, reply) => {
    await enforceWebhookRate(app, request);
    if (!config.appSecret || !config.pageId) throw new AppError('Facebook webhook is not configured', 503, 'MESSENGER_NOT_CONFIGURED');
    const rawBody = (request as FastifyRequest & { rawBody?: Buffer }).rawBody;
    if (!rawBody || !verifyMessengerSignature(rawBody, request.headers['x-hub-signature-256'] as string | undefined, config.appSecret)) {
      throw new AppError('Invalid Facebook webhook signature', 401, 'INVALID_WEBHOOK_SIGNATURE');
    }
    const payload = request.body as Record<string, unknown>;
    if (!payload || payload.object !== 'page') throw new AppError('Unsupported Facebook webhook object', 404, 'UNSUPPORTED_WEBHOOK');
    const events = parser.parse(payload);
    try {
      await Promise.all(events.map((event) => registerEvent(app, event, request.id, audioIngestion, imageIngestion)));
    } catch {
      return reply.code(503).send({ success: false, error: { code: 'MESSENGER_QUEUE_UNAVAILABLE', message: 'Event will be retried', requestId: request.id } });
    }
    return reply.code(200).send('EVENT_RECEIVED');
  });

  app.post('/api/admin/test/messenger-event', { preHandler: requireAdmin }, async (request) => {
    const body = request.body as Record<string, unknown>;
    const senderId = typeof body?.senderId === 'string' ? body.senderId.trim() : '';
    const pageId = typeof body?.pageId === 'string' ? body.pageId.trim() : config.pageId ?? '';
    const messageId = typeof body?.messageId === 'string' ? body.messageId.trim() : '';
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!senderId || !pageId || !messageId || !text || text.length > 4_000) throw new AppError('senderId, pageId, messageId and text are required', 400, 'VALIDATION_ERROR');
    if (config.pageId && pageId !== config.pageId) throw new AppError('Page ID is not configured', 400, 'INVALID_PAGE_ID');
    const event: NormalizedMessengerEvent = { externalEventId: messageId, eventType: 'message', messageId, senderId, pageId, timestamp: Date.now(), messageType: 'text', text };
    const queued = await registerEvent(app, event, request.id);
    return { success: true, data: { queued, externalEventId: event.externalEventId } };
  });

  const facebookStatus = async () => {
    const db = app.prisma as any;
    const [lastWebhook, lastOutbound, lastFailure, page, openAlerts] = await Promise.all([
      db.messengerEventLog.findFirst({ orderBy: { receivedAt: 'desc' } }),
      db.messengerEventLog.findFirst({ where: { localOutboundMessageId: { not: null }, status: 'PROCESSED' }, orderBy: { processedAt: 'desc' } }),
      db.messengerEventLog.findFirst({ where: { status: { in: ['FAILED', 'DELIVERY_FAILED'] } }, orderBy: { receivedAt: 'desc' } }),
      config.pageId ? db.messengerPage.findUnique({ where: { pageId: config.pageId } }) : null,
      db.messengerAlert.count({ where: { resolvedAt: null } }),
    ]);
    return {
      success: true,
      data: {
        connected: page?.connectionStatus === 'CONNECTED' || isMessengerConfigured(config),
        connectionStatus: page?.connectionStatus ?? (isMessengerConfigured(config) ? 'CONNECTED' : 'DISABLED'),
        pageId: config.pageId ?? page?.pageId ?? null,
        pageName: page?.pageName ?? null,
        tokenMasked: page?.tokenHint ?? maskMessengerToken(config.pageAccessToken),
        tokenLastCheckedAt: page?.lastTokenCheckedAt ?? null,
        aiEnabled: page?.aiEnabled ?? true,
        testMode: page?.testMode ?? false,
        openAlerts,
        graphApiVersion: config.graphApiVersion,
        webhookUrl: env.WEBHOOK_URL ?? `${env.APP_URL.replace(/\/$/, '')}/api/webhooks/facebook`,
        webhookConfigured: Boolean(config.verifyToken && config.appSecret),
        lastWebhookAt: lastWebhook?.receivedAt ?? null,
        lastOutboundMessageAt: page?.lastSuccessfulSendAt ?? lastOutbound?.processedAt ?? null,
        lastError: lastFailure?.errorMessage ?? null,
      },
    };
  };
  app.get('/api/admin/integrations/facebook/status', { preHandler: requireAdmin }, facebookStatus);
  app.get('/api/admin/settings/facebook', { preHandler: requireAdmin }, facebookStatus);
  app.post('/api/admin/settings/facebook/test', { preHandler: requireAdmin }, async (request) => {
    const requestedPageId = typeof (request.body as any)?.pageId === 'string' ? (request.body as any).pageId.trim() : config.pageId;
    const stored = requestedPageId ? await (app.prisma as any).messengerPage.findUnique({ where: { pageId: requestedPageId } }) : null;
    const storedToken = stored?.encryptedAccessToken && env.MESSENGER_CREDENTIAL_ENCRYPTION_KEY ? decryptMessengerToken(stored.encryptedAccessToken, env.MESSENGER_CREDENTIAL_ENCRYPTION_KEY) : undefined;
    const token = requestedPageId === config.pageId && config.pageAccessToken ? config.pageAccessToken : storedToken;
    if (!token || !requestedPageId) throw new AppError('Facebook is not configured', 503, 'MESSENGER_NOT_CONFIGURED');
    const result = await new MetaGraphClient(config.graphApiVersion, config.timeoutMs).request(requestedPageId, token, '?fields=id,name');
    const checkedAt = new Date();
    await (app.prisma as any).messengerPage.upsert({ where: { pageId: requestedPageId }, create: { pageId: requestedPageId, tokenHint: maskMessengerToken(token), connectionStatus: result.success ? 'CONNECTED' : 'CONNECTION_ERROR', lastTokenCheckedAt: checkedAt, lastApiError: result.errorMessage }, update: { pageName: typeof result.rawResponse?.name === 'string' ? result.rawResponse.name : undefined, tokenHint: maskMessengerToken(token), connectionStatus: result.success ? 'CONNECTED' : 'CONNECTION_ERROR', lastTokenCheckedAt: checkedAt, lastApiError: result.errorMessage, lastApiErrorAt: result.success ? undefined : checkedAt } });
    if (!result.success) throw new AppError('Facebook connection test failed', 502, 'FACEBOOK_CONNECTION_FAILED');
    return { success: true, message: 'Facebook connection is healthy', data: { pageId: requestedPageId, pageName: typeof result.rawResponse?.name === 'string' ? result.rawResponse.name : null } };
  });

  app.get('/api/admin/settings/facebook/pages', { preHandler: requireAdmin }, async () => ({ success: true, data: await (app.prisma as any).messengerPage.findMany({ select: { pageId: true, pageName: true, tokenHint: true, connectionStatus: true, aiEnabled: true, testMode: true, lastTokenCheckedAt: true, lastWebhookAt: true, lastSuccessfulSendAt: true, lastApiErrorAt: true, lastApiError: true }, orderBy: { createdAt: 'asc' } }) }));

  app.patch('/api/admin/settings/facebook', { preHandler: requireAdmin }, async (request) => {
    const body = request.body as Record<string, unknown>; const pageId = typeof body.pageId === 'string' ? body.pageId.trim() : config.pageId;
    if (!pageId) throw new AppError('pageId is required', 400, 'VALIDATION_ERROR');
    const token = typeof body.accessToken === 'string' ? body.accessToken.trim() : undefined;
    if (token && !env.MESSENGER_CREDENTIAL_ENCRYPTION_KEY) throw new AppError('Credential encryption key is required before storing a token', 503, 'CREDENTIAL_ENCRYPTION_NOT_CONFIGURED');
    const data: Record<string, unknown> = {
      ...(typeof body.pageName === 'string' ? { pageName: body.pageName.trim().slice(0, 255) } : {}),
      ...(typeof body.aiEnabled === 'boolean' ? { aiEnabled: body.aiEnabled } : {}),
      ...(body.aiConfig && typeof body.aiConfig === 'object' && !Array.isArray(body.aiConfig) ? { aiConfig: body.aiConfig } : {}),
      ...(typeof body.knowledgeBaseScope === 'string' ? { knowledgeBaseScope: body.knowledgeBaseScope.trim().slice(0, 100) || null } : {}),
      ...(typeof body.testMode === 'boolean' ? { testMode: body.testMode } : {}),
      ...(typeof body.testRecipientId === 'string' ? { testRecipientId: body.testRecipientId.trim().slice(0, 255) || null } : {}),
      ...(token ? { encryptedAccessToken: encryptMessengerToken(token, env.MESSENGER_CREDENTIAL_ENCRYPTION_KEY!), tokenHint: maskMessengerToken(token), connectionStatus: 'CONNECTED' } : {}),
    };
    const page = await (app.prisma as any).messengerPage.upsert({ where: { pageId }, create: { pageId, ...data }, update: data });
    return { success: true, data: { pageId: page.pageId, pageName: page.pageName, aiEnabled: page.aiEnabled, testMode: page.testMode, tokenMasked: page.tokenHint, connectionStatus: page.connectionStatus } };
  });

  app.post('/api/admin/settings/facebook/emergency-stop', { preHandler: requireAdmin }, async (request) => {
    const enabled = (request.body as Record<string, unknown>)?.enabled;
    if (typeof enabled !== 'boolean') throw new AppError('enabled must be boolean', 400, 'VALIDATION_ERROR');
    await (app.prisma as any).setting.upsert({ where: { key: 'messenger.emergency_stop' }, create: { key: 'messenger.emergency_stop', value: String(enabled), description: 'Global Messenger AI and automated-send emergency stop' }, update: { value: String(enabled) } });
    if (enabled) await (app.prisma as any).messengerOutgoingMessage.updateMany({ where: { status: 'QUEUED' }, data: { status: 'CANCELLED', errorType: 'EMERGENCY_STOP', errorMessage: 'Cancelled by emergency stop', failedAt: new Date() } });
    return { success: true, data: { emergencyStop: enabled } };
  });

  app.get('/api/admin/messenger/failed', { preHandler: requireAdmin }, async () => ({ success: true, data: await (app.prisma as any).messengerOutgoingMessage.findMany({ where: { status: { in: ['FAILED','PERMANENT_FAILURE'] } }, include: { message: true, conversation: { include: { customer: true } } }, orderBy: { updatedAt: 'desc' }, take: 100 }) }));
  app.post('/api/admin/messenger/failed/:id/retry', { preHandler: requireAdmin }, async (request) => {
    const id = (request.params as { id: string }).id; const outgoing = await (app.prisma as any).messengerOutgoingMessage.findUnique({ where: { id } });
    if (!outgoing) throw new AppError('Failed message not found', 404, 'NOT_FOUND');
    await (app.prisma as any).messengerOutgoingMessage.update({ where: { id }, data: { status: 'QUEUED', failedAt: null, errorMessage: null } });
    const previousJob = await app.messengerOutgoingQueue.getJob(id); if (previousJob) await previousJob.remove().catch(() => undefined);
    await enqueueMessengerOutgoing(app.messengerOutgoingQueue, { outgoingId: id, correlationId: outgoing.correlationId }, 'HIGH');
    return { success: true };
  });
  app.post('/api/admin/messenger/failed/:id/cancel', { preHandler: requireAdmin }, async (request) => ({ success: true, data: await (app.prisma as any).messengerOutgoingMessage.update({ where: { id: (request.params as { id: string }).id }, data: { status: 'CANCELLED', errorType: 'ADMIN_CANCELLED', failedAt: new Date() } }) }));

  app.get('/api/admin/system/messenger-health', { preHandler: requireAdmin }, async () => {
    const db = app.prisma as any; const queueList = [queueNames.messengerEvents, queueNames.messengerOutgoing, queueNames.imageAnalysis, queueNames.audioTranscription, queueNames.customerFollowups];
    const [status, queues, failedJobs, alerts] = await Promise.all([facebookStatus(), Promise.all(queueList.map(async (name) => ({ name, ...(await app.queues[name].getJobCounts('waiting','active','completed','failed','delayed')) }))), db.messengerOutgoingMessage.count({ where: { status: { in: ['FAILED','PERMANENT_FAILURE'] } } }), db.messengerAlert.findMany({ where: { resolvedAt: null }, orderBy: { createdAt: 'desc' }, take: 20 })]);
    return { success: true, data: { ...(status as any).data, queues, failedJobs, alerts } };
  });

  app.get('/api/admin/messenger/events', { preHandler: requireAdmin }, async (request) => {
    const query = request.query as Record<string, unknown>; const correlationId = typeof query.correlationId === 'string' ? query.correlationId : undefined;
    return { success: true, data: await (app.prisma as any).messengerEventLog.findMany({ where: correlationId ? { correlationId } : {}, select: { id: true, externalEventId: true, eventType: true, pageId: true, senderId: true, status: true, errorType: true, errorMessage: true, correlationId: true, sanitizedPayload: true, retryCount: true, receivedAt: true, queuedAt: true, processingStartedAt: true, processingCompletedAt: true, responseQueuedAt: true, processedAt: true }, orderBy: { receivedAt: 'desc' }, take: 100 }) };
  });

  app.get('/api/admin/messenger/trace/:correlationId', { preHandler: requireAdmin }, async (request) => {
    const correlationId = (request.params as { correlationId: string }).correlationId; const db = app.prisma as any;
    const [events, outgoing, logs] = await Promise.all([db.messengerEventLog.findMany({ where: { correlationId }, orderBy: { receivedAt: 'asc' } }), db.messengerOutgoingMessage.findMany({ where: { correlationId }, orderBy: { createdAt: 'asc' } }), db.systemLog.findMany({ where: { requestId: correlationId }, orderBy: { createdAt: 'asc' } })]);
    return { success: true, data: { correlationId, events, outgoing, logs } };
  });
}
