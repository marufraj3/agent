import type { PrismaClient } from '@alzeena/database';
import { defaultAdminActor } from './admin-actor.js';
import { assertJourneyTransition, type JourneyState } from '../automation/customer-journey.service.js';
import { HandoverError, reasonToPrisma, type HandoverReasonName } from './handover.types.js';

export const DEFAULT_ADMIN_ACTOR = defaultAdminActor.id;

interface RequestHandoverInput {
  conversationId: string;
  reason: HandoverReasonName;
  note?: string | null;
  createdBy: string;
}

export class HumanHandoverService {
  private readonly db: any;
  constructor(prisma: PrismaClient) { this.db = prisma as any; }

  async requestHandover(input: RequestHandoverInput) {
    const conversation = await this.db.conversation.findUnique({ where: { id: input.conversationId }, include: { customer: { select: { journeyState: true } } } });
    if (!conversation) throw new HandoverError('Conversation not found', 'CONVERSATION_NOT_FOUND', 404);
    if (conversation.status === 'CLOSED') throw new HandoverError('Closed conversation cannot be handed over', 'CONVERSATION_CLOSED', 409);
    const existing = await this.db.conversationHandover.findFirst({
      where: { conversationId: input.conversationId, status: { in: ['PENDING', 'ASSIGNED'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      if (conversation.customer.journeyState !== 'HUMAN_SUPPORT') { assertJourneyTransition(conversation.customer.journeyState as JourneyState, 'HUMAN_SUPPORT'); await this.db.customer.update({ where: { id: conversation.customerId }, data: { journeyState: 'HUMAN_SUPPORT', lastActivityAt: new Date() } }); }
      if (conversation.status !== 'HUMAN') await this.db.conversation.update({ where: { id: input.conversationId }, data: { status: 'HUMAN' } });
      await this.db.followUp.updateMany({ where: { conversationId: input.conversationId, status: 'PENDING' }, data: { status: 'CANCELLED', cancelledAt: new Date(), failureReason: 'human_handover' } });
      return existing;
    }

    assertJourneyTransition(conversation.customer.journeyState as JourneyState, 'HUMAN_SUPPORT');
    try {
      return await this.db.$transaction(async (tx: any) => {
        const handover = await tx.conversationHandover.create({
          data: {
            conversationId: input.conversationId,
            reason: reasonToPrisma[input.reason],
            note: input.note?.trim() || null,
            createdBy: input.createdBy.slice(0, 100),
          },
        });
        await tx.conversation.update({
          where: { id: input.conversationId },
          data: { status: 'HUMAN', consecutiveAiFailures: 0 },
        });
        await tx.followUp.updateMany({ where: { conversationId: input.conversationId, status: 'PENDING' }, data: { status: 'CANCELLED', cancelledAt: new Date(), failureReason: 'human_handover' } });
        await tx.customer.update({ where: { id: conversation.customerId }, data: { journeyState: 'HUMAN_SUPPORT', lastActivityAt: new Date() } });
        await tx.customerActivity.create({ data: { customerId: conversation.customerId, conversationId: input.conversationId, type: 'HUMAN_HANDOVER', summary: 'Conversation moved to human support' } });
        await tx.adminNotification.create({
          data: {
            conversationId: input.conversationId,
            handoverId: handover.id,
            type: 'HUMAN_HANDOVER_REQUESTED',
            message: `New human handover: ${input.reason.replaceAll('_', ' ')}.`,
          },
        });
        await this.log(tx, 'HANDOVER_REQUESTED', input.conversationId, {
          handoverId: handover.id, reason: input.reason, createdBy: input.createdBy,
        });
        return handover;
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
        const concurrent = await this.db.conversationHandover.findFirst({
          where: { conversationId: input.conversationId, status: { in: ['PENDING', 'ASSIGNED'] } },
        });
        if (concurrent) return concurrent;
      }
      throw error;
    }
  }

  async assignConversation(conversationId: string, assignedTo = DEFAULT_ADMIN_ACTOR) {
    const handover = await this.requireOpen(conversationId);
    return this.db.$transaction(async (tx: any) => {
      const updated = await tx.conversationHandover.update({
        where: { id: handover.id },
        data: { status: 'ASSIGNED', assignedTo },
      });
      await tx.conversation.update({ where: { id: conversationId }, data: { status: 'HUMAN', assignedTo } });
      await this.log(tx, 'CONVERSATION_ASSIGNED', conversationId, { handoverId: handover.id, assignedTo });
      return updated;
    });
  }

  async unassignConversation(conversationId: string) {
    const handover = await this.requireOpen(conversationId);
    return this.db.$transaction(async (tx: any) => {
      const updated = await tx.conversationHandover.update({
        where: { id: handover.id }, data: { status: 'PENDING', assignedTo: null },
      });
      await tx.conversation.update({ where: { id: conversationId }, data: { assignedTo: null } });
      await this.log(tx, 'CONVERSATION_RELEASED', conversationId, { handoverId: handover.id });
      return updated;
    });
  }

  async resolveHandover(id: string, resolvedBy = DEFAULT_ADMIN_ACTOR, note?: string | null, returnToAi = true) {
    const handover = await this.db.conversationHandover.findUnique({ where: { id } });
    if (!handover) throw new HandoverError('Handover not found', 'HANDOVER_NOT_FOUND', 404);
    if (!['PENDING', 'ASSIGNED'].includes(handover.status)) {
      throw new HandoverError('Handover is already finalized', 'HANDOVER_FINALIZED', 409);
    }
    return this.db.$transaction(async (tx: any) => {
      const updated = await tx.conversationHandover.update({
        where: { id },
        data: {
          status: 'RESOLVED', resolvedAt: new Date(), resolvedBy,
          ...(note?.trim() ? { note: note.trim() } : {}),
        },
      });
      await tx.conversation.update({
        where: { id: handover.conversationId },
        data: { ...(returnToAi ? { status: 'ACTIVE' } : {}), assignedTo: null, consecutiveAiFailures: 0 },
      });
      if (returnToAi) { const conversation = await tx.conversation.findUnique({ where: { id: handover.conversationId } }); if (conversation) { const order=await tx.order.findFirst({where:{customerId:conversation.customerId,status:{in:['DRAFT','AWAITING_INFORMATION','AWAITING_CONFIRMATION','SUBMITTED']}},orderBy:{updatedAt:'desc'}});const journeyState=order?.status==='AWAITING_CONFIRMATION'?'AWAITING_CONFIRMATION':order?.status==='SUBMITTED'?'ORDER_SUBMITTED':order?'AWAITING_CUSTOMER_INFO':'ENGAGED';const customer=await tx.customer.findUnique({where:{id:conversation.customerId}});if(customer)assertJourneyTransition(customer.journeyState as JourneyState,journeyState);await tx.customer.update({ where: { id: conversation.customerId }, data: { journeyState, lastActivityAt: new Date() } }); } }
      await this.log(tx, returnToAi ? 'CONVERSATION_RETURNED_TO_AI' : 'HANDOVER_RESOLVED', handover.conversationId, { handoverId: id, resolvedBy });
      return updated;
    });
  }

  async resolveConversation(conversationId: string, resolvedBy = DEFAULT_ADMIN_ACTOR, note?: string | null, returnToAi = true) {
    const handover = await this.requireOpen(conversationId);
    return this.resolveHandover(handover.id, resolvedBy, note, returnToAi);
  }

  async cancelHandover(id: string, resolvedBy = DEFAULT_ADMIN_ACTOR) {
    const handover = await this.db.conversationHandover.findUnique({ where: { id } });
    if (!handover) throw new HandoverError('Handover not found', 'HANDOVER_NOT_FOUND', 404);
    if (!['PENDING', 'ASSIGNED'].includes(handover.status)) throw new HandoverError('Handover is already finalized', 'HANDOVER_FINALIZED', 409);
    return this.db.$transaction(async (tx: any) => {
      const updated = await tx.conversationHandover.update({
        where: { id }, data: { status: 'CANCELLED', resolvedAt: new Date(), resolvedBy },
      });
      await tx.conversation.update({ where: { id: handover.conversationId }, data: { status: 'ACTIVE', assignedTo: null } });
      await this.log(tx, 'HANDOVER_CANCELLED', handover.conversationId, { handoverId: id, resolvedBy });
      return updated;
    });
  }

  getPendingHandovers(page = 1, limit = 25) {
    return this.db.conversationHandover.findMany({
      where: { status: 'PENDING' }, include: { conversation: { include: { customer: true } } },
      orderBy: { createdAt: 'asc' }, skip: (page - 1) * limit, take: limit,
    });
  }

  getAssignedHandovers(assignedTo = DEFAULT_ADMIN_ACTOR, page = 1, limit = 25) {
    return this.db.conversationHandover.findMany({
      where: { status: 'ASSIGNED', assignedTo }, include: { conversation: { include: { customer: true } } },
      orderBy: { createdAt: 'asc' }, skip: (page - 1) * limit, take: limit,
    });
  }

  private async requireOpen(conversationId: string) {
    const handover = await this.db.conversationHandover.findFirst({
      where: { conversationId, status: { in: ['PENDING', 'ASSIGNED'] } }, orderBy: { createdAt: 'desc' },
    });
    if (!handover) throw new HandoverError('No open handover exists for this conversation', 'HANDOVER_NOT_FOUND', 404);
    return handover;
  }

  private log(tx: any, type: string, conversationId: string, metadata: Record<string, unknown>) {
    return tx.systemLog.create({
      data: { level: 'INFO', type, event: type, module: 'handovers', conversationId, message: type.replaceAll('_', ' ').toLowerCase(), metadata },
    });
  }
}
