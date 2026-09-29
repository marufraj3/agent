import { extractEntities, type ExtractedEntities } from '../ai/entity-extractor.js';
import { classifyIntent } from '../ai/ai-router.js';

export type ShoppingSignal =
  | 'browsing'
  | 'product_search'
  | 'product_inquiry'
  | 'product_comparison'
  | 'price_sensitive'
  | 'quality_focused'
  | 'size_focused'
  | 'color_focused'
  | 'discount_seeking'
  | 'urgent_purchase'
  | 'gift_intent'
  | 'repeat_customer'
  | 'ready_to_order'
  | 'abandoned_order'
  | 'undecided'
  | 'human_requested';

export interface ShoppingIntent {
  primary: ShoppingSignal;
  signals: ShoppingSignal[];
  filters: {
    query: string | null;
    category: string | null;
    color: string | null;
    size: ExtractedEntities['size'];
    minPrice: number | null;
    maxPrice: number | null;
  };
  comparisonCodes: string[];
  confidence: 'high' | 'medium';
  source: 'rules';
}

export interface ShoppingIntentContext {
  previousCategory?: string | null;
  previousColor?: string | null;
  previousSize?: ExtractedEntities['size'];
  previousMinPrice?: number | null;
  previousMaxPrice?: number | null;
  hasPreviousOrders?: boolean;
  hasAbandonedOrder?: boolean;
}

const categories: Array<[RegExp, string]> = [
  [/\b(?:polo|পোলো)\b/iu, 'polo'],
  [/\b(?:t-?shirt|টি-?শার্ট)\b/iu, 't-shirt'],
  [/\b(?:shirt|শার্ট)\b/iu, 'shirt'],
  [/\b(?:jersey|জার্সি)\b/iu, 'jersey'],
  [/\b(?:pant|pants|trouser|প্যান্ট)\b/iu, 'pants'],
  [/\b(?:dress|ড্রেস)\b/iu, 'dress'],
  [/\b(?:shoe|shoes|জুতা)\b/iu, 'shoes'],
];

function categoryFrom(message: string): string | null {
  return categories.find(([pattern]) => pattern.test(message))?.[1] ?? null;
}

function add(signals: ShoppingSignal[], signal: ShoppingSignal, applies = true): void {
  if (applies && !signals.includes(signal)) signals.push(signal);
}

export class ShoppingIntentService {
  detect(message: string, context: ShoppingIntentContext = {}): ShoppingIntent {
    const text = message.trim();
    const entities = extractEntities(text);
    const aiIntent = classifyIntent(text);
    const category = categoryFrom(text) ?? context.previousCategory ?? null;
    const signals: ShoppingSignal[] = [];

    add(signals, 'human_requested', aiIntent === 'human_request');
    add(signals, 'product_comparison', /(?:compare|comparison|versus|\bvs\b|মধ্যে কোন|তুলনা)/iu.test(text));
    add(signals, 'ready_to_order', aiIntent === 'order_intent' || /(?:এটা নেব|এইটা নেব|ঠিক আছে.*নেব|i(?:'ll| will) take|add to (?:cart|order))/iu.test(text));
    add(signals, 'discount_seeking', /(?:discount|কম হবে|দাম কম|offer|অফার|ছাড়)/iu.test(text));
    add(signals, 'price_sensitive', entities.maxPrice !== null || /(?:budget|বাজেট|সস্তা|cheap|কম দাম)/iu.test(text));
    add(signals, 'quality_focused', /(?:quality|premium|ভালো|best quality|fabric|gsm|কাপড়)/iu.test(text));
    add(signals, 'size_focused', entities.size !== null || /(?:size|সাইজ|fit|ফিট)/iu.test(text));
    add(signals, 'color_focused', entities.color !== null || /(?:color|colour|রঙ)/iu.test(text));
    add(signals, 'urgent_purchase', /(?:urgent|today|আজকেই|তাড়াতাড়ি|দ্রুত|কালকের মধ্যে)/iu.test(text));
    add(signals, 'gift_intent', /(?:gift|উপহার|birthday|জন্মদিন)/iu.test(text));
    add(signals, 'repeat_customer', context.hasPreviousOrders === true);
    add(signals, 'abandoned_order', context.hasAbandonedOrder === true);
    add(signals, 'undecided', /(?:not sure|confused|decide|কনফিউজ|বুঝতে পারছি না|কোনটা নেব)/iu.test(text));
    add(signals, 'product_search', aiIntent === 'product_search' || /(?:এইরকম|এরকম|similar|like this|আর (?:একটা|একটু|কিছু)|another|more premium)/iu.test(text) || Boolean(category && /(?:show|দেখান|dekhan|chai|চাই|recommend|suggest|premium)/iu.test(text)));
    add(signals, 'product_inquiry', ['product_inquiry', 'price_inquiry', 'size_inquiry', 'stock_inquiry'].includes(aiIntent));
    add(signals, 'browsing', signals.length === 0 || /(?:just looking|দেখছি|browse)/iu.test(text));

    const precedence: ShoppingSignal[] = [
      'human_requested', 'ready_to_order', 'product_comparison', 'product_search',
      'product_inquiry', 'discount_seeking', 'undecided', 'browsing',
    ];
    const primary = precedence.find((signal) => signals.includes(signal)) ?? signals[0] ?? 'browsing';
    const codes = [...text.matchAll(/\b[A-Za-z]{2,}\s*-?\s*\d+[A-Za-z0-9-]*\b/g)]
      .map((match) => match[0].replace(/\s|-/g, '').toUpperCase())
      .slice(0, 3);

    return {
      primary,
      signals,
      filters: {
        query: entities.productCode ?? entities.productName ?? category,
        category,
        color: entities.color ?? context.previousColor ?? null,
        size: entities.size ?? context.previousSize ?? null,
        minPrice: entities.minPrice ?? context.previousMinPrice ?? null,
        maxPrice: entities.maxPrice ?? context.previousMaxPrice ?? null,
      },
      comparisonCodes: [...new Set(codes)],
      confidence: signals.some((signal) => ['human_requested', 'ready_to_order', 'product_comparison'].includes(signal)) ? 'high' : 'medium',
      source: 'rules',
    };
  }
}
