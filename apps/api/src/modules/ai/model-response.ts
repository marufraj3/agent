import { modelResponseSchema, type ModelAIResponse } from './ai.types.js';

export const AI_RESPONSE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reply: { type: 'string', description: 'Short natural customer-facing reply.' },
    intent: {
      type: 'string',
      enum: [
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
      ],
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    requiresHuman: { type: 'boolean' },
    action: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    productIds: { type: 'array', items: { type: 'integer' }, maxItems: 10 },
  },
  required: ['reply', 'intent', 'confidence', 'requiresHuman', 'action', 'productIds'],
};

function jsonCandidates(text: string): string[] {
  const candidates = [text.trim()];
  const withoutFence = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  if (withoutFence !== candidates[0]) candidates.push(withoutFence);

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(text.slice(firstBrace, lastBrace + 1));
  return [...new Set(candidates)];
}

export function parseModelResponse(text: string): ModelAIResponse | null {
  for (const candidate of jsonCandidates(text)) {
    try {
      const parsed = modelResponseSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      // Try the next safe extraction candidate.
    }
  }
  return null;
}
