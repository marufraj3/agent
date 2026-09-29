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
        'follow_up_request',
        'order_status',
        'reorder_intent',
        'unknown',
      ],
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    language: { type: 'string', enum: ['bn', 'banglish', 'en'] },
    entities: {
      type: 'object', additionalProperties: false,
      properties: {
        productCode: { anyOf: [{ type: 'string' }, { type: 'null' }] }, productName: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        size: { anyOf: [{ type: 'string', enum: ['XS','S','M','L','XL','XXL','XXXL'] }, { type: 'null' }] },
        color: { anyOf: [{ type: 'string', maxLength: 50 }, { type: 'null' }] },
        quantity: { anyOf: [{ type: 'integer', minimum: 1, maximum: 100 }, { type: 'null' }] },
        minPrice: { anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }] }, maxPrice: { anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }] },
        customerName: { anyOf: [{ type: 'string' }, { type: 'null' }] }, phone: { anyOf: [{ type: 'string' }, { type: 'null' }] }, address: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        deliveryLocation: { anyOf: [{ type: 'string', enum: ['DHAKA','OUTSIDE_DHAKA'] }, { type: 'null' }] }, ordinalReference: { anyOf: [{ type: 'integer' }, { type: 'null' }] }, correction: { type: 'boolean' }, requestedFollowUp: { type: 'boolean' },
      },
      required: ['productCode','productName','size','color','quantity','minPrice','maxPrice','customerName','phone','address','deliveryLocation','ordinalReference','correction','requestedFollowUp'],
    },
    requiresHuman: { type: 'boolean' },
    action: { anyOf: [{ type: 'string', enum: ['reply','clarify','recommend','begin_order','handover','request_human','request_product_clarification','create_order','update_order','confirm_order','cancel_order','request_order_information','schedule_followup'] }, { type: 'null' }] },
    productIds: { type: 'array', items: { type: 'integer' }, maxItems: 5 },
  },
  required: ['reply', 'intent', 'confidence', 'language', 'entities', 'requiresHuman', 'action', 'productIds'],
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
