import { z } from 'zod';
import { handoverReasons } from '../handovers/handover.types.js';

export const inboxQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  filter: z.enum(['all', 'unread', 'ai', 'human', 'closed', 'messenger', 'web', 'pending', 'mine', 'active', 'order_pending', 'order_completed', 'failed']).default('all'),
  search: z.string().trim().max(200).optional(),
  handoverReason: z.enum(handoverReasons).optional(),
  priority: z.enum(['high','normal']).optional(),
}).strict();

export const conversationParamsSchema = z.object({ id: z.uuid() }).strict();
export const humanMessageSchema = z.object({ content: z.string().trim().min(1).max(4_000) }).strict();
export const noteSchema = z.object({ note: z.string().trim().max(2_000).nullable().optional() }).strict();
export const handoverRequestSchema = z.object({
  reason: z.enum(handoverReasons),
  note: z.string().trim().max(2_000).nullable().optional(),
}).strict();
export const handoverListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(['pending', 'assigned']).default('pending'),
}).strict();
