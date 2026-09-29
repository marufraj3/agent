import type { PrismaClient } from '@alzeena/database';
import type { NormalizedMessengerEvent } from '../channels/messenger/messenger.types.js';
import { ConversationService } from '../conversations/conversation.service.js';
import { CustomerService } from '../conversations/customer.service.js';
import { MessageService } from '../conversations/message.service.js';
import { enqueueImageAnalysis, type ImageAnalysisQueue } from './image-analysis.queue.js';

export class ImageIngestionService {
  private readonly db: any;
  private readonly customers: CustomerService;
  private readonly conversations: ConversationService;
  private readonly messages: MessageService;
  constructor(prisma: PrismaClient, private readonly queue: ImageAnalysisQueue) {
    this.db = prisma as any;
    this.customers = new CustomerService(prisma); this.conversations = new ConversationService(prisma); this.messages = new MessageService(prisma);
  }

  async ingest(event: NormalizedMessengerEvent, eventLogId: string, requestId?: string) {
    if (event.messageType !== 'image' || !event.attachmentUrl) throw new Error('Image attachment URL is missing');
    const existing = await this.db.message.findUnique({ where: { externalMessageId: event.messageId } });
    if (existing) {
      const lifecycle = await this.db.imageProcessing.findUnique({ where: { messageId: existing.id } });
      if (lifecycle && ['PENDING', 'PROCESSING'].includes(lifecycle.status)) {
        await enqueueImageAnalysis(this.queue, { messageId: existing.id, eventLogId, senderId: event.senderId, ...(requestId ? { requestId } : {}) });
      }
      return { messageId: existing.id, conversationId: existing.conversationId, customerId: existing.customerId };
    }
    const customer = await this.customers.findOrCreateCustomer({ platform: 'messenger', platformPageId: event.pageId, platformUserId: event.senderId });
    const conversation = await this.conversations.getOrCreateConversation({ customerId: customer.id, channel: 'messenger', platformPageId: event.pageId });
    const caption = event.text.trim();
    const metadata = {
      platform: 'messenger', direction: 'inbound', pageId: event.pageId, senderId: event.senderId,
      messageId: event.messageId, timestamp: event.timestamp, attachmentType: 'image', inputType: 'image',
      ...(requestId ? { requestId } : {}),
      image: { source: 'messenger', status: 'PENDING', url: null, ...(event.mimeType ? { mimeType: event.mimeType } : {}) },
      imageAnalysis: { status: 'PENDING' },
    };
    const message = await this.messages.addMessage({
      conversationId: conversation.id, customerId: customer.id, role: 'user',
      content: caption || '[Product image]', messageType: 'image', externalMessageId: event.messageId, metadata,
    });
    await this.db.imageProcessing.create({ data: {
      messageId: message.id, providerUrl: event.attachmentUrl, sourceMimeType: event.mimeType ?? null, status: 'PENDING',
    } });
    await enqueueImageAnalysis(this.queue, { messageId: message.id, eventLogId, senderId: event.senderId, ...(requestId ? { requestId } : {}) });
    return { messageId: message.id, conversationId: conversation.id, customerId: customer.id };
  }
}
