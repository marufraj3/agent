import type { AIResponse } from '../ai/ai.types.js';
import { extractEntities } from '../ai/entity-extractor.js';
import type { DraftOrderTool, ProductReadTool } from '../ai/sales-tool.interfaces.js';
import {
  OrderEngineError,
  type DeliveryLocationName,
  type OrderDraftContext,
  type OrderValidationIssue,
} from './order.types.js';

export interface OrderConversationInput {
  message: string;
  conversationId: string;
  customer: { id: string; name: string | null; phone: string | null; address?: string | null };
  productIds: number[];
}

export interface OrderConversationResponse extends AIResponse {
  orderAction: {
    type: 'create_order' | 'update_order' | 'confirm_order' | 'cancel_order' | 'request_order_information';
    orderId: string;
  };
}

const orderIntentPattern = /(?:অর্ডার|order|কিনতে চাই|নিতে চাই|নিব|(?:এটা|ওটা|এইটা|একটা)\s*(?:চাই|দেন)|want (?:it|this|one|[A-Za-z]{2,}-?\d+)|[A-Za-z]{2,}-?\d+.*(?:চাই|নিব)|buy|place (?:the |an )?order)/iu;
const confirmationPattern = /^(?:জি(?:\s+ঠিক আছে)?|জ্বি|হ্যাঁ|হ্যা|yes(?:\s+confirm)?|confirm(?:ed)?|ঠিক আছে|ঠিকাছে|okay|ok|অর্ডার করুন|করুন)$/iu;
const cancellationPattern = /^(?:না|না থাক|লাগবে না|বাদ দিন|বাতিল করুন|cancel(?: it| order)?|no|never mind|nevermind)$/iu;

function normalizeDigits(value: string) {
  const bn = '০১২৩৪৫৬৭৮৯';
  return value.replace(/[০-৯]/g, (digit) => String(bn.indexOf(digit)));
}

function extractQuantity(message: string): number {
  const normalized = normalizeDigits(message);
  const explicit = normalized.match(/(?:qty|quantity|পরিমাণ)\s*[:=-]?\s*(\d{1,2})/iu)?.[1];
  const withUnit = normalized.match(/(?:^|\s)(\d{1,2})\s*(?:টা|টি|piece|pieces|pcs)(?:\s|$)/iu)?.[1];
  const quantity = Number(explicit ?? withUnit ?? 1);
  return Number.isInteger(quantity) && quantity > 0 ? quantity : 1;
}

function extractSize(message: string): string | undefined {
  const matches = [...message.matchAll(/(?:size\s*)?(xxxl|3xl|xxl|2xl|xl|xs|s|m|l)(?:\s*size)?\b/giu)];
  const value = matches.at(-1)?.[1];
  if (!value) return undefined;
  return value.toUpperCase().replace('2XL', 'XXL').replace('3XL', 'XXXL');
}

function extractPhone(message: string): string | undefined {
  const normalized = normalizeDigits(message);
  return normalized.match(/(?:\+?880|0)?1[3-9][\d\s-]{8,12}/u)?.[0];
}

function extractLocation(message: string): DeliveryLocationName | undefined {
  if (/(?:outside\s*dhaka|ঢাকার বাইরে|ঢাকা বাইরে|out of dhaka)/iu.test(message)) return 'OUTSIDE_DHAKA';
  if (/(?:inside\s*dhaka|ঢাকার ভিতরে|ঢাকার মধ্যে|dhaka|ঢাকা)/iu.test(message)) return 'DHAKA';
  return undefined;
}

function issuePrompt(issue: OrderValidationIssue): { reply: string; field: OrderDraftContext['requestedField'] } {
  switch (issue.code) {
    case 'MISSING_ITEMS': return { reply: 'কোন প্রোডাক্টটি অর্ডার করবেন? প্রোডাক্টের নাম বা ছবি এবং সাইজ বলুন।', field: 'product' };
    case 'MISSING_NAME': return { reply: 'অর্ডারের জন্য আপনার নামটি বলবেন?', field: 'name' };
    case 'MISSING_PHONE':
    case 'INVALID_PHONE': return { reply: 'অর্ডারের জন্য একটি সঠিক বাংলাদেশি মোবাইল নম্বর দিন।', field: 'phone' };
    case 'MISSING_ADDRESS': return { reply: 'সম্পূর্ণ ডেলিভারি ঠিকানাটি লিখে দিন।', field: 'address' };
    case 'MISSING_DELIVERY_LOCATION': return { reply: 'ডেলিভারি ঠিকানাটি ঢাকার ভিতরে, নাকি ঢাকার বাইরে?', field: 'location' };
    case 'MISSING_OR_INVALID_SIZE': return { reply: 'কোন সাইজটি নেবেন? উপলভ্য সাইজ থেকে বলুন।', field: 'size' };
    default: return { reply: issue.message, field: 'product' };
  }
}

export class OrderConversationService {
  constructor(private readonly orders: DraftOrderTool, private readonly products?: Pick<ProductReadTool, 'searchProducts'>) {}

  async handle(input: OrderConversationInput): Promise<OrderConversationResponse | null> {
    let order = await this.orders.getActiveOrderForConversation(input.conversationId);
    let created = false;
    const message = input.message.trim();
    const messageEntities = extractEntities(message);
    let productIds = input.productIds;
    if (!order && productIds.length === 0 && this.products && (messageEntities.productCode || messageEntities.productName)) {
      const candidates = await this.products.searchProducts(messageEntities.productCode ?? messageEntities.productName!, 5);
      const normalizedCode = messageEntities.productCode?.replace(/[^a-z0-9]/gi, '').toLowerCase();
      const exact = candidates.filter((product) => normalizedCode
        ? product.productCode.replace(/[^a-z0-9]/gi, '').toLowerCase().startsWith(normalizedCode)
        : product.productName.toLowerCase() === messageEntities.productName?.toLowerCase());
      if (exact.length === 1) productIds = [exact[0]!.id];
    }
    let reopenedForCorrection = false;

    if (order?.status === 'AWAITING_CONFIRMATION') {
      const correctionRequested = messageEntities.correction || messageEntities.size !== null || messageEntities.quantity !== null || messageEntities.phone !== null || messageEntities.customerName !== null || messageEntities.address !== null || messageEntities.deliveryLocation !== null;
      if (confirmationPattern.test(message)) {
        await this.orders.confirmOrder(order.id, message);
        try {
          const submitted = await this.orders.submitOrder(order.id);
          return this.response(
            `আপনার অর্ডারটি সফলভাবে সাবমিট হয়েছে। অর্ডার আইডি: ${submitted.externalOrderId}`,
            'confirm_order',
            order.id,
            'order_intent',
          );
        } catch (error) {
          if (error instanceof OrderEngineError && error.code === 'ORDER_SUBMISSION_UNKNOWN') {
            return this.response(
              'অর্ডার পাঠানোর ফলাফল নিশ্চিত হওয়া যায়নি। ডুপ্লিকেট অর্ডার এড়াতে আমরা স্বয়ংক্রিয়ভাবে আবার পাঠাব না; একজন অ্যাডমিন যাচাই করবেন।',
              'confirm_order',
              order.id,
              'order_intent',
              true,
            );
          }
          if (error instanceof OrderEngineError && error.code === 'ORDER_SUBMISSION_FAILED') {
            return this.response(
              'ওয়েবসাইট অর্ডারটি গ্রহণ করেনি। নিরাপদ যাচাইয়ের পর একজন অ্যাডমিন প্রয়োজনে আবার চেষ্টা করতে পারবেন।',
              'confirm_order',
              order.id,
              'order_intent',
              true,
            );
          }
          throw error;
        }
      }
      if (cancellationPattern.test(message)) {
        await this.orders.cancelOrder(order.id);
        return this.response('অর্ডারটি বাতিল করা হয়েছে।', 'cancel_order', order.id, 'order_intent');
      }
      if (correctionRequested) {
        order = await this.orders.reopenForCorrection(order.id);
        reopenedForCorrection = true;
      } else {
        return this.response(
          'অর্ডারটি নিশ্চিত করতে শুধু “জি” বা “Confirm” বলুন। কোনো তথ্য পরিবর্তন করতে চাইলে সেটি স্পষ্ট করে লিখুন।',
          'request_order_information',
          order.id,
          'order_intent',
        );
      }
    }

    if (!order && !orderIntentPattern.test(message)) return null;
    const size = extractSize(message);

    if (!order) {
      created = true;
      order = await this.orders.createDraftOrder({
        customerId: input.customer.id,
        conversationId: input.conversationId,
        customer: {
          name: input.customer.name,
          phone: input.customer.phone,
          address: input.customer.address,
        },
        draftContext: { productIds, size, quantity: extractQuantity(message) },
      });
    }

    if (cancellationPattern.test(message)) {
      await this.orders.cancelOrder(order.id);
      return this.response('অর্ডারটি বাতিল করা হয়েছে।', 'cancel_order', order.id, 'order_intent');
    }

    const context = this.context(order.draftContext);
    const entities = messageEntities;
    const phone = extractPhone(message);
    const location = extractLocation(message);
    const customerUpdates = {
      ...(entities.customerName ? { name: entities.customerName } : {}),
      ...(phone ? { phone } : {}),
      ...(entities.address ? { address: entities.address } : {}),
    };
    if (Object.keys(customerUpdates).length > 0) await this.orders.updateCustomerInformation(order.id, customerUpdates);
    if (location) await this.orders.setDeliveryLocation(order.id, location);
    if (context.requestedField === 'name' && !entities.customerName && !phone && !location && message.length <= 255) {
      await this.orders.updateCustomerInformation(order.id, { name: message });
    } else if (
      context.requestedField === 'address' &&
      !entities.address &&
      !phone &&
      message.length <= 2_000 &&
      !/^(?:dhaka|ঢাকা|inside dhaka|outside dhaka)$/iu.test(message)
    ) {
      await this.orders.updateCustomerInformation(order.id, { address: message });
    }

    order = await this.orders.getOrder(order.id);
    if (reopenedForCorrection && order.items[0]) {
      const item = order.items[0];
      if (size && size.toLowerCase() !== item.variationSize.toLowerCase()) {
        await this.orders.removeOrderItem(order.id, item.id);
        await this.orders.addOrderItem(order.id, { websiteProductId: item.websiteProductId, size, quantity: entities.quantity ?? item.quantity });
      } else if (entities.quantity && entities.quantity !== item.quantity) {
        await this.orders.updateOrderItem(order.id, item.id, entities.quantity);
      }
      order = await this.orders.getOrder(order.id);
    }
    const selectedProductId = productIds.length === 1 ? productIds[0] : context.productIds?.[0];
    const selectedSize = size ?? context.size ?? undefined;
    const addingAnother = /(?:আরেক|আরও|add another|also add|another)/iu.test(message);
    if ((order.items.length === 0 || addingAnother) && selectedProductId && selectedSize) {
      await this.orders.addOrderItem(order.id, {
        websiteProductId: selectedProductId,
        size: selectedSize,
        quantity: extractQuantity(message) || context.quantity || 1,
      });
    }

    const issues = await this.orders.validateOrder(order.id);
    if (issues.length > 0) {
      const firstIssue = issues[0]!;
      const next = firstIssue.code === 'MISSING_ITEMS' && selectedProductId && !selectedSize
        ? issuePrompt({ code: 'MISSING_OR_INVALID_SIZE', message: 'Size is required' })
        : issuePrompt(firstIssue);
      await this.orders.updateDraftContext(order.id, {
        ...context,
        productIds: selectedProductId ? [selectedProductId] : context.productIds,
        size: selectedSize ?? null,
        quantity: extractQuantity(message),
        requestedField: next.field,
      });
      return this.response(next.reply, created ? 'create_order' : 'update_order', order.id, 'order_intent');
    }

    const confirmation = await this.orders.requestConfirmation(order.id);
    return this.response(
      this.summary(confirmation),
      'request_order_information',
      order.id,
      'order_intent',
    );
  }

  private summary(order: any) {
    const customer = order.customerSnapshot as { name: string; phone: string; address: string };
    const items = order.items
      .map((item: any) => `${item.productName} (${item.variationSize}) × ${item.quantity} — ৳${item.lineTotal.toFixed(2)}`)
      .join('\n');
    const location = order.deliveryLocation === 'DHAKA' ? 'ঢাকার ভিতরে' : 'ঢাকার বাইরে';
    return [
      'অর্ডারের সম্পূর্ণ সারাংশ:',
      items,
      `নাম: ${customer.name}`,
      `ফোন: ${customer.phone}`,
      `ঠিকানা: ${customer.address}`,
      `ডেলিভারি: ${location} — ৳${order.deliveryCharge.toFixed(2)}`,
      `সাবটোটাল: ৳${order.subtotal.toFixed(2)}`,
      `মোট: ৳${order.totalAmount.toFixed(2)}`,
      'সব তথ্য ঠিক থাকলে “জি” বা “Confirm” লিখুন।',
    ].join('\n');
  }

  private context(value: unknown): OrderDraftContext {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as OrderDraftContext)
      : {};
  }

  private response(
    reply: string,
    type: OrderConversationResponse['orderAction']['type'],
    orderId: string,
    intent: 'order_intent',
    requiresHuman = false,
  ): OrderConversationResponse {
    return {
      reply,
      intent,
      confidence: 1,
      language: 'bn',
      entities: extractEntities(''),
      requiresHuman,
      action: requiresHuman ? 'handover' : type,
      orderAction: { type, orderId },
      productIds: [],
      products: [],
      source: 'rules',
    };
  }
}
