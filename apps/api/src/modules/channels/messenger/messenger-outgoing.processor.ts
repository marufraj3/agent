import type { PrismaClient } from '@alzeena/database';
import type { Redis } from 'ioredis';
import type { MessengerProvider } from './messenger.provider.js';
import type { MessengerOutgoingJobData } from './messenger.types.js';

export class MessengerSendError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly delayMs?: number) { super(message); this.name = 'MessengerSendError'; }
}
export class MessengerOutgoingProcessor {
  private readonly db: any;
  constructor(prisma: PrismaClient, private readonly provider: MessengerProvider, private readonly redis?: Redis) { this.db = prisma as any; }

  async process(data: MessengerOutgoingJobData) {
    const identity = await this.db.messengerOutgoingMessage.findUnique({ where: { id: data.outgoingId }, select: { conversationId: true } });
    if (!identity || !this.redis) return this.processUnlocked(data);
    const key = `messenger:send:conversation:${identity.conversationId}`; const token = `${data.outgoingId}:${Date.now()}`;
    const acquired = await this.redis.set(key, token, 'PX', 60_000, 'NX');
    if (!acquired) throw new MessengerSendError('Conversation send ordering lock is busy', true);
    try { return await this.processUnlocked(data); }
    finally { await this.redis.eval("if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end", 1, key, token).catch(() => undefined); }
  }

  private async processUnlocked(data: MessengerOutgoingJobData) {
    const outgoing = await this.db.messengerOutgoingMessage.findUnique({ where: { id: data.outgoingId }, include: { message: true, conversation: true } });
    if (!outgoing || ['SENT','DELIVERED','READ','CANCELLED','PERMANENT_FAILURE'].includes(outgoing.status)) return { duplicate: true };
    const [emergency, maintenance, page, source] = await Promise.all([
      this.db.setting.findUnique({ where: { key: 'messenger.emergency_stop' } }),
      this.db.setting.findUnique({ where: { key: 'system.maintenance_mode' } }),
      this.db.messengerPage.findUnique({ where: { pageId: outgoing.pageId } }),
      outgoing.sourceEventLogId ? this.db.messengerEventLog.findUnique({ where: { id: outgoing.sourceEventLogId } }) : null,
    ]);
    if ((emergency?.value === 'true' || maintenance?.value === 'true' || page?.aiEnabled === false || outgoing.conversation.status !== 'ACTIVE') && outgoing.message.role !== 'HUMAN') return this.cancel(outgoing, emergency?.value === 'true' ? 'emergency_stop' : maintenance?.value === 'true' ? 'maintenance_mode' : 'ai_or_conversation_inactive');
    if (source?.responseQueuedAt) {
      const newer = await this.db.message.findFirst({ where: { conversationId: outgoing.conversationId, role: 'USER', createdAt: { gt: source.responseQueuedAt } }, orderBy: { createdAt: 'desc' } });
      if (newer) return this.cancel(outgoing, 'stale_response_newer_customer_message');
    }
    await this.db.messengerOutgoingMessage.update({ where: { id: outgoing.id }, data: { status: 'SENDING', sendingStartedAt: new Date(), attemptCount: { increment: 1 }, errorType: null, errorCode: null, errorMessage: null } });
    const result = await this.provider.sendText(outgoing.pageId, page?.testMode && page.testRecipientId ? page.testRecipientId : outgoing.recipientId, outgoing.message.content);
    if (result.success) {
      const now = new Date();
      await this.db.$transaction([
        this.db.messengerOutgoingMessage.update({ where: { id: outgoing.id }, data: { status: 'SENT', providerMessageId: result.externalMessageId, sentAt: now } }),
        this.db.message.update({ where: { id: outgoing.messageId }, data: { externalMessageId: result.externalMessageId, metadata: this.merge(outgoing.message.metadata, { delivery: { status: 'sent', provider: 'facebook-messenger', sentAt: now.toISOString(), correlationId: outgoing.correlationId } }) } }),
        ...(outgoing.sourceEventLogId ? [this.db.messengerEventLog.update({ where: { id: outgoing.sourceEventLogId }, data: { status: 'PROCESSED', processedAt: now, processingCompletedAt: now, errorMessage: null } })] : []),
        this.db.messengerPage.upsert({ where: { pageId: outgoing.pageId }, create: { pageId: outgoing.pageId, connectionStatus: 'CONNECTED', lastSuccessfulSendAt: now }, update: { connectionStatus: 'CONNECTED', lastSuccessfulSendAt: now, lastApiError: null } }),
      ]);
      return { sent: true, providerMessageId: result.externalMessageId };
    }
    const permanent = !result.retryable || result.uncertain;
    const status = permanent ? (result.uncertain ? 'FAILED' : 'PERMANENT_FAILURE') : 'QUEUED';
    const now = new Date();
    await this.db.$transaction([
      this.db.messengerOutgoingMessage.update({ where: { id: outgoing.id }, data: { status, errorType: result.errorType ?? 'UNKNOWN_ERROR', errorCode: result.errorCode, errorMessage: result.errorMessage, ...(permanent ? { failedAt: now } : {}) } }),
      this.db.message.update({ where: { id: outgoing.messageId }, data: { metadata: this.merge(outgoing.message.metadata, { delivery: { status: permanent ? 'failed' : 'retrying', provider: 'facebook-messenger', errorCode: result.errorCode, correlationId: outgoing.correlationId } }) } }),
      this.db.messengerPage.upsert({ where: { pageId: outgoing.pageId }, create: { pageId: outgoing.pageId, connectionStatus: 'CONNECTION_ERROR', lastApiErrorAt: now, lastApiError: result.errorMessage }, update: { connectionStatus: result.errorType === 'AUTH_ERROR' ? 'CONNECTION_ERROR' : undefined, lastApiErrorAt: now, lastApiError: result.errorMessage } }),
      ...(permanent ? [this.db.messengerAlert.create({ data: { pageId: outgoing.pageId, conversationId: outgoing.conversationId, messageId: outgoing.messageId, type: result.uncertain ? 'SEND_STATUS_UNCERTAIN' : result.errorType === 'AUTH_ERROR' ? 'TOKEN_ERROR' : 'SEND_FAILED', message: (result.errorMessage ?? 'Messenger send failed').slice(0, 500), metadata: { correlationId: outgoing.correlationId, errorCode: result.errorCode, attemptCount: outgoing.attemptCount + 1 } } })] : []),
    ]);
    if (!permanent) throw new MessengerSendError('Temporary Messenger send failure', true, result.retryAfterMs);
    return { sent: false, permanent: true };
  }

  async cleanupTechnicalLogs(retentionDays: number) {
    const before = new Date(Date.now() - retentionDays * 86_400_000);
    const [events, logs] = await Promise.all([
      this.db.messengerEventLog.deleteMany({ where: { receivedAt: { lt: before }, status: { in: ['PROCESSED','IGNORED'] } } }),
      this.db.systemLog.deleteMany({ where: { createdAt: { lt: before }, module: { in: ['messenger','webhook'] } } }),
    ]);
    return { events: events.count, logs: logs.count, before };
  }

  private cancel(outgoing: any, reason: string) { return this.db.messengerOutgoingMessage.update({ where: { id: outgoing.id }, data: { status: 'CANCELLED', errorType: 'STALE_OR_PAUSED', errorMessage: reason, failedAt: new Date() } }); }
  private merge(existing: unknown, added: Record<string, unknown>) { return { ...(existing && typeof existing === 'object' && !Array.isArray(existing) ? existing as Record<string, unknown> : {}), ...added }; }
}
