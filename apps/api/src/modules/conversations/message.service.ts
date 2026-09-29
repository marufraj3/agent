import type { PrismaClient } from '@alzeena/database';
import {
  messageTypeToPrisma,
  roleToPrisma,
  type JsonMetadata,
  type MessageRoleName,
  type MessageTypeName,
} from './conversation.types.js';

export interface AddMessageInput {
  conversationId: string;
  customerId?: string | null;
  role: MessageRoleName;
  content: string;
  messageType?: MessageTypeName;
  metadata?: JsonMetadata;
  externalMessageId?: string | null;
}

export class MessageService {
  constructor(private readonly prisma: PrismaClient) {}

  addMessage(input: AddMessageInput) {
    const now = new Date();
    return this.prisma.$transaction(async (transaction) => {
      const message = await transaction.message.create({
        data: {
          conversationId: input.conversationId,
          customerId: input.customerId ?? null,
          role: roleToPrisma[input.role],
          content: input.content,
          messageType: messageTypeToPrisma[input.messageType ?? 'text'],
          ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
          ...(input.externalMessageId ? { externalMessageId: input.externalMessageId } : {}),
        } as any,
      });
      await (transaction as any).conversation.update({
        where: { id: input.conversationId },
        data: {
          lastMessageAt: now,
          ...(input.role === 'user' ? { unreadForAdmin: true } : {}),
        },
      });
      return message;
    });
  }

  getMessage(id: string) {
    return this.prisma.message.findUnique({ where: { id } });
  }

  updateMessage(
    id: string,
    input: { content?: string; metadata?: JsonMetadata; externalMessageId?: string },
  ) {
    return this.prisma.message.update({
      where: { id },
      data: {
        ...(input.content !== undefined ? { content: input.content } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
        ...(input.externalMessageId !== undefined ? { externalMessageId: input.externalMessageId } : {}),
      } as any,
    });
  }

  async getRecentMessages(conversationId: string, limit: number) {
    const messages = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.max(1, Math.min(limit, 100)),
    });
    return messages.reverse();
  }

  getConversationMessages(conversationId: string, limit = 1_000) {
    return this.prisma.message.findMany({
      where: { conversationId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: Math.max(1, Math.min(limit, 5_000)),
    });
  }

  countMessages(conversationId: string) {
    return this.prisma.message.count({ where: { conversationId } });
  }
}
