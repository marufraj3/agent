import type { FastifyInstance, FastifyRequest } from 'fastify';
import { env } from '../../../../config/env.js';
import { AppError } from '../../../../errors/app-error.js';
import { requireAdmin } from '../../../admin/auth/require-admin.js';
import { getMessengerConfig, isMessengerConfigured } from '../messenger.config.js';
import { MessengerEventParser } from '../messenger.parser.js';
import { enqueueMessengerEvent } from '../messenger.queue.js';
import { verifyMessengerSignature } from '../messenger.signature.js';
import type { NormalizedMessengerEvent } from '../messenger.types.js';

const requests = new Map<string, { minute: number; count: number }>();
function enforceWebhookRate(request: FastifyRequest) {
  const minute = Math.floor(Date.now() / 60_000);
  const key = request.ip;
  const current = requests.get(key);
  if (!current || current.minute !== minute) requests.set(key, { minute, count: 1 });
  else if (++current.count > env.MESSENGER_WEBHOOK_RATE_LIMIT_PER_MINUTE) {
    throw new AppError('Webhook rate limit exceeded', 429, 'RATE_LIMITED');
  }
}

async function registerEvent(app: FastifyInstance, event: NormalizedMessengerEvent, requestId?: string) {
  const db = app.prisma as any;
  let log = await db.messengerEventLog.findUnique({ where: { externalEventId: event.externalEventId } });
  if (log && ['QUEUED', 'PROCESSING', 'PROCESSED', 'IGNORED'].includes(log.status)) return false;
  if (!log) {
    try {
      log = await db.messengerEventLog.create({
        data: {
          externalEventId: event.externalEventId,
          externalMessageId: event.messageId,
          eventType: `message.${event.messageType}`,
          pageId: event.pageId,
          senderId: event.senderId,
          status: 'RECEIVED',
        },
      });
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')) throw error;
      log = await db.messengerEventLog.findUnique({ where: { externalEventId: event.externalEventId } });
      if (!log || ['QUEUED', 'PROCESSING', 'PROCESSED'].includes(log.status)) return false;
    }
  }
  try {
    await enqueueMessengerEvent(app.messengerEventQueue, { eventLogId: log.id, event, requestId });
    await db.messengerEventLog.update({ where: { id: log.id }, data: { status: 'QUEUED', errorMessage: null } });
    return true;
  } catch (error) {
    await db.messengerEventLog.update({
      where: { id: log.id },
      data: { status: 'RECEIVED', errorMessage: 'Messenger queue is temporarily unavailable' },
    });
    throw error;
  }
}

export async function messengerRoutes(app: FastifyInstance): Promise<void> {
  const config = getMessengerConfig();
  const parser = new MessengerEventParser();

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
    enforceWebhookRate(request);
    if (!config.appSecret || !config.pageId) throw new AppError('Facebook webhook is not configured', 503, 'MESSENGER_NOT_CONFIGURED');
    const rawBody = (request as FastifyRequest & { rawBody?: Buffer }).rawBody;
    if (!rawBody || !verifyMessengerSignature(rawBody, request.headers['x-hub-signature-256'] as string | undefined, config.appSecret)) {
      throw new AppError('Invalid Facebook webhook signature', 401, 'INVALID_WEBHOOK_SIGNATURE');
    }
    const payload = request.body as Record<string, unknown>;
    if (!payload || payload.object !== 'page') throw new AppError('Unsupported Facebook webhook object', 404, 'UNSUPPORTED_WEBHOOK');
    const events = parser.parse(payload, config.pageId);
    try {
      await Promise.all(events.map((event) => registerEvent(app, event, request.id)));
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
    const event: NormalizedMessengerEvent = { externalEventId: messageId, messageId, senderId, pageId, timestamp: Date.now(), messageType: 'text', text };
    const queued = await registerEvent(app, event, request.id);
    return { success: true, data: { queued, externalEventId: event.externalEventId } };
  });

  const facebookStatus = async () => {
    const db = app.prisma as any;
    const [lastWebhook, lastOutbound, lastFailure] = await Promise.all([
      db.messengerEventLog.findFirst({ orderBy: { receivedAt: 'desc' } }),
      db.messengerEventLog.findFirst({ where: { localOutboundMessageId: { not: null }, status: 'PROCESSED' }, orderBy: { processedAt: 'desc' } }),
      db.messengerEventLog.findFirst({ where: { status: { in: ['FAILED', 'DELIVERY_FAILED'] } }, orderBy: { receivedAt: 'desc' } }),
    ]);
    return {
      success: true,
      data: {
        connected: isMessengerConfigured(config),
        pageId: config.pageId ?? null,
        graphApiVersion: config.graphApiVersion,
        webhookConfigured: Boolean(config.verifyToken && config.appSecret),
        lastWebhookAt: lastWebhook?.receivedAt ?? null,
        lastOutboundMessageAt: lastOutbound?.processedAt ?? null,
        lastError: lastFailure?.errorMessage ?? null,
      },
    };
  };
  app.get('/api/admin/integrations/facebook/status', { preHandler: requireAdmin }, facebookStatus);
  app.get('/api/admin/settings/facebook', { preHandler: requireAdmin }, facebookStatus);
  app.post('/api/admin/settings/facebook/test', { preHandler: requireAdmin }, async () => {
    if (!config.pageAccessToken || !config.pageId) throw new AppError('Facebook is not configured', 503, 'MESSENGER_NOT_CONFIGURED');
    const response = await fetch(`https://graph.facebook.com/${config.graphApiVersion}/${encodeURIComponent(config.pageId)}?fields=id,name`, {
      headers: { authorization: `Bearer ${config.pageAccessToken}` }, signal: AbortSignal.timeout(config.timeoutMs),
    }).catch(() => null);
    if (!response?.ok) throw new AppError('Facebook connection test failed', 502, 'FACEBOOK_CONNECTION_FAILED');
    const body = await response.json() as Record<string, unknown>;
    return { success: true, message: 'Facebook connection is healthy', data: { pageId: typeof body.id === 'string' ? body.id : config.pageId, pageName: typeof body.name === 'string' ? body.name : null } };
  });
}
