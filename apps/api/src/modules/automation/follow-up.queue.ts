import { createQueue } from '../../infrastructure/queue.js';
export const FOLLOW_UP_QUEUE_NAME='customer-followups'; export const FOLLOW_UP_JOB_NAME='deliver-customer-followup'; export const ABANDONMENT_SCAN_JOB='scan-abandoned-orders';
export function createFollowUpQueue(){return createQueue(FOLLOW_UP_QUEUE_NAME);}
export async function enqueueFollowUp(queue:ReturnType<typeof createFollowUpQueue>,id:string,scheduledAt:Date){return queue.add(FOLLOW_UP_JOB_NAME,{followUpId:id},{jobId:`followup_${id}`,delay:Math.max(0,scheduledAt.getTime()-Date.now()),attempts:4,backoff:{type:'exponential',delay:5000}});}
