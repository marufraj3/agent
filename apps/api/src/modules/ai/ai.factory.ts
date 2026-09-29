import type { PrismaClient } from '@alzeena/database';
import { env } from '../../config/env.js';
import { KnowledgeBaseService } from '../admin/knowledge-base.service.js';
import { SettingsService } from '../admin/settings.service.js';
import { ProductCatalogService } from '../products/product-catalog.service.js';
import { SystemLogAIEventLogger } from './ai-event-logger.js';
import { AIService } from './ai.service.js';
import { ProductContextService } from './product-context.service.js';
import { PromptBuilder } from './prompt-builder.js';
import type { AIProvider } from './providers/ai-provider.js';
import { GeminiProvider } from './providers/gemini.provider.js';
import { RuleResponseService } from './rule-response.service.js';

interface AILogger {
  warn(bindings: object, message?: string): void;
}

export function createAIProvider(): AIProvider | undefined {
  return env.GEMINI_API_KEY
    ? new GeminiProvider({
        apiKey: env.GEMINI_API_KEY,
        model: env.GEMINI_MODEL,
        temperature: env.GEMINI_TEMPERATURE,
        maxOutputTokens: env.GEMINI_MAX_OUTPUT_TOKENS,
        timeoutMs: env.GEMINI_TIMEOUT_MS,
      })
    : undefined;
}

export function createAIService(prisma: PrismaClient, logger: AILogger): AIService {
  const provider = createAIProvider();

  return new AIService({
    knowledgeBase: new KnowledgeBaseService(prisma),
    settings: new SettingsService(prisma),
    productContext: new ProductContextService(new ProductCatalogService(prisma)),
    promptBuilder: new PromptBuilder(),
    ruleResponses: new RuleResponseService(),
    eventLogger: new SystemLogAIEventLogger(prisma, logger),
    logger,
    provider,
    config: {
      maxHistoryMessages: env.AI_MAX_HISTORY_MESSAGES,
      maxProducts: env.AI_MAX_PRODUCTS,
      highConfidence: env.AI_CONFIDENCE_HIGH,
      lowConfidence: env.AI_CONFIDENCE_LOW,
    },
  });
}
