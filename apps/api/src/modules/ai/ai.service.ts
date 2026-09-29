import type { ActiveKnowledgeBase } from '../admin/knowledge-base.service.js';
import type { BusinessSettings } from '../admin/settings.service.js';
import { routeAIInput, type DetectedLanguage } from './ai-router.js';
import type { AIEventLogger } from './ai-event-logger.js';
import type { AIInput, AIResponse } from './ai.types.js';
import { AI_RESPONSE_JSON_SCHEMA, parseModelResponse } from './model-response.js';
import type { ProductContextResult, ProductContextService } from './product-context.service.js';
import { PromptBuilder } from './prompt-builder.js';
import type { AIProvider } from './providers/ai-provider.js';
import { RuleResponseService } from './rule-response.service.js';

interface KnowledgeBaseReader {
  getActiveKnowledgeBase(): Promise<ActiveKnowledgeBase | null>;
}

interface SettingsReader {
  getBusinessSettings(): Promise<BusinessSettings>;
}

interface TechnicalLogger {
  warn(bindings: object, message?: string): void;
}

export interface AIServiceConfig {
  maxHistoryMessages: number;
  maxProducts: number;
}

export interface AIServiceDependencies {
  knowledgeBase: KnowledgeBaseReader;
  settings: SettingsReader;
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

export class AIService {
  constructor(private readonly dependencies: AIServiceDependencies) {}

  async respond(input: AIInput): Promise<AIResponse> {
    const startedAt = Date.now();
    const decision = routeAIInput(input);
    const history = input.conversationHistory.slice(-this.dependencies.config.maxHistoryMessages);
    let productContext: ProductContextResult = {
      products: [],
      searchPerformed: false,
      searchTerms: [],
    };

    try {
      const [knowledgeBase, settings, products] = await Promise.all([
        this.dependencies.knowledgeBase.getActiveKnowledgeBase(),
        this.dependencies.settings.getBusinessSettings(),
        decision.needsProductSearch
          ? this.dependencies.productContext.findRelevantProducts(
              input.message,
              history,
              this.dependencies.config.maxProducts,
            )
          : Promise.resolve(productContext),
      ]);
      productContext = products;

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
        await this.logSuccess(ruleResponse, input, productContext, startedAt, 'rules', 'rules');
        return ruleResponse;
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
      const productIds = parsed.productIds.filter((id) => validIds.has(id));
      const response: AIResponse = {
        ...parsed,
        productIds,
        products: productReferences(products),
        requiresHuman: parsed.requiresHuman || parsed.confidence < 0.45,
        source: 'gemini',
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
        requiresHuman: true,
        action: 'request_human',
        productIds: [],
        products: productReferences(productContext),
        source: 'fallback',
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
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      return response;
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
    });
  }
}
