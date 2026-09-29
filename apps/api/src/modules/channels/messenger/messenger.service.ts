import type { PrismaClient } from '@alzeena/database';
import type { Redis } from 'ioredis';
import type { ChatService } from '../../conversations/chat.service.js';
import { MessageService } from '../../conversations/message.service.js';
import { AudioRateLimitError, type AudioIngestionService } from '../../audio/audio-ingestion.service.js';
import type { ImageIngestionService } from '../../images/image-ingestion.service.js';
import { MessengerSender } from './messenger.sender.js';
import type { MessengerJobData, NormalizedMessengerEvent } from './messenger.types.js';
import type { MessengerOutgoingService } from './messenger-outgoing.service.js';

export class MessengerProcessingError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'MessengerProcessingError';
  }
}

export class MessengerService {
  private readonly db: any;
  private readonly messages: MessageService;
  constructor(
    prisma: PrismaClient,
    private readonly chat: ChatService,
    private readonly sender: MessengerSender,
    private readonly redis?: Redis,
    private readonly audioIngestion?: AudioIngestionService,
    private readonly imageIngestion?: ImageIngestionService,
    private readonly outgoing?: MessengerOutgoingService,
  ) {
    this.db = prisma as any;
    this.messages = new MessageService(prisma);
  }

  async process(data: MessengerJobData) {
    if (!this.redis) return this.processUnlocked(data);
    const key = `conversation:processing:messenger:${data.event.pageId}:${data.event.senderId}`;
    const token = `${data.eventLogId}:${Date.now()}`;
    const acquired = await this.redis.set(key, token, 'PX', 60_000, 'NX');
    if (!acquired) throw new MessengerProcessingError('Conversation is already being processed', true);
    try { return await this.processUnlocked(data); }
    finally {
      await this.redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1, key, token,
      ).catch(() => undefined);
    }
  }

  private async processUnlocked(data: MessengerJobData) {
    const log = await this.db.messengerEventLog.findUnique({ where: { id: data.eventLogId } });
    if (!log || log.status === 'PROCESSED' || log.status === 'IGNORED') return { duplicate: true };
    const eventType = data.event.eventType ?? 'message';
    if (eventType !== 'message' && eventType !== 'postback') return this.processControlEvent(log, { ...data.event, eventType });
    if (log.localOutboundMessageId) return this.retryDelivery(log, data.event, (data.correlationId ?? data.eventLogId));
    await this.db.messengerEventLog.update({
      where: { id: log.id }, data: { status: 'PROCESSING', processingStartedAt: new Date(), errorMessage: null },
    });
    const [emergency, page] = await Promise.all([
      this.db.setting?.findUnique ? this.db.setting.findUnique({ where: { key: 'messenger.emergency_stop' } }) : null,
      this.db.messengerPage?.findUnique ? this.db.messengerPage.findUnique({ where: { pageId: data.event.pageId } }) : null,
    ]);
    if (emergency?.value === 'true' || page?.aiEnabled === false) {
      await this.db.messengerEventLog.update({ where: { id: log.id }, data: { status: 'IGNORED', processingCompletedAt: new Date(), processedAt: new Date(), errorType: emergency?.value === 'true' ? 'EMERGENCY_STOP' : 'AI_DISABLED' } });
      return { ignored: true };
    }
    try {
      if (data.event.messageType === 'audio') {
        if (!this.audioIngestion) throw new MessengerProcessingError('Audio ingestion is unavailable', true);
        try {
          const ingested = await this.audioIngestion.ingest(data.event, log.id, data.requestId);
          await this.db.messengerEventLog.update({ where: { id: log.id }, data: { status: 'QUEUED', errorMessage: null } });
          return { queued: true, messageId: ingested.messageId };
        } catch (error) {
          if (!(error instanceof AudioRateLimitError)) throw error;
          const inbound = await this.db.message.findUnique({ where: { id: error.messageId } });
          const assistant = await this.messages.addMessage({
            conversationId: error.conversationId, customerId: inbound?.customerId ?? null,
            role: 'assistant', content: 'একটু সময় নিয়ে আবার ভয়েস পাঠাবেন, অথবা কথাটি লিখে দিন।',
            messageType: 'text', metadata: { inputType: 'audio', audioFailure: 'rate_limited', platform: 'messenger', direction: 'outbound' },
          });
          await this.db.messengerEventLog.update({ where: { id: log.id }, data: { localOutboundMessageId: assistant.id } });
          return this.deliver(log.id, assistant.id, data.event.senderId, assistant.content, data.event.pageId, (data.correlationId ?? data.eventLogId));
        }
      }
      if (data.event.messageType === 'image') {
        if (!this.imageIngestion) throw new MessengerProcessingError('Image ingestion is unavailable', true);
        const ingested = await this.imageIngestion.ingest(data.event, log.id, data.requestId);
        await this.db.messengerEventLog.update({ where: { id: log.id }, data: { status: 'QUEUED', errorMessage: null } });
        return { queued: true, messageId: ingested.messageId };
      }
      let messageText = data.event.messageType === 'text' || data.event.messageType === 'unsupported' ? data.event.text : undefined;
      if (data.event.messageType === 'text' && this.db.messengerEventLog.findMany) {
        const burst = await this.db.messengerEventLog.findMany({ where: { id: { not: log.id }, pageId: data.event.pageId, senderId: data.event.senderId, eventType: 'message.text', status: 'QUEUED', receivedAt: { gte: new Date(log.receivedAt.getTime() - 10_000), lte: new Date() } }, orderBy: { receivedAt: 'asc' }, take: 10 });
        if (burst.length) {
          const entries = [{ receivedAt: log.receivedAt, text: messageText }, ...burst.map((entry: any) => ({ receivedAt: entry.receivedAt, text: entry.sanitizedPayload?.text }))]
            .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
          messageText = entries.map((entry) => entry.text).filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).join('\n');
          await this.db.messengerEventLog.updateMany({ where: { id: { in: burst.map((entry: any) => entry.id) } }, data: { status: 'IGNORED', processedAt: new Date(), processingCompletedAt: new Date(), errorType: 'BATCHED' } });
        }
      }
      const result = await this.chat.send({
        customer: { platform: 'messenger', platformPageId: data.event.pageId, platformUserId: data.event.senderId },
        channel: 'messenger',
        message: messageText,
        externalMessageId: data.event.messageId,
        sourceMetadata: { ...this.inboundMetadata(data.event), requestId: data.correlationId ?? data.requestId ?? data.eventLogId, correlationId: data.correlationId ?? data.eventLogId },
      });
      if (!result.reply || !('assistantMessageId' in result) || !result.assistantMessageId) {
        await this.complete(log.id);
        return { delivered: false, humanLocked: true };
      }
      const outboundId = String(result.assistantMessageId);
      const outbound = await this.db.message.findUnique({ where: { id: outboundId } });
      await this.db.message.update({
        where: { id: outboundId },
        data: { metadata: this.mergeMetadata(outbound?.metadata, { platform: 'messenger', direction: 'outbound', delivery: { status: 'pending', provider: 'facebook-messenger' } }) },
      });
      await this.db.messengerEventLog.update({ where: { id: log.id }, data: { localOutboundMessageId: outboundId } });
      return this.deliver(log.id, outboundId, data.event.senderId, result.reply, data.event.pageId, (data.correlationId ?? data.eventLogId));
    } catch (error) {
      const retryable = !(error && typeof error === 'object' && 'code' in error && error.code === 'P2002');
      await this.fail(log.id, error, retryable);
      if (retryable) throw new MessengerProcessingError('Messenger event processing failed', true);
      return { duplicate: true };
    }
  }

  private async processControlEvent(log: any, event: NormalizedMessengerEvent) {
    const at = new Date(event.watermark ?? event.timestamp);
    if (event.eventType === 'delivery' && event.deliveryMessageIds?.length) {
      await this.db.messengerOutgoingMessage.updateMany({ where: { pageId: event.pageId, providerMessageId: { in: event.deliveryMessageIds }, status: { in: ['SENT','DELIVERED'] } }, data: { status: 'DELIVERED', deliveredAt: at } });
    } else if (event.eventType === 'read') {
      await this.db.messengerOutgoingMessage.updateMany({ where: { pageId: event.pageId, recipientId: event.senderId, sentAt: { lte: at }, status: { in: ['SENT','DELIVERED'] } }, data: { status: 'READ', readAt: at } });
    } else if (event.eventType === 'message_echo') {
      await this.db.messengerOutgoingMessage.updateMany({ where: { pageId: event.pageId, providerMessageId: event.messageId }, data: { status: 'SENT', sentAt: new Date(event.timestamp) } });
    }
    await this.db.messengerEventLog.update({ where: { id: log.id }, data: { status: event.eventType === 'message_echo' ? 'IGNORED' : 'PROCESSED', processingStartedAt: new Date(), processingCompletedAt: new Date(), processedAt: new Date(), errorMessage: null } });
    return { controlEvent: event.eventType };
  }

  private async retryDelivery(log: any, event: NormalizedMessengerEvent, correlationId: string) {
    const outbound = await this.db.message.findUnique({ where: { id: log.localOutboundMessageId } });
    if (!outbound) {
      await this.fail(log.id, new Error('Outbound message not found'), false);
      throw new MessengerProcessingError('Outbound message is missing', false);
    }
    return this.deliver(log.id, outbound.id, event.senderId, outbound.content, event.pageId, correlationId);
  }

  private async deliver(eventLogId: string, messageId: string, recipientId: string, text: string, pageId: string, correlationId: string) {
    const current = await this.db.message.findUnique({ where: { id: messageId } });
    if (this.outgoing && current) {
      await this.outgoing.enqueue({ messageId, conversationId: current.conversationId, eventLogId, pageId, recipientId, correlationId, priority: /(?:confirm|yes|হ্যাঁ|জি|order|অর্ডার)/iu.test(text) ? 'HIGH' : 'NORMAL' });
      await this.db.message.update({ where: { id: messageId }, data: { metadata: this.mergeMetadata(current.metadata, { platform: 'messenger', direction: 'outbound', delivery: { status: 'queued', provider: 'facebook-messenger', correlationId } }) } });
      return { queued: true };
    }
    const result = await this.sender.sendText(recipientId, text);
    await this.db.message.update({
      where: { id: messageId },
      data: {
        metadata: this.mergeMetadata(current?.metadata, {
          platform: 'messenger', direction: 'outbound',
          delivery: { status: result.success ? 'sent' : 'failed', provider: 'facebook-messenger', errorCode: result.errorCode },
        }),
        ...(result.externalMessageId ? { externalMessageId: result.externalMessageId } : {}),
      },
    });
    if (result.success) {
      await this.complete(eventLogId);
      return { delivered: true, externalMessageId: result.externalMessageId };
    }
    await this.db.messengerEventLog.update({
      where: { id: eventLogId },
      data: {
        status: result.retryable ? 'DELIVERY_FAILED' : 'FAILED',
        errorMessage: (result.errorMessage ?? result.errorCode ?? 'Messenger delivery failed').slice(0, 500),
        processedAt: result.retryable ? null : new Date(),
      },
    });
    if (result.retryable) throw new MessengerProcessingError('Temporary Messenger delivery failure', true);
    return { delivered: false, retryable: false };
  }

  private complete(id: string) {
    return this.db.messengerEventLog.update({
      where: { id }, data: { status: 'PROCESSED', processedAt: new Date(), processingCompletedAt: new Date(), errorMessage: null },
    });
  }

  private async fail(id: string, error: unknown, retryable: boolean) {
    await this.db.messengerEventLog.update({
      where: { id },
      data: {
        status: retryable ? 'RECEIVED' : 'FAILED',
        errorType: error instanceof MessengerProcessingError ? 'QUEUE_ERROR' : 'UNKNOWN_ERROR',
        retryCount: { increment: 1 },
        errorMessage: (error instanceof Error ? error.message : 'Unknown processing error').slice(0, 500),
        processedAt: retryable ? null : new Date(),
        processingCompletedAt: retryable ? null : new Date(),
      },
    });
  }

  private inboundMetadata(event: NormalizedMessengerEvent) {
    return {
      platform: 'messenger', direction: 'inbound', pageId: event.pageId,
      senderId: event.senderId, messageId: event.messageId, timestamp: event.timestamp,
      ...(event.attachmentType ? { attachmentType: event.attachmentType } : {}),
    };
  }

  private mergeMetadata(existing: unknown, added: Record<string, unknown>) {
    const base = existing && typeof existing === 'object' && !Array.isArray(existing)
      ? existing as Record<string, unknown>
      : {};
    return { ...base, ...added };
  }
}
