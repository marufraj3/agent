import { z } from 'zod';

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
    customerContext: z
      .object({
        name: z.string().trim().max(255).nullable().optional(),
        language: z.string().trim().max(20).nullable().optional(),
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
    requiresHuman: z.boolean(),
    action: z.string().trim().min(1).max(100).nullable(),
    productIds: z.array(z.number().int().positive()).max(10),
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

export interface AIResponse extends ModelAIResponse {
  products: AIProductReference[];
  source: 'rules' | 'gemini' | 'fallback';
}
