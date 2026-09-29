import { Prisma, type PrismaClient } from '@alzeena/database';
import { assertJourneyTransition, type JourneyState } from '../automation/customer-journey.service.js';
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

  async getEngagedConversation(customerId: string, channel: ConversationChannelName) {
    const active = await this.getActiveConversation(customerId, channel);
    if (active) return active;
    return this.prisma.conversation.findFirst({
      where: { customerId, channel: channelToPrisma[channel], status: 'HUMAN' },
      orderBy: { lastMessageAt: 'desc' },
    });
  }

  async getOrCreateConversation(input: CreateConversationInput) {
    const active = await this.getEngagedConversation(input.customerId, input.channel);
    if (active) return active;

    try {
      return await this.createConversation(input);
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }
      const concurrent = await this.getEngagedConversation(input.customerId, input.channel);
      if (!concurrent) throw error;
      return concurrent;
    }
  }

  async closeConversation(id: string) {
    const db = this.prisma as any;
    return db.$transaction(async (tx: any) => {
      const conversation = await tx.conversation.update({ where: { id }, data: { status: 'CLOSED' } });
      await tx.followUp.updateMany({ where: { conversationId: id, status: 'PENDING' }, data: { status: 'CANCELLED', cancelledAt: new Date(), failureReason: 'conversation_closed' } });
      await tx.customerActivity.create({ data: { customerId: conversation.customerId, conversationId: id, type: 'CONVERSATION_CLOSED', summary: 'Conversation closed' } });
      return conversation;
    });
  }

  async markConversationHuman(id: string) {
    const db=this.prisma as any;
    return db.$transaction(async(tx:any)=>{const conversation=await tx.conversation.update({where:{id},data:{status:'HUMAN'}});const customer=await tx.customer.findUnique({where:{id:conversation.customerId}});if(customer)assertJourneyTransition(customer.journeyState as JourneyState,'HUMAN_SUPPORT');await tx.customer.update({where:{id:conversation.customerId},data:{journeyState:'HUMAN_SUPPORT',lastActivityAt:new Date()}});await tx.customerActivity.create({data:{customerId:conversation.customerId,conversationId:id,type:'HUMAN_HANDOVER',summary:'Conversation moved to human support'}});await tx.followUp.updateMany({where:{conversationId:id,status:'PENDING'},data:{status:'CANCELLED',cancelledAt:new Date(),failureReason:'human_handover'}});return conversation;});
  }

  updateLastMessage(id: string, at = new Date()) {
    return this.prisma.conversation.update({
      where: { id },
      data: { lastMessageAt: at },
    });
  }
}
