import type { BusinessSettings } from '../admin/settings.service.js';
import { resolveEffectivePrice } from '../products/effective-price.js';
import type { AIResponse } from './ai.types.js';
import type { AIRouteDecision } from './ai-router.js';
import type { AIProductContext } from './product-context.service.js';
import { extractEntities } from './entity-extractor.js';

function productReferences(products: AIProductContext[]) {
  return products.map(({ product }) => ({
    id: product.id,
    productName: product.productName,
    productCode: product.productCode,
    image: product.image,
  }));
}

function priceText(product: AIProductContext['product'], language: AIRouteDecision['language']): string {
  const activePrice = resolveEffectivePrice(product);
  const original = activePrice !== product.sellPrice ? product.sellPrice : null;

  if (language === 'bn') {
    return `${product.productName} (${product.productCode})-এর দাম ৳${activePrice}${original ? ` (নিয়মিত ৳${original})` : ''}।`;
  }
  if (language === 'banglish') {
    return `${product.productName} (${product.productCode})-er dam ৳${activePrice}${original ? `, regular ৳${original}` : ''}.`;
  }
  return `${product.productName} (${product.productCode}) is BDT ${activePrice}${original ? ` (regular BDT ${original})` : ''}.`;
}

function unknownProductReply(language: AIRouteDecision['language']): string {
  if (language === 'bn') return 'দুঃখিত, এই তথ্য দিয়ে লোকাল প্রোডাক্ট ডাটাবেসে কোনো পণ্য খুঁজে পাইনি। প্রোডাক্ট কোড বা নামটি আরেকবার দিন।';
  if (language === 'banglish') return 'Sorry, ei name/code diye local product database-e kichu khuje paini. Product code ba name ta abar diben?';
  return 'Sorry, I could not find a matching item in the local product database. Please share the product name or code again.';
}

function requestedSize(message: string, products: AIProductContext[]): string | null {
  const names = products.flatMap(({ availability }) => availability?.sizes.map((size) => size.sizeName) ?? []);
  return (
    names.find((name) => new RegExp(`(^|[^A-Za-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`, 'i').test(message)) ??
    null
  );
}

export class RuleResponseService {
  create(
    decision: AIRouteDecision,
    message: string,
    products: AIProductContext[],
    settings: BusinessSettings,
  ): AIResponse | null {
    const productIds = products.map(({ product }) => product.id);
    const references = productReferences(products);
    const base = {
      intent: decision.intent,
      language: decision.language,
      entities: extractEntities(message),
      action: null,
      productIds,
      products: references,
      source: 'rules' as const,
    };

    if (decision.intent === 'greeting') {
      const reply =
        decision.language === 'bn'
          ? 'ওয়ালাইকুম আসসালাম! কী ধরনের পোশাক খুঁজছেন?'
          : decision.language === 'banglish'
            ? 'Walaikum assalam! Ki dhoroner product khujchen?'
            : 'Hello! What kind of clothing are you looking for?';
      return { ...base, reply, confidence: 0.99, requiresHuman: false };
    }

    if (decision.intent === 'human_request') {
      const reply =
        decision.language === 'bn'
          ? 'অবশ্যই, একজন প্রতিনিধি আপনাকে সাহায্য করবেন।'
          : decision.language === 'banglish'
            ? 'Obosshoi, ekjon representative apnake help korben.'
            : 'Of course. A human representative will assist you.';
      return { ...base, reply, confidence: 0.99, requiresHuman: true, action: 'request_human' };
    }

    if (decision.intent === 'delivery_inquiry') {
      const lower = message.toLowerCase();
      const scope = /return|রিটার্ন|ফেরত/iu.test(lower)
        ? 'return'
        : /outside|বাইরে|district|জেলা/iu.test(lower)
          ? 'outside'
          : /dhaka|ঢাকা/iu.test(lower)
            ? 'dhaka'
            : 'all';
      const charge =
        scope === 'return'
          ? settings.returnDeliveryCharge
          : scope === 'outside'
            ? settings.deliveryChargeOutsideDhaka
            : settings.deliveryChargeDhaka;
      let reply: string;
      if (scope === 'all') {
        reply =
          decision.language === 'bn'
            ? `ঢাকায় ডেলিভারি চার্জ ৳${settings.deliveryChargeDhaka}, ঢাকার বাইরে ৳${settings.deliveryChargeOutsideDhaka}।`
            : decision.language === 'banglish'
              ? `Dhaka delivery charge ৳${settings.deliveryChargeDhaka}, outside Dhaka ৳${settings.deliveryChargeOutsideDhaka}.`
              : `Dhaka delivery is BDT ${settings.deliveryChargeDhaka}; outside Dhaka is BDT ${settings.deliveryChargeOutsideDhaka}.`;
      } else {
        const bnLabel = scope === 'return' ? 'রিটার্ন' : scope === 'outside' ? 'ঢাকার বাইরে' : 'ঢাকায়';
        const enLabel = scope === 'return' ? 'Return' : scope === 'outside' ? 'Outside Dhaka' : 'Dhaka';
        reply =
          decision.language === 'bn'
            ? `${bnLabel} ডেলিভারি চার্জ ৳${charge}।`
            : decision.language === 'banglish'
              ? `${enLabel} delivery charge ৳${charge}.`
              : `${enLabel} delivery charge is BDT ${charge}.`;
      }
      return { ...base, reply, confidence: 0.99, requiresHuman: false };
    }

    if (
      ['product_inquiry', 'product_search', 'price_inquiry', 'size_inquiry', 'stock_inquiry'].includes(
        decision.intent,
      )
    ) {
      if (products.length === 0) {
        const asksOnlySize = decision.intent === 'size_inquiry';
        const reply = asksOnlySize
          ? decision.language === 'bn'
            ? 'কোন প্রোডাক্টের সাইজ জানতে চান? প্রোডাক্টের নাম বা কোড দিন।'
            : decision.language === 'banglish'
              ? 'Kon product-er size jante chan? Product name ba code ta diben?'
              : 'Which product size would you like to check? Please share its name or code.'
          : unknownProductReply(decision.language);
        return {
          ...base,
          reply,
          confidence: 0.95,
          requiresHuman: false,
          action: 'request_product_clarification',
        };
      }

      const first = products[0]!;
      if (decision.intent === 'price_inquiry') {
        return {
          ...base,
          reply: priceText(first.product, decision.language),
          confidence: 0.99,
          requiresHuman: false,
        };
      }

      if (decision.intent === 'size_inquiry' || decision.intent === 'stock_inquiry') {
        const sizeName = requestedSize(message, products);
        const sizes = first.availability?.sizes ?? [];
        const selected = sizeName
          ? sizes.filter((size) => size.sizeName.toLowerCase() === sizeName.toLowerCase())
          : sizes;
        if (selected.length === 0) {
          return {
            ...base,
            reply: unknownProductReply(decision.language),
            confidence: 0.8,
            requiresHuman: false,
          };
        }
        const details = selected
          .map((size) => {
            if (size.availabilityType === 'pre_order') {
              return `${size.sizeName}: stock ${size.stock}, pre-order available`;
            }
            if (size.availabilityType === 'in_stock') {
              return `${size.sizeName}: ${size.stock} in stock`;
            }
            return `${size.sizeName}: currently unavailable`;
          })
          .join('; ');
        const reply =
          decision.language === 'bn'
            ? `${first.product.productName}-এর সাইজ তথ্য—${details}।`
            : decision.language === 'banglish'
              ? `${first.product.productName}-er size info—${details}.`
              : `${first.product.productName} availability—${details}.`;
        return { ...base, reply, confidence: 0.99, requiresHuman: false };
      }

      const names = products
        .slice(0, 3)
        .map(({ product }) => `${product.productName} (${product.productCode})`)
        .join(', ');
      const reply =
        decision.language === 'bn'
          ? `লোকাল ডাটাবেসে পেয়েছি: ${names}। কোনটির দাম বা সাইজ জানতে চান?`
          : decision.language === 'banglish'
            ? `Local database-e peyechi: ${names}. Kontar price ba size jante chan?`
            : `I found: ${names}. Which one would you like price or size details for?`;
      return { ...base, reply, confidence: 0.96, requiresHuman: false };
    }

    return null;
  }
}
