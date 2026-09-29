import type { PrismaClient } from '@alzeena/database';
import { AutomationSettingsService } from './automation-settings.service.js';
import type { FollowUpService } from './follow-up.service.js';
/** Prepares notifications only for locally verified states explicitly enabled by an admin. External website status sync is not available. */
export class OrderStatusNotificationService {
  private readonly db:any;private readonly settings:AutomationSettingsService;
  constructor(prisma:PrismaClient,private readonly followUps:FollowUpService){this.db=prisma as any;this.settings=new AutomationSettingsService(prisma);}
  async onVerifiedStatusChange(orderId:string,status:'CONFIRMED'|'CANCELLED'){
    const config=await this.settings.get();if(!config.enabledOrderNotifications.includes(status))return null;
    const order=await this.db.order.findUnique({where:{id:orderId}});if(!order)return null;
    return this.followUps.schedule({customerId:order.customerId,conversationId:order.conversationId,orderId:order.id,type:'POST_ORDER',scheduledAt:new Date(),message:status==='CONFIRMED'?'আপনার অর্ডারটি নিশ্চিত হয়েছে।':'আপনার অর্ডারটি বাতিল হয়েছে।'});
  }
}
