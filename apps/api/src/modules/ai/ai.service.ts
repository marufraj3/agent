import { detectLanguage, routeAIInput, type DetectedLanguage } from './ai-router.js';
import type { AIEventLogger } from './ai-event-logger.js';
import type { AIInput, AIResponse, AIToolCallTrace } from './ai.types.js';
import { AI_RESPONSE_JSON_SCHEMA, parseModelResponse } from './model-response.js';
import type { ProductContextResult, ProductContextService } from './product-context.service.js';
import { PromptBuilder } from './prompt-builder.js';
import type { AIProvider } from './providers/ai-provider.js';
import { RuleResponseService } from './rule-response.service.js';
import { extractEntities } from './entity-extractor.js';
import { normalizeCustomerText } from './language-normalizer.js';
import type { KnowledgeTool, SettingsTool } from './sales-tool.interfaces.js';

interface TechnicalLogger {
  warn(bindings: object, message?: string): void;
}

export interface AIServiceConfig {
  maxHistoryMessages: number;
  maxProducts: number;
  highConfidence?: number;
  lowConfidence?: number;
}

export interface AIServiceDependencies {
  knowledgeBase: KnowledgeTool;
  settings: SettingsTool;
  productContext: ProductContextService;
  promptBuilder: PromptBuilder;
  ruleResponses: RuleResponseService;
  eventLogger: AIEventLogger;
  logger: TechnicalLogger;
  provider?: AIProvider;
  config: AIServiceConfig;
}

function fallbackReply(language: DetectedLanguage): string {
  if (language === 'en') return 'Sorry, something is not working right now. A representative will help you.';
  if (language === 'banglish') return 'Dukkhito, ektu problem hocche. Ekjon representative apnake help korben.';
  return 'দুঃখিত, একটু সমস্যা হচ্ছে। একজন প্রতিনিধি আপনাকে সাহায্য করবে।';
}

function productReferences(context: ProductContextResult) {
  return context.products.map(({ product }) => ({
    id: product.id,
    productName: product.productName,
    productCode: product.productCode,
    image: product.image,
  }));
}

function isAmbiguousReference(message: string, context: ProductContextResult): boolean {
  return (
    context.products.length > 1 &&
    context.currentSearchTerms.length === 0 &&
    /(?:এটা|ওটা|এইটা|ওইটা|আগেরটা|একটা|this one|that one|the previous one|\b(?:xs|s|m|l|xl|xxl|xxxl)\s*size\b|size\s*(?:আছে|ache|ase)|দাম|price|stock|available)/iu.test(message)
  );
}

function clarificationReply(language: DetectedLanguage): string {
  if (language === 'bn') return 'কোন প্রোডাক্টটি বোঝাচ্ছেন? নাম বা কোডটি বলবেন?';
  if (language === 'banglish') return 'Kon product-ta bolchen? Name ba code-ta diben?';
  return 'Which product do you mean? Please share its name or code.';
}

function validateBusinessToolResults(knowledgeBase: unknown, settings: unknown, products: ProductContextResult): void {
  if (knowledgeBase !== null && (typeof knowledgeBase !== 'object' || typeof (knowledgeBase as { content?: unknown }).content !== 'string')) throw new Error('Invalid knowledge tool result');
  const values = settings as Record<string, unknown>;
  for (const field of ['deliveryChargeDhaka', 'deliveryChargeOutsideDhaka', 'returnDeliveryCharge']) {
    if (typeof values?.[field] !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(values[field] as string)) throw new Error('Invalid settings tool result');
  }
  for (const item of products.products) {
    if (!Number.isInteger(item.product.id) || !item.product.productCode || !item.product.productName || !/^\d+(?:\.\d{1,2})?$/.test(item.product.sellPrice)) throw new Error('Invalid product tool result');
    if (item.availability && item.availability.id !== item.product.id) throw new Error('Mismatched availability tool result');
    if (item.availability?.sizes.some((size) => !Number.isInteger(size.stock) || size.stock < 0 || typeof size.orderable !== 'boolean')) throw new Error('Invalid availability tool result');
  }
}

function confidenceThresholds(config: AIServiceConfig): { high: number; low: number } {
  const high = config.highConfidence ?? 0.8;
  const low = config.lowConfidence ?? 0.45;
  if (low < 0 || high > 1 || low >= high) throw new Error('Invalid AI confidence thresholds');
  return { high, low };
}

export class AIService {
  constructor(private readonly dependencies: AIServiceDependencies) {}

  async respond(input: AIInput): Promise<AIResponse> {
    const startedAt = Date.now();
    const normalizedMessage = normalizeCustomerText(input.message);
    const localEntities = extractEntities(input.message);
    const decision = { ...routeAIInput({ ...input, message: normalizedMessage }), language: detectLanguage(input.message, input.language) };
    const toolCalls: AIToolCallTrace[] = [];
    const history = input.conversationHistory.slice(-this.dependencies.config.maxHistoryMessages);
    let productContext: ProductContextResult = {
      products: [],
      searchPerformed: false,
      searchTerms: [],
      currentSearchTerms: [],
    };

    try {
      const [knowledgeBase, settings, resolvedProducts] = await Promise.all([
        this.callTool('knowledge_base.get_active', () => this.dependencies.knowledgeBase.getActiveKnowledgeBase(), toolCalls),
        this.callTool('settings.get_business', () => this.dependencies.settings.getBusinessSettings(), toolCalls),
        decision.needsProductSearch || input.contextProductIds.length > 0
          ? this.callTool('products.search_and_availability', () => this.dependencies.productContext.findRelevantProducts(
              normalizedMessage,
              history,
              this.dependencies.config.maxProducts,
              input.contextProductIds,
            ), toolCalls)
          : Promise.resolve(productContext),
      ]);
      let products = resolvedProducts;
      const referenceIndex = localEntities.ordinalReference
        ? localEntities.ordinalReference - 1
        : /(?:previous product|the previous one|আগেরটা|আগের প্রোডাক্ট)/iu.test(input.message)
          ? 1
          : /(?:current product|this one|এটা|এইটা|এই প্রোডাক্ট)/iu.test(input.message)
            ? 0
            : null;
      if (referenceIndex !== null && resolvedProducts.products[referenceIndex]) {
        products = { ...resolvedProducts, products: [resolvedProducts.products[referenceIndex]!] };
      }
      productContext = products;
      validateBusinessToolResults(knowledgeBase, settings, products);

      if (isAmbiguousReference(input.message, products)) {
        const response: AIResponse = {
          reply: clarificationReply(decision.language),
          intent: decision.intent,
          confidence: 0.98,
          language: decision.language,
          entities: localEntities,
          requiresHuman: false,
          action: 'clarify',
          productIds: [],
          products: productReferences(products),
          source: 'rules',
          debug: { latencyMs: Date.now() - startedAt, model: null, toolCalls },
        };
        await this.logSuccess(response, input, productContext, startedAt, 'rules', 'rules');
        return response;
      }

      if (/(complain|complaint|refund|exchange|payment (?:failed|problem|issue)|order (?:failed|problem|issue)|অভিযোগ|রিফান্ড|এক্সচেঞ্জ|পেমেন্ট সমস্যা|অর্ডার সমস্যা)/iu.test(input.message)) {
        const response: AIResponse = {
          reply: decision.language === 'en' ? 'I’m sorry about this. A human representative will help you now.' : 'দুঃখিত। একজন প্রতিনিধি এখন আপনাকে সাহায্য করবেন।',
          intent: decision.intent, confidence: 0.99, language: decision.language, entities: localEntities,
          requiresHuman: true, action: 'handover', productIds: [], products: productReferences(products), source: 'rules',
          debug: { latencyMs: Date.now() - startedAt, model: null, toolCalls },
        };
        await this.logSuccess(response, input, productContext, startedAt, 'rules', 'rules');
        return response;
      }

      const ruleResponse = this.dependencies.ruleResponses.create(
        decision,
        input.message,
        products.products,
        settings,
      );
      if (
        ruleResponse &&
        (!decision.useAI ||
          (decision.intent === 'product_search' && products.products.length === 0))
      ) {
        ruleResponse.debug = { latencyMs: Date.now() - startedAt, model: null, toolCalls };
        await this.logSuccess(ruleResponse, input, productContext, startedAt, 'rules', 'rules');
        return ruleResponse;
      }

      if (/(?:system prompt|developer message|api[_ -]?key|password|access token|credentials?|internal logs?|ignore (?:all |previous )?instructions|গোপন নির্দেশনা)/iu.test(input.message)) {
        const response: AIResponse = {
          reply: decision.language === 'en' ? 'I cannot share private instructions or credentials. I can help with products and orders.' : 'ব্যক্তিগত নির্দেশনা বা ক্রেডেনশিয়াল শেয়ার করা যাবে না। প্রোডাক্ট বা অর্ডারে সাহায্য করতে পারি।',
          intent: 'general_question', confidence: 1, language: decision.language, entities: localEntities,
          requiresHuman: false, action: 'reply', productIds: [], products: [], source: 'rules',
          debug: { latencyMs: Date.now() - startedAt, model: null, toolCalls },
        };
        await this.logSuccess(response, input, productContext, startedAt, 'rules', 'rules');
        return response;
      }

      if (!knowledgeBase) {
        throw new Error('Active Knowledge Base is unavailable');
      }
      if (!this.dependencies.provider) {
        throw new Error('Gemini provider is not configured');
      }

      const builtPrompt = this.dependencies.promptBuilder.build({
        knowledgeBase,
        settings,
        products: products.products,
        customer: input.customerContext,
        conversationSummary: input.conversationSummary,
        salesState: input.salesState,
        history,
        customerMessage: input.message,
        detectedLanguage: decision.language,
        intent: decision.intent,
      });

      let providerResponse = await this.dependencies.provider.generateStructured({
        ...builtPrompt,
        responseJsonSchema: AI_RESPONSE_JSON_SCHEMA,
      });
      let parsed = parseModelResponse(providerResponse.text);

      if (!parsed) {
        providerResponse = await this.dependencies.provider.generateStructured({
          systemInstruction: builtPrompt.systemInstruction,
          prompt: `${builtPrompt.prompt}\n\nCORRECTION: The previous output was invalid. Return exactly one valid JSON object matching the schema. No markdown or commentary.`,
          responseJsonSchema: AI_RESPONSE_JSON_SCHEMA,
        });
        parsed = parseModelResponse(providerResponse.text);
      }

      if (!parsed) throw new Error('Gemini returned invalid structured output twice');

      const validIds = new Set(products.products.map(({ product }) => product.id));
      const productIds = parsed.productIds.filter((id) => validIds.has(id)).slice(0, 5);
      const thresholds = confidenceThresholds(this.dependencies.config);
      const mediumConfidence = parsed.confidence >= thresholds.low && parsed.confidence < thresholds.high;
      const lowConfidence = parsed.confidence < thresholds.low;
      const response: AIResponse = {
        ...parsed,
        ...(mediumConfidence ? { reply: clarificationReply(decision.language), action: 'clarify' as const } : {}),
        language: decision.language,
        entities: Object.fromEntries(Object.entries(parsed.entities).map(([key, value]) => [key, (localEntities as unknown as Record<string, unknown>)[key] ?? value])) as typeof parsed.entities,
        productIds,
        products: productReferences(products).filter((product) => productIds.includes(product.id)),
        requiresHuman: parsed.requiresHuman || lowConfidence,
        ...(lowConfidence ? { action: 'handover' as const } : {}),
        source: 'gemini',
        debug: { latencyMs: Date.now() - startedAt, model: providerResponse.model, toolCalls },
      };

      await this.logSuccess(
        response,
        input,
        productContext,
        startedAt,
        this.dependencies.provider.name,
        providerResponse.model,
      );
      return response;
    } catch (error) {
      const response: AIResponse = {
        reply: fallbackReply(decision.language),
        intent: decision.intent,
        confidence: 0,
        language: decision.language,
        entities: localEntities,
        requiresHuman: true,
        action: 'request_human',
        productIds: [],
        products: productReferences(productContext),
        source: 'fallback',
        debug: { latencyMs: Date.now() - startedAt, model: this.dependencies.provider?.model ?? null, toolCalls, fallbackReason: error instanceof Error ? error.name : 'UnknownError' },
      };

      this.dependencies.logger.warn(
        { errorType: error instanceof Error ? error.name : 'UnknownError', intent: decision.intent },
        'AI response generation fell back safely',
      );
      await this.dependencies.eventLogger.log({
        success: false,
        intent: decision.intent,
        model: this.dependencies.provider?.model ?? 'not-configured',
        provider: this.dependencies.provider?.name ?? 'none',
        latencyMs: Date.now() - startedAt,
        productSearchPerformed: productContext.searchPerformed,
        productCount: productContext.products.length,
        requiresHuman: true,
        messageLength: input.message.length,
        historyMessages: history.length,
        confidence: 0,
        action: response.action,
        selectedProductIds: [],
        entityFields: Object.entries(localEntities).filter(([, value]) => value !== null && value !== false).map(([key]) => key),
        toolCalls,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      return response;
    }
  }

  private async callTool<T>(name: string, operation: () => Promise<T>, traces: AIToolCallTrace[]): Promise<T> {
    const started = Date.now();
    try {
      const result = await operation();
      const count = Array.isArray(result) ? result.length : result && typeof result === 'object' && 'products' in result && Array.isArray((result as { products?: unknown[] }).products) ? (result as { products: unknown[] }).products.length : undefined;
      traces.push({ tool: name, status: 'ok', durationMs: Date.now() - started, ...(count === undefined ? {} : { resultCount: count }) });
      return result;
    } catch (error) {
      traces.push({ tool: name, status: 'error', durationMs: Date.now() - started });
      throw error;
    }
  }

  private async logSuccess(
    response: AIResponse,
    input: AIInput,
    context: ProductContextResult,
    startedAt: number,
    provider: string,
    model: string,
  ): Promise<void> {
    await this.dependencies.eventLogger.log({
      success: true,
      intent: response.intent,
      model,
      provider,
      latencyMs: Date.now() - startedAt,
      productSearchPerformed: context.searchPerformed,
      productCount: context.products.length,
      requiresHuman: response.requiresHuman,
      messageLength: input.message.length,
      historyMessages: Math.min(
        input.conversationHistory.length,
        this.dependencies.config.maxHistoryMessages,
      ),
      confidence: response.confidence,
      action: response.action,
      selectedProductIds: response.productIds,
      entityFields: Object.entries(response.entities).filter(([, value]) => value !== null && value !== false).map(([key]) => key),
      toolCalls: response.debug?.toolCalls,
    });
  }
}
