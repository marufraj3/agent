import { Prisma, type PrismaClient } from '@alzeena/database';
import {
  channelToPrisma,
  type ConversationChannelName,
} from './conversation.types.js';

export interface CreateConversationInput {
  customerId: string;
  channel: ConversationChannelName;
  title?: string | null;
}

export class ConversationService {
  constructor(private readonly prisma: PrismaClient) {}

  createConversation(input: CreateConversationInput) {
    return this.prisma.conversation.create({
      data: {
        customerId: input.customerId,
        channel: channelToPrisma[input.channel],
        title: input.title?.trim() || null,
        status: 'ACTIVE',
      },
    });
  }

  getConversation(id: string) {
    return this.prisma.conversation.findUnique({
      where: { id },
      include: { customer: true },
    });
  }

  getActiveConversation(customerId: string, channel: ConversationChannelName) {
    return this.prisma.conversation.findFirst({
      where: { customerId, channel: channelToPrisma[channel], status: 'ACTIVE' },
      orderBy: { lastMessageAt: 'desc' },
    });
  }

  async getOrCreateConversation(input: CreateConversationInput) {
    const active = await this.getActiveConversation(input.customerId, input.channel);
    if (active) return active;

    try {
      return await this.createConversation(input);
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }
      const concurrent = await this.getActiveConversation(input.customerId, input.channel);
      if (!concurrent) throw error;
      return concurrent;
    }
  }

  closeConversation(id: string) {
    return this.prisma.conversation.update({
      where: { id },
      data: { status: 'CLOSED' },
    });
  }

  markConversationHuman(id: string) {
    return this.prisma.conversation.update({
      where: { id },
      data: { status: 'HUMAN' },
    });
  }

  updateLastMessage(id: string, at = new Date()) {
    return this.prisma.conversation.update({
      where: { id },
      data: { lastMessageAt: at },
    });
  }
}
