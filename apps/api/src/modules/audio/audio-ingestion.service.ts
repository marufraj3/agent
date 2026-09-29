import type { PrismaClient } from '@alzeena/database';
import type { Redis } from 'ioredis';
import type { NormalizedMessengerEvent } from '../channels/messenger/messenger.types.js';
import { ConversationService } from '../conversations/conversation.service.js';
import { CustomerService } from '../conversations/customer.service.js';
import { MessageService } from '../conversations/message.service.js';
import type { AudioTranscriptionQueue } from './audio-transcription.queue.js';
import { enqueueAudioTranscription } from './audio-transcription.queue.js';

export class AudioRateLimitError extends Error {
  constructor(readonly messageId: string, readonly conversationId: string) {
    super('Audio message rate limit reached');
    this.name = 'AudioRateLimitError';
  }
}

export class AudioIngestionService {
  private readonly db: any;
  private readonly customers: CustomerService;
  private readonly conversations: ConversationService;
  private readonly messages: MessageService;

  constructor(
    prisma: PrismaClient,
    private readonly queue: AudioTranscriptionQueue,
    private readonly redis: Redis | undefined,
    private readonly limitPerMinute: number,
  ) {
    this.db = prisma as any;
    this.customers = new CustomerService(prisma);
    this.conversations = new ConversationService(prisma);
    this.messages = new MessageService(prisma);
  }

  async ingest(event: NormalizedMessengerEvent, eventLogId: string, requestId?: string) {
    if (event.messageType !== 'audio' || !event.attachmentUrl) throw new Error('Audio attachment URL is missing');
    const existing = await this.db.message.findUnique({ where: { externalMessageId: event.messageId } });
    if (existing) {
      const lifecycle = await this.db.audioTranscription.findUnique({ where: { messageId: existing.id } });
      if (lifecycle?.errorCode === 'RATE_LIMITED') {
        throw new AudioRateLimitError(existing.id, existing.conversationId);
      }
      if (lifecycle && ['PENDING', 'PROCESSING'].includes(lifecycle.status)) {
        await enqueueAudioTranscription(this.queue, { messageId: existing.id, eventLogId, senderId: event.senderId, ...(requestId ? { requestId } : {}) });
      }
      return { messageId: existing.id, conversationId: existing.conversationId, customerId: existing.customerId };
    }
    const customer = await this.customers.findOrCreateCustomer({ platform: 'messenger', platformUserId: event.senderId });
    const conversation = await this.conversations.getOrCreateConversation({ customerId: customer.id, channel: 'messenger' });
    const retainedMetadata = {
      platform: 'messenger', direction: 'inbound', pageId: event.pageId,
      senderId: event.senderId, messageId: event.messageId, timestamp: event.timestamp,
      attachmentType: event.attachmentType ?? 'audio', ...(requestId ? { requestId } : {}),
      inputType: 'audio',
      audio: { source: 'messenger', status: 'PENDING', url: null, ...(event.mimeType ? { mimeType: event.mimeType } : {}) },
      transcription: { status: 'PENDING' },
    };
    const message = await this.messages.addMessage({
      conversationId: conversation.id,
      customerId: customer.id,
      role: 'user',
      content: '[Voice message]',
      messageType: 'audio',
      externalMessageId: event.messageId,
      metadata: retainedMetadata,
    });
    await this.db.audioTranscription.create({
      data: { messageId: message.id, providerUrl: event.attachmentUrl, sourceMimeType: event.mimeType ?? null, status: 'PENDING' },
    });

    if (await this.rateLimited(event.senderId)) {
      await this.db.audioTranscription.update({ where: { messageId: message.id }, data: { status: 'FAILED', errorCode: 'RATE_LIMITED' } });
      await this.messages.updateMessage(message.id, { metadata: { ...retainedMetadata, audio: { source: 'messenger', status: 'FAILED', url: null }, transcription: { status: 'FAILED' } } });
      throw new AudioRateLimitError(message.id, conversation.id);
    }
    await enqueueAudioTranscription(this.queue, { messageId: message.id, eventLogId, senderId: event.senderId, ...(requestId ? { requestId } : {}) });
    return { messageId: message.id, conversationId: conversation.id, customerId: customer.id };
  }

  private async rateLimited(senderId: string): Promise<boolean> {
    if (!this.redis) return false;
    const key = `audio-rate:${senderId}:${Math.floor(Date.now() / 60_000)}`;
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, 90);
    return count > this.limitPerMinute;
  }
}
