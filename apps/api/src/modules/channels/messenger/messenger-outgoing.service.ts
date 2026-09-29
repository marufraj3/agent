import type { PrismaClient } from '@alzeena/database';
import type { MessengerOutgoingQueue } from './messenger-outgoing.queue.js';
import { enqueueMessengerOutgoing } from './messenger-outgoing.queue.js';

export interface QueueMessengerResponseInput {
  messageId: string; conversationId: string; eventLogId?: string; pageId: string; recipientId: string;
  correlationId: string; priority?: 'HIGH'|'NORMAL'|'LOW';
}
export class MessengerOutgoingService {
  private readonly db: any;
  constructor(prisma: PrismaClient, private readonly queue: MessengerOutgoingQueue) { this.db = prisma as any; }
  async enqueue(input: QueueMessengerResponseInput) {
    const idempotencyKey = `${input.pageId}:${input.conversationId}:${input.messageId}`;
    let outgoing = await this.db.messengerOutgoingMessage.findUnique({ where: { idempotencyKey } });
    if (!outgoing) {
      try { outgoing = await this.db.messengerOutgoingMessage.create({ data: { idempotencyKey, messageId: input.messageId, conversationId: input.conversationId, sourceEventLogId: input.eventLogId, pageId: input.pageId, recipientId: input.recipientId, correlationId: input.correlationId, status: 'QUEUED' } }); }
      catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')) throw error;
        outgoing = await this.db.messengerOutgoingMessage.findUnique({ where: { idempotencyKey } });
      }
    }
    if (!outgoing) throw new Error('Unable to create outgoing Messenger message');
    if (input.eventLogId) await this.db.messengerEventLog.update({ where: { id: input.eventLogId }, data: { localOutboundMessageId: input.messageId, responseQueuedAt: new Date() } });
    if (!['SENT','DELIVERED','READ','CANCELLED','PERMANENT_FAILURE'].includes(outgoing.status)) await enqueueMessengerOutgoing(this.queue, { outgoingId: outgoing.id, correlationId: input.correlationId }, input.priority ?? 'NORMAL');
    return outgoing;
  }
}
