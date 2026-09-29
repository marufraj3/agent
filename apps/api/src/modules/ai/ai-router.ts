import type { AIInput, AIIntent } from './ai.types.js';

export type DetectedLanguage = 'bn' | 'banglish' | 'en';

export interface AIRouteDecision {
  intent: AIIntent;
  language: DetectedLanguage;
  needsProductSearch: boolean;
  useAI: boolean;
}

const PRODUCT_INTENTS = new Set<AIIntent>([
  'product_inquiry',
  'product_search',
  'price_inquiry',
  'size_inquiry',
  'stock_inquiry',
]);

export function detectLanguage(message: string, requested: AIInput['language']): DetectedLanguage {
  if (requested !== 'auto') return requested;
  if (/[\u0980-\u09FF]/u.test(message)) return 'bn';
  if (/\b(assalamu|salam|vai|bhai|ache|ase|koto|lagbe|nibo|chai|dekhan|den|ta|ki)\b/i.test(message)) {
    return 'banglish';
  }
  return 'en';
}

export function classifyIntent(message: string): AIIntent {
  const normalized = message.trim().toLowerCase().replace(/[!?.,]+$/g, '');

  if (/^(hi|hello|hey|assalamu alaikum|assalamualaikum|salam|হাই|হ্যালো|আসসালামু আলাইকুম)$/u.test(normalized)) {
    return 'greeting';
  }
  if (/\b(human|agent|representative|customer care|মানুষ|হিউম্যান|প্রতিনিধি)\b/iu.test(normalized)) {
    return 'human_request';
  }
  if (/\b(delivery|shipping|ঢাকা|dhaka|charge|চার্জ)\b/iu.test(normalized)) {
    return 'delivery_inquiry';
  }
  if (/\b(return|exchange|refund|রিটার্ন|এক্সচেঞ্জ|ফেরত)\b/iu.test(normalized)) {
    return 'return_inquiry';
  }
  if (/\b(order|অর্ডার|nibo|নিব|kinbo|কিনব|confirm)\b/iu.test(normalized)) {
    return 'order_intent';
  }
  if (/\b(similar|recommend|suggest|options?|budget|within|under|moto|মতো|দেখান|সাজেস্ট|বাজেট)\b/iu.test(normalized)) {
    return 'product_search';
  }
  if (/\b(price|dam|দাম|koto|কত|৳|tk)\b/iu.test(normalized)) {
    return 'price_inquiry';
  }
  if (/\b(size|সাইজ|xxxl|xxl|xl|xs|small|medium|large)\b/iu.test(normalized)) {
    return 'size_inquiry';
  }
  if (/\b(stock|স্টক|available|availability|মজুদ)\b/iu.test(normalized)) {
    return 'stock_inquiry';
  }
  if (/[a-z]{2,}\d{2,}/i.test(normalized)) return 'product_inquiry';
  if (/\b(product|polo|shirt|t-shirt|tshirt|dress|jersey|pant|shoe|পোলো|শার্ট|ড্রেস|জার্সি)\b/iu.test(normalized)) {
    return /\b(similar|recommend|suggest|moto|মতো|দেখান|dekhan)\b/iu.test(normalized)
      ? 'product_search'
      : 'product_inquiry';
  }
  if (normalized.length < 2) return 'unknown';
  return 'general_question';
}

export function routeAIInput(input: AIInput): AIRouteDecision {
  const intent = classifyIntent(input.message);
  const recommendationRequest = /\b(similar|recommend|suggest|options?|budget|within|under|moto|মতো|কোনটা|which one|সাজেস্ট|বাজেট)\b/iu.test(
    input.message,
  );
  const complexSizeAdvice = /\b(height|weight|chest|waist|measurement|উচ্চতা|ওজন|বুক)\b/iu.test(
    input.message,
  );
  const useAI = ![
    'greeting',
    'delivery_inquiry',
    'human_request',
    'product_inquiry',
    'price_inquiry',
    'stock_inquiry',
  ].includes(intent) && !(intent === 'size_inquiry' && !recommendationRequest && !complexSizeAdvice);

  return {
    intent,
    language: detectLanguage(input.message, input.language),
    needsProductSearch: PRODUCT_INTENTS.has(intent),
    useAI,
  };
}
