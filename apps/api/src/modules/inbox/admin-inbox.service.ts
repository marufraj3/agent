import type { PrismaClient } from '@alzeena/database';
import { HumanHandoverService, DEFAULT_ADMIN_ACTOR } from '../handovers/human-handover.service.js';
import type { HandoverReasonName } from '../handovers/handover.types.js';
import { resolveEffectivePrice } from '../products/effective-price.js';
import { MessageDeliveryService } from './message-delivery.service.js';
import type { MessengerOutgoingService } from '../channels/messenger/messenger-outgoing.service.js';

export type InboxFilter = 'all' | 'unread' | 'ai' | 'human' | 'closed' | 'messenger' | 'web' | 'pending' | 'mine' | 'active' | 'order_pending' | 'order_completed' | 'failed';

export interface InboxQuery {
  page: number;
  limit: number;
  filter: InboxFilter;
  search?: string;
}

export class InboxError extends Error {
  constructor(message: string, readonly code: string, readonly statusCode = 400) {
    super(message);
    this.name = 'InboxError';
  }
}

export class AdminInboxService {
  private readonly db: any;
  private readonly handovers: HumanHandoverService;

  constructor(
    prisma: PrismaClient,
    private readonly delivery = new MessageDeliveryService(),
    private readonly actorId = DEFAULT_ADMIN_ACTOR,
    private readonly messengerPageId?: string,
    private readonly messengerOutgoing?: MessengerOutgoingService,
  ) {
    this.db = prisma as any;
    this.handovers = new HumanHandoverService(prisma);
  }

  async list(query: InboxQuery) {
    const search = query.search?.trim();
    const matchingProductIds: number[] = search && this.db.product?.findMany
      ? (await this.db.product.findMany({
          where: { productCode: { contains: search, mode: 'insensitive' } },
          select: { websiteProductId: true },
          take: 20,
        })).map((product: { websiteProductId: number }) => product.websiteProductId)
      : [];
    const statusFilter = query.filter === 'active' || query.filter === 'ai'
      ? { status: 'ACTIVE' }
      : query.filter === 'human'
        ? { status: 'HUMAN' }
        : query.filter === 'closed'
          ? { status: 'CLOSED' }
          : query.filter === 'unread'
            ? { unreadForAdmin: true }
            : query.filter === 'messenger'
              ? { channel: 'MESSENGER' }
              : query.filter === 'web'
                ? { channel: 'WEB' }
                : query.filter === 'pending'
                  ? { status: 'HUMAN', assignedTo: null }
                  : query.filter === 'mine'
                    ? { status: 'HUMAN', assignedTo: this.actorId }
                    : query.filter === 'order_pending'
                      ? { orders: { some: { status: { in: ['DRAFT','AWAITING_INFORMATION','AWAITING_CONFIRMATION','CONFIRMED'] } } } }
                      : query.filter === 'order_completed'
                        ? { orders: { some: { status: { in: ['SUBMITTED','COMPLETED'] } } } }
                        : query.filter === 'failed'
                          ? { OR: [{ consecutiveAiFailures: { gt: 0 } }, { messengerOutgoing: { some: { status: { in: ['FAILED','PERMANENT_FAILURE'] } } } }] }
                          : {};
    const searchFilter = search ? {
      OR: [
        { id: this.uuid(search) ? search : undefined },
        { customer: { is: { name: { contains: search, mode: 'insensitive' } } } },
        { customer: { is: { phone: { contains: search } } } },
        { customer: { is: { platformUserId: { contains: search } } } },
        { messages: { some: { content: { contains: search, mode: 'insensitive' } } } },
        ...(matchingProductIds.length > 0
          ? [{ messages: { some: { OR: matchingProductIds.map((id) => ({
              metadata: { path: ['productIds'], array_contains: [id] },
            })) } } }]
          : []),
        { orders: { some: { OR: [
          ...(this.uuid(search) ? [{ id: search }] : []),
          { externalOrderId: { contains: search, mode: 'insensitive' } },
          { orderCode: { contains: search, mode: 'insensitive' } },
          { items: { some: { productCode: { contains: search, mode: 'insensitive' } } } },
        ] } } },
      ].filter((item) => !('id' in item) || item.id !== undefined),
    } : {};
    const where = { ...statusFilter, ...searchFilter };
    const [items, total, unreadTotal] = await Promise.all([
      this.db.conversation.findMany({
        where,
        include: {
          customer: { select: { id: true, name: true, phone: true, platform: true, platformUserId: true } },
          messages: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 },
          handovers: { where: { status: { in: ['PENDING', 'ASSIGNED'] } }, orderBy: { createdAt: 'desc' }, take: 1 },
          _count: { select: { messages: true } },
        },
        orderBy: { lastMessageAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.db.conversation.count({ where }),
      this.db.conversation.count({ where: { unreadForAdmin: true } }),
    ]);
    return { items, total, unreadTotal, page: query.page, limit: query.limit, pages: Math.ceil(total / query.limit) };
  }

  async getConversation(id: string, markRead = true, messagePage = 1, messageLimit = 50) {
    const conversation = await this.db.conversation.findUnique({
      where: { id },
      include: {
        customer: true,
        messages: {
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (messagePage - 1) * messageLimit, take: messageLimit,
          include: {
            audioTranscription: { select: {
              status: true, originalTranscript: true, normalizedTranscript: true, language: true,
              confidence: true, durationSeconds: true, fileSizeBytes: true, provider: true, model: true,
              sttDurationMs: true, aiDurationMs: true, totalDurationMs: true, transcribedAt: true, retainedUntil: true,
            } },
            imageProcessing: { select: {
              status: true, fileSizeBytes: true, width: true, height: true, imageHash: true,
              analysisStatus: true, analysisResult: true, candidates: true, confidenceLevel: true,
              selectedProductId: true, provider: true, model: true, visionDurationMs: true,
              matchingDurationMs: true, aiDurationMs: true, totalDurationMs: true, retainedUntil: true,
            } },
            imageFeedback: { orderBy: { createdAt: 'desc' }, take: 10 },
            messengerOutgoing: { select: { status: true, providerMessageId: true, attemptCount: true, errorType: true, errorCode: true, queuedAt: true, sendingStartedAt: true, sentAt: true, deliveredAt: true, readAt: true, failedAt: true, correlationId: true } },
          },
        },
        handovers: { orderBy: { createdAt: 'desc' }, take: 20 },
        orders: { orderBy: { createdAt: 'desc' }, take: 20, include: { items: true } },
        notifications: { orderBy: { createdAt: 'desc' }, take: 20 },
        _count: { select: { messages: true } },
      },
    });
    if (!conversation) throw new InboxError('Conversation not found', 'CONVERSATION_NOT_FOUND', 404);
    if (markRead && conversation.unreadForAdmin) {
      await this.db.$transaction(async (tx: any) => {
        await tx.conversation.update({ where: { id }, data: { unreadForAdmin: false } });
        await tx.adminNotification.updateMany({ where: { conversationId: id, readAt: null }, data: { readAt: new Date() } });
      });
      conversation.unreadForAdmin = false;
    }
    const productIds = this.productIds(conversation.messages);
    const products = productIds.length > 0
      ? await this.db.product.findMany({
          where: { websiteProductId: { in: productIds } },
          include: { variations: { where: { active: true }, orderBy: { sizeName: 'asc' } } },
        })
      : [];
    const discussedProducts = products.map((product: any) => ({
      id: product.websiteProductId,
      name: product.productName,
      code: product.productCode,
      currentPrice: resolveEffectivePrice(product).toString(),
      preOrder: product.isPreOrder,
      active: product.presentInFeed && product.productStatus === '1',
      sizes: product.variations.map((variation: any) => ({
        id: variation.websiteVariationId, size: variation.sizeName, stock: variation.stockQuantity,
      })),
    }));
    return {
      ...conversation,
      messages: conversation._count ? [...conversation.messages].reverse() : conversation.messages,
      discussedProducts,
      messagesPagination: {
        page: messagePage,
        limit: messageLimit,
        total: conversation._count?.messages ?? conversation.messages.length,
        pages: Math.ceil((conversation._count?.messages ?? conversation.messages.length) / messageLimit),
      },
    };
  }

  async sendHumanMessage(conversationId: string, content: string) {
    const conversation = await this.db.conversation.findUnique({
      where: { id: conversationId }, include: { customer: true },
    });
    if (!conversation) throw new InboxError('Conversation not found', 'CONVERSATION_NOT_FOUND', 404);
    if (conversation.status !== 'HUMAN') throw new InboxError('Human replies require a human-owned conversation', 'CONVERSATION_NOT_HUMAN', 409);
    const pending = await this.db.$transaction(async (tx: any) => {
      const message = await tx.message.create({
        data: {
          conversationId,
          customerId: conversation.customerId,
          role: 'HUMAN',
          content,
          messageType: 'TEXT',
          metadata: { delivery: { status: 'pending', provider: conversation.channel === 'MESSENGER' ? 'facebook-messenger' : 'local-test' } },
        },
      });
      await tx.conversation.update({
        where: { id: conversationId }, data: { lastMessageAt: new Date(), unreadForAdmin: false },
      });
      return message;
    });
    if (conversation.channel === 'MESSENGER' && this.messengerOutgoing && conversation.customer.platformUserId) {
      const pageId = conversation.platformPageId ?? conversation.customer.platformPageId ?? this.messengerPageId;
      if (!pageId) throw new InboxError('Messenger Page is unavailable', 'MESSENGER_PAGE_MISSING', 409);
      await this.messengerOutgoing.enqueue({ messageId: pending.id, conversationId, pageId, recipientId: conversation.customer.platformUserId, correlationId: `admin:${pending.id}`, priority: 'HIGH' });
      await this.log(this.db, 'ADMIN_HUMAN_REPLY_QUEUED', conversationId, { messageId: pending.id, actorId: this.actorId });
      return this.db.message.update({ where: { id: pending.id }, data: { metadata: { delivery: { status: 'queued', provider: 'facebook-messenger' } } } });
    }
    const delivery = await this.delivery.sendMessage({
      conversationId,
      channel: conversation.channel,
      recipientId: conversation.customer.platformUserId,
      content,
    });
    return this.db.$transaction(async (tx: any) => {
      const message = await tx.message.update({
        where: { id: pending.id },
        data: {
          metadata: { delivery },
          ...(delivery.providerMessageId ? { externalMessageId: delivery.providerMessageId } : {}),
        },
      });
      if (conversation.channel === 'MESSENGER') {
        await tx.messengerEventLog.create({
          data: {
            externalEventId: `outbound:${message.id}`,
            externalMessageId: delivery.providerMessageId ?? null,
            eventType: 'outbound.human',
            pageId: this.messengerPageId ?? 'unknown',
            senderId: conversation.customer.platformUserId,
            status: delivery.status === 'sent' ? 'PROCESSED' : 'FAILED',
            localOutboundMessageId: message.id,
            errorMessage: delivery.status === 'failed' ? delivery.errorCode ?? 'Messenger delivery failed' : null,
            processedAt: new Date(),
          },
        });
      }
      await this.log(tx, 'ADMIN_HUMAN_REPLY', conversationId, {
        messageId: message.id, deliveryStatus: delivery.status, provider: delivery.provider, actorId: this.actorId,
      });
      return message;
    });
  }

  async take(conversationId: string) {
    const result = await this.handovers.assignConversation(conversationId, this.actorId);
    await this.db.messengerOutgoingMessage.updateMany({ where: { conversationId, status: { in: ['QUEUED','SENDING'] } }, data: { status: 'CANCELLED', errorType: 'HUMAN_TAKEOVER', errorMessage: 'Cancelled because an admin took over', failedAt: new Date() } });
    return result;
  }
  release(conversationId: string) { return this.handovers.unassignConversation(conversationId); }
  requestHandover(conversationId: string, reason: HandoverReasonName, note?: string | null) {
    return this.handovers.requestHandover({ conversationId, reason, note, createdBy: this.actorId });
  }
  async returnToAi(conversationId: string, note?: string | null) {
    await this.db.messengerOutgoingMessage.updateMany({ where: { conversationId, status: { in: ['QUEUED','SENDING'] } }, data: { status: 'CANCELLED', errorType: 'RETURN_TO_AI', errorMessage: 'Old queued response cancelled before AI resumed', failedAt: new Date() } });
    return this.handovers.resolveConversation(conversationId, this.actorId, note, true);
  }

  async close(conversationId: string, note?: string | null) {
    const conversation = await this.db.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation) throw new InboxError('Conversation not found', 'CONVERSATION_NOT_FOUND', 404);
    if (conversation.status === 'CLOSED') return conversation;
    const openHandover = await this.db.conversationHandover.findFirst({
      where: { conversationId, status: { in: ['PENDING', 'ASSIGNED'] } },
      orderBy: { createdAt: 'desc' },
    });
    return this.db.$transaction(async (tx: any) => {
      if (openHandover) {
        await tx.conversationHandover.update({
          where: { id: openHandover.id },
          data: {
            status: 'RESOLVED', resolvedAt: new Date(), resolvedBy: this.actorId,
            ...(note?.trim() ? { note: note.trim() } : {}),
          },
        });
      }
      const updated = await tx.conversation.update({
        where: { id: conversationId }, data: { status: 'CLOSED', assignedTo: null, consecutiveAiFailures: 0 },
      });
      await this.log(tx, 'CONVERSATION_CLOSED', conversationId, { actorId: this.actorId, handoverId: openHandover?.id });
      return updated;
    });
  }

  async reopen(conversationId: string) {
    const conversation = await this.db.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation) throw new InboxError('Conversation not found', 'CONVERSATION_NOT_FOUND', 404);
    if (conversation.status !== 'CLOSED') throw new InboxError('Only closed conversations can be reopened', 'CONVERSATION_NOT_CLOSED', 409);
    try {
      return await this.db.$transaction(async (tx: any) => {
        const updated = await tx.conversation.update({
          where: { id: conversationId }, data: { status: 'ACTIVE', assignedTo: null, consecutiveAiFailures: 0 },
        });
        await this.log(tx, 'CONVERSATION_REOPENED', conversationId, { actorId: this.actorId });
        return updated;
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
        throw new InboxError('Another active conversation already exists for this customer and channel', 'ACTIVE_CONVERSATION_EXISTS', 409);
      }
      throw error;
    }
  }

  private productIds(messages: any[]): number[] {
    const ids: number[] = [];
    for (const message of [...messages].reverse()) {
      const metadata = message.metadata;
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) continue;
      const values = Array.isArray(metadata.productIds) ? metadata.productIds : [];
      for (const value of values) {
        if (typeof value === 'number' && Number.isInteger(value) && !ids.includes(value)) ids.push(value);
        if (ids.length >= 20) return ids;
      }
    }
    return ids;
  }

  private uuid(value: string) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }

  private log(tx: any, type: string, conversationId: string, metadata: Record<string, unknown>) {
    return tx.systemLog.create({
      data: { level: 'INFO', type, event: type, module: 'inbox', conversationId, message: type.replaceAll('_', ' ').toLowerCase(), metadata },
    });
  }
}
