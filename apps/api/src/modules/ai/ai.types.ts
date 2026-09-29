import { z } from 'zod';
import { extractedEntitiesSchema } from './entity-extractor.js';

export const aiIntentSchema = z.enum([
  'greeting',
  'product_inquiry',
  'product_search',
  'price_inquiry',
  'size_inquiry',
  'stock_inquiry',
  'delivery_inquiry',
  'return_inquiry',
  'order_intent',
  'general_question',
  'human_request',
  'follow_up_request',
  'order_status',
  'reorder_intent',
  'unknown',
]);

export type AIIntent = z.infer<typeof aiIntentSchema>;

export const conversationMessageSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    content: z.string().trim().min(1).max(4_000),
  })
  .strict();

export const aiInputSchema = z
  .object({
    message: z.string().trim().min(1).max(4_000),
    conversationId: z.string().trim().max(100).nullable().optional(),
    customerId: z.string().trim().max(100).nullable().optional(),
    language: z.enum(['auto', 'bn', 'banglish', 'en']).default('auto'),
    conversationHistory: z.array(conversationMessageSchema).max(50).default([]),
    contextProductIds: z.array(z.number().int().positive()).max(10).default([]),
    conversationSummary: z.record(z.string(), z.unknown()).refine((value) => JSON.stringify(value).length <= 4_000, 'Conversation summary is too large').nullable().optional(),
    salesState: z.string().trim().max(50).nullable().optional(),
    customerContext: z
      .object({
        name: z.string().trim().max(255).nullable().optional(),
        language: z.string().trim().max(20).nullable().optional(),
        preferredSize: z.string().trim().max(50).nullable().optional(),
        preferredCategory: z.string().trim().max(100).nullable().optional(),
        preferredColor: z.string().trim().max(100).nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type AIInput = z.infer<typeof aiInputSchema>;
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

export const modelResponseSchema = z
  .object({
    reply: z.string().trim().min(1).max(2_000),
    intent: aiIntentSchema,
    confidence: z.number().min(0).max(1),
    language: z.enum(['bn', 'banglish', 'en']),
    entities: extractedEntitiesSchema,
    requiresHuman: z.boolean(),
    action: z.enum(['reply', 'clarify', 'recommend', 'begin_order', 'handover', 'request_human', 'request_product_clarification', 'create_order', 'update_order', 'confirm_order', 'cancel_order', 'request_order_information', 'request_voice_clarification', 'schedule_followup']).nullable(),
    productIds: z.array(z.number().int().positive()).max(5),
  })
  .strict();

export type ModelAIResponse = z.infer<typeof modelResponseSchema>;

export interface AIProductReference {
  id: number;
  productName: string;
  productCode: string;
  image: string | null;
  matchConfidence?: number;
  matchReasons?: string[];
}

export interface AIOrderAction {
  type:
    | 'create_order'
    | 'update_order'
    | 'confirm_order'
    | 'cancel_order'
    | 'request_order_information';
  orderId: string;
}

export interface AIToolCallTrace {
  tool: string;
  status: 'ok' | 'rejected' | 'error';
  durationMs: number;
  resultCount?: number;
}

export interface AIResponse extends ModelAIResponse {
  products: AIProductReference[];
  source: 'rules' | 'gemini' | 'fallback';
  orderAction?: AIOrderAction;
  debug?: {
    latencyMs: number;
    model: string | null;
    toolCalls: AIToolCallTrace[];
    fallbackReason?: string;
  };
}
