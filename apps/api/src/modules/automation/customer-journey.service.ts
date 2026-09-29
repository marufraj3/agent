import type { PrismaClient } from '@alzeena/database';

export type JourneyState = 'NEW'|'ENGAGED'|'PRODUCT_INTEREST'|'ORDER_STARTED'|'AWAITING_CUSTOMER_INFO'|'AWAITING_CONFIRMATION'|'ORDER_CONFIRMED'|'ORDER_SUBMITTED'|'POST_ORDER'|'COMPLETED'|'CANCELLED'|'HUMAN_SUPPORT';
export type ActivityType = 'MESSAGE_RECEIVED'|'PRODUCT_VIEWED'|'PRODUCT_SEARCHED'|'PRODUCT_RECOMMENDED'|'PRODUCT_INTEREST'|'PRODUCT_SELECTED'|'PRODUCT_ADDED'|'SIZE_CHECKED'|'PRICE_CHECKED'|'ORDER_STARTED'|'CUSTOMER_INFO_PROVIDED'|'ORDER_DRAFT_CREATED'|'ORDER_CONFIRMATION_REQUESTED'|'ORDER_CONFIRMED'|'ORDER_SUBMITTED'|'ORDER_CANCELLED'|'ORDER_COMPLETED'|'HUMAN_HANDOVER'|'CONVERSATION_CLOSED'|'ABANDONED_ORDER';
const transitions: Record<JourneyState, JourneyState[]> = {
  NEW:['ENGAGED','HUMAN_SUPPORT'], ENGAGED:['PRODUCT_INTEREST','ORDER_STARTED','HUMAN_SUPPORT'], PRODUCT_INTEREST:['ORDER_STARTED','ENGAGED','HUMAN_SUPPORT'],
  ORDER_STARTED:['AWAITING_CUSTOMER_INFO','AWAITING_CONFIRMATION','CANCELLED','HUMAN_SUPPORT'], AWAITING_CUSTOMER_INFO:['AWAITING_CONFIRMATION','CANCELLED','HUMAN_SUPPORT'],
  AWAITING_CONFIRMATION:['ORDER_CONFIRMED','CANCELLED','HUMAN_SUPPORT'], ORDER_CONFIRMED:['ORDER_SUBMITTED','HUMAN_SUPPORT'], ORDER_SUBMITTED:['POST_ORDER','COMPLETED','CANCELLED','HUMAN_SUPPORT'],
  POST_ORDER:['COMPLETED','CANCELLED','HUMAN_SUPPORT','ORDER_STARTED'], COMPLETED:['ORDER_STARTED','ENGAGED','HUMAN_SUPPORT'], CANCELLED:['ORDER_STARTED','ENGAGED','HUMAN_SUPPORT'], HUMAN_SUPPORT:['ENGAGED','PRODUCT_INTEREST','ORDER_STARTED','AWAITING_CUSTOMER_INFO','AWAITING_CONFIRMATION','ORDER_SUBMITTED'],
};
export function assertJourneyTransition(current:JourneyState,next:JourneyState){if(current!==next&&!transitions[current]?.includes(next))throw new Error(`INVALID_JOURNEY_TRANSITION:${current}:${next}`);}
export class CustomerJourneyService {
  private readonly db:any;
  constructor(prisma: PrismaClient) { this.db = prisma as any; }
  async transition(customerId:string, next:JourneyState, activity:ActivityType, input:{summary:string;conversationId?:string;orderId?:string;productId?:string;metadata?:Record<string,unknown>}):Promise<void> {
    await this.db.$transaction(async (tx:any) => {
      const customer = await tx.customer.findUnique({ where:{id:customerId}, select:{journeyState:true} });
      if (!customer) return;
      const current = customer.journeyState as JourneyState;
      assertJourneyTransition(current,next);
      const now = new Date();
      await tx.customer.update({ where:{id:customerId}, data:{ journeyState:next, lastActivityAt:now, ...(activity==='MESSAGE_RECEIVED'?{lastConversationAt:now}:{}), ...(activity==='PRODUCT_INTEREST'?{lastProductInterestAt:now}:{}), ...(['ORDER_STARTED','ORDER_DRAFT_CREATED','ORDER_CONFIRMED','ORDER_SUBMITTED'].includes(activity)?{lastOrderAt:now}:{}) } });
      await tx.customerActivity.create({ data:{customerId, type:activity, summary:input.summary.slice(0,500), conversationId:input.conversationId, orderId:input.orderId, productId:input.productId, metadata:input.metadata} });
    });
  }
  async record(customerId:string,type:ActivityType,input:{summary:string;conversationId?:string;orderId?:string;productId?:string;metadata?:Record<string,unknown>}) { await this.db.customer.update({where:{id:customerId},data:{lastActivityAt:new Date(),...(type==='MESSAGE_RECEIVED'?{lastConversationAt:new Date()}:{})}}); await this.db.customerActivity.create({data:{customerId,type,summary:input.summary.slice(0,500),conversationId:input.conversationId,orderId:input.orderId,productId:input.productId,metadata:input.metadata}}); }
}
