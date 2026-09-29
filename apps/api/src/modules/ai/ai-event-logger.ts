import type { PrismaClient } from '@alzeena/database';
import type { AIIntent } from './ai.types.js';

export interface AIEvent {
  success: boolean;
  intent: AIIntent;
  model: string;
  provider: string;
  latencyMs: number;
  productSearchPerformed: boolean;
  productCount: number;
  requiresHuman: boolean;
  messageLength: number;
  historyMessages: number;
  confidence?: number;
  action?: string | null;
  selectedProductIds?: number[];
  entityFields?: string[];
  toolCalls?: Array<{ tool: string; status: string; durationMs: number }>;
  errorType?: string;
}

export interface AIEventLogger {
  log(event: AIEvent): Promise<void>;
}

interface TechnicalLogger {
  warn(bindings: object, message?: string): void;
}

export class SystemLogAIEventLogger implements AIEventLogger {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: TechnicalLogger,
  ) {}

  async log(event: AIEvent): Promise<void> {
    try {
      await this.prisma.systemLog.create({
        data: {
          level: event.success ? (event.requiresHuman ? 'WARN' : 'INFO') : 'ERROR',
          type: event.success ? 'AI_RESPONSE_GENERATED' : 'AI_RESPONSE_FAILED',
          event: event.success ? 'AI_RESPONSE_GENERATED' : 'AI_RESPONSE_FAILED',
          module: 'ai',
          message: event.success ? 'AI response generated' : 'AI response generation failed',
          metadata: {
            timestamp: new Date().toISOString(),
            intent: event.intent,
            model: event.model,
            provider: event.provider,
            success: event.success,
            latencyMs: event.latencyMs,
            productSearchPerformed: event.productSearchPerformed,
            productCount: event.productCount,
            requiresHuman: event.requiresHuman,
            messageLength: event.messageLength,
            historyMessages: event.historyMessages,
            ...(event.confidence === undefined ? {} : { confidence: event.confidence }),
            ...(event.action === undefined ? {} : { action: event.action }),
            ...(event.selectedProductIds ? { selectedProductIds: event.selectedProductIds } : {}),
            ...(event.entityFields ? { entityFields: event.entityFields } : {}),
            ...(event.toolCalls ? { toolCalls: event.toolCalls } : {}),
            ...(event.errorType ? { errorType: event.errorType } : {}),
          },
        },
      });
    } catch (error) {
      this.logger.warn(
        { errorType: error instanceof Error ? error.name : 'UnknownError' },
        'Could not persist AI event log',
      );
    }
  }
}
