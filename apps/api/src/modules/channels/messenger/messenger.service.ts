import type { PrismaClient } from '@alzeena/database';
import type { ChatService } from '../../conversations/chat.service.js';
import { MessageService } from '../../conversations/message.service.js';
import { MessengerSender } from './messenger.sender.js';
import type { MessengerJobData, NormalizedMessengerEvent } from './messenger.types.js';

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
  ) {
    this.db = prisma as any;
    this.messages = new MessageService(prisma);
  }

  async process(data: MessengerJobData) {
    const log = await this.db.messengerEventLog.findUnique({ where: { id: data.eventLogId } });
    if (!log || log.status === 'PROCESSED' || log.status === 'IGNORED') return { duplicate: true };
    if (log.localOutboundMessageId) return this.retryDelivery(log, data.event);
    await this.db.messengerEventLog.update({
      where: { id: log.id }, data: { status: 'PROCESSING', errorMessage: null },
    });
    try {
      const result = await this.chat.send({
        customer: { platform: 'messenger', platformUserId: data.event.senderId },
        channel: 'messenger',
        message: data.event.messageType === 'text' || data.event.messageType === 'unsupported'
          ? data.event.text
          : undefined,
        image: data.event.messageType === 'image' && data.event.attachmentUrl
          ? { type: 'image', url: data.event.attachmentUrl, source: 'messenger' }
          : undefined,
        audio: data.event.messageType === 'audio' && data.event.attachmentUrl
          ? { type: 'audio', url: data.event.attachmentUrl, source: 'messenger' }
          : undefined,
        externalMessageId: data.event.messageId,
        sourceMetadata: this.inboundMetadata(data.event),
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
      return this.deliver(log.id, outboundId, data.event.senderId, result.reply);
    } catch (error) {
      const retryable = !(error && typeof error === 'object' && 'code' in error && error.code === 'P2002');
      await this.fail(log.id, error, retryable);
      if (retryable) throw new MessengerProcessingError('Messenger event processing failed', true);
      return { duplicate: true };
    }
  }

  private async retryDelivery(log: any, event: NormalizedMessengerEvent) {
    const outbound = await this.db.message.findUnique({ where: { id: log.localOutboundMessageId } });
    if (!outbound) {
      await this.fail(log.id, new Error('Outbound message not found'), false);
      throw new MessengerProcessingError('Outbound message is missing', false);
    }
    return this.deliver(log.id, outbound.id, event.senderId, outbound.content);
  }

  private async deliver(eventLogId: string, messageId: string, recipientId: string, text: string) {
    const result = await this.sender.sendText(recipientId, text);
    const current = await this.db.message.findUnique({ where: { id: messageId } });
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
      where: { id }, data: { status: 'PROCESSED', processedAt: new Date(), errorMessage: null },
    });
  }

  private async fail(id: string, error: unknown, retryable: boolean) {
    await this.db.messengerEventLog.update({
      where: { id },
      data: {
        status: retryable ? 'RECEIVED' : 'FAILED',
        errorMessage: (error instanceof Error ? error.message : 'Unknown processing error').slice(0, 500),
        processedAt: retryable ? null : new Date(),
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
