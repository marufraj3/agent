import type { PrismaClient } from '@alzeena/database';
import type { AIService } from '../ai/ai.service.js';
import type { AIResponse } from '../ai/ai.types.js';
import { transcriptionSchema, type AudioInput, type Transcription } from '../audio/audio.types.js';
import type { VoiceUnderstandingService } from '../audio/voice-understanding.service.js';
import type { ImageProductService } from '../images/image-product.service.js';
import type { ImageInput } from '../images/image.types.js';
import type { HumanHandoverService } from '../handovers/human-handover.service.js';
import type { HandoverReasonName } from '../handovers/handover.types.js';
import type { OrderConversationService } from '../orders/order-conversation.service.js';
import { ProductCatalogService } from '../products/product-catalog.service.js';
import type { ConversationChannelName } from './conversation.types.js';
import { ConversationContextService } from './conversation-context.service.js';
import { ConversationService } from './conversation.service.js';
import { CustomerService, type CreateCustomerInput } from './customer.service.js';
import { MessageService } from './message.service.js';

export interface ChatInput {
  customer: CreateCustomerInput & {
    platform: string;
    platformUserId: string;
  };
  message?: string;
  image?: ImageInput;
  audio?: AudioInput;
  channel: ConversationChannelName;
  conversationId?: string;
  newConversation?: boolean;
  externalMessageId?: string;
  sourceMetadata?: import('./conversation.types.js').JsonMetadata;
}

export class ConversationAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationAccessError';
  }
}

function combineVoiceAndText(transcription: string, text: string): string {
  if (!text) return transcription;
  const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();
  const spoken = normalize(transcription);
  const written = normalize(text);
  if (spoken.includes(written) || written.includes(spoken)) return transcription.length >= text.length ? transcription : text;
  return `${transcription}\nAdditional written context: ${text}`;
}

function voiceClarificationResponse(
  reason: 'failed' | 'low_confidence' | 'processing_failed',
): AIResponse {
  const reply =
    reason === 'failed'
      ? 'ভাই, ভয়েসটা ঠিকমতো বুঝতে পারিনি। আরেকবার একটু পরিষ্কার করে পাঠাবেন বা লিখে দেবেন?'
      : reason === 'low_confidence'
        ? 'ভাই, আপনার কথাটা পুরোপুরি বুঝতে পারিনি। একটু পরিষ্কার করে আবার বলবেন বা লিখে দিলে ভালোভাবে সাহায্য করতে পারব।'
        : 'ভাই, ভয়েসটি বুঝেছি কিন্তু প্রোডাক্টটি নিরাপদভাবে যাচাই করতে পারিনি। প্রোডাক্টের নাম বা কোডটি লিখে দেবেন?';
  return {
    reply,
    intent: 'unknown',
    confidence: 0,
    requiresHuman: false,
    action: 'request_voice_clarification',
    productIds: [],
    products: [],
    source: 'fallback',
  };
}

export class ChatService {
  private readonly customers: CustomerService;
  private readonly conversations: ConversationService;
  private readonly messages: MessageService;
  private readonly context: ConversationContextService;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly ai: AIService,
    historyLimit: number,
    private readonly maxProductIds: number,
    private readonly imageProducts?: ImageProductService,
    private readonly voice?: VoiceUnderstandingService,
    private readonly orderConversation?: OrderConversationService,
    private readonly handovers?: HumanHandoverService,
    private readonly maxConsecutiveFailures = 2,
  ) {
    this.customers = new CustomerService(prisma);
    this.conversations = new ConversationService(prisma);
    this.messages = new MessageService(prisma);
    this.context = new ConversationContextService(
      prisma,
      historyLimit,
      new ProductCatalogService(prisma),
    );
  }

  async send(input: ChatInput) {
    const customer = await this.customers.findOrCreateCustomer(input.customer);
    let conversation;

    if (input.newConversation) {
      const engaged = await this.conversations.getEngagedConversation(customer.id, input.channel);
      if (engaged?.status === 'HUMAN') {
        conversation = engaged;
      } else {
        if (engaged) await this.conversations.closeConversation(engaged.id);
        conversation = await this.conversations.createConversation({
          customerId: customer.id,
          channel: input.channel,
        });
      }
    } else if (input.conversationId) {
      const requested = await this.conversations.getConversation(input.conversationId);
      if (
        !requested ||
        requested.customerId !== customer.id ||
        !['ACTIVE', 'HUMAN'].includes(requested.status)
      ) {
        throw new ConversationAccessError('Conversation is unavailable for this customer');
      }
      conversation = requested;
    } else {
      conversation = await this.conversations.getOrCreateConversation({
        customerId: customer.id,
        channel: input.channel,
      });
    }

    const additionalText = input.message?.trim() || input.image?.caption?.trim() || '';
    const initialContent = additionalText || (input.audio ? '[Voice message]' : 'Which product is shown in this image?');

    if (conversation.status === 'HUMAN') {
      const message = await this.messages.addMessage({
        conversationId: conversation.id,
        customerId: customer.id,
        role: 'user',
        content: initialContent,
        messageType: input.audio ? 'audio' : input.image ? 'image' : 'text',
        externalMessageId: input.externalMessageId,
        ...(input.image || input.audio || input.sourceMetadata
          ? {
              metadata: {
                ...(input.sourceMetadata && typeof input.sourceMetadata === 'object' && !Array.isArray(input.sourceMetadata) ? input.sourceMetadata : {}),
                humanLock: true,
                ...(input.image
                  ? { image: { source: input.image.source ?? 'unknown', url: null } }
                  : {}),
                ...(input.audio
                  ? { audio: { source: input.audio.source ?? 'unknown', url: null } }
                  : {}),
              },
            }
          : {}),
      });
      return {
        conversationId: conversation.id,
        customerId: customer.id,
        conversationStatus: 'human' as const,
        reply: null,
        intent: 'human_request' as const,
        confidence: 1,
        requiresHuman: true,
        action: 'human_locked',
        productIds: [],
        products: [],
        source: 'rules' as const,
        messageSaved: true,
        messageId: message.id,
      };
    }
    const imageResult = input.image
      ? await this.imageProducts?.identify(input.image, initialContent)
      : undefined;
    if (input.image && !imageResult) throw new Error('Image processing is unavailable');
    const imageProductIds = imageResult?.selectedProduct
      ? [imageResult.selectedProduct.productId]
      : imageResult?.confidenceLevel === 'medium'
        ? imageResult.matches.map((match) => match.productId)
        : [];

    const preparedAudio = input.audio ? await this.voice?.prepare(input.audio) : undefined;
    if (input.audio && !preparedAudio) throw new Error('Audio processing is unavailable');
    const reusableTranscription = preparedAudio
      ? await this.findReusableTranscription(conversation.id, preparedAudio.sha256)
      : null;
    const baseMetadata = {
      ...(input.sourceMetadata && typeof input.sourceMetadata === 'object' && !Array.isArray(input.sourceMetadata) ? input.sourceMetadata : {}),
      ...(imageResult
        ? {
            image: imageResult.image,
            imageAnalysis: {
              status: imageResult.analysisStatus,
              confidence: imageResult.analysis?.confidence ?? 0,
              matchConfidence:
                imageResult.selectedProduct?.score ?? imageResult.matches[0]?.score ?? 0,
              matchedBy:
                imageResult.selectedProduct?.reasons ?? imageResult.matches[0]?.reasons ?? [],
            },
          }
        : {}),
      ...(preparedAudio
        ? {
            audio: {
              mimeType: preparedAudio.mimeType,
              duration: preparedAudio.duration,
              source: preparedAudio.source,
              fingerprint: preparedAudio.sha256,
              temporary: true,
            },
          }
        : {}),
      productIds: imageProductIds,
    };
    const userMessage = await this.messages.addMessage({
      conversationId: conversation.id,
      customerId: customer.id,
      role: 'user',
      content: initialContent,
      messageType: input.audio ? 'audio' : input.image ? 'image' : 'text',
      externalMessageId: input.externalMessageId,
      ...(input.audio || input.image || input.sourceMetadata ? { metadata: baseMetadata } : {}),
    });

    let transcription: Transcription | undefined;
    let voiceProductIds: number[] = [];
    let customerMessage = initialContent;
    let response: AIResponse | undefined;
    if (preparedAudio && this.voice) {
      try {
        transcription = reusableTranscription ?? (await this.voice.transcribe(preparedAudio));
      } catch {
        await this.messages.updateMessage(userMessage.id, {
          content: additionalText || '[Voice message could not be transcribed]',
          metadata: {
            ...baseMetadata,
            transcription: { status: 'failed' },
          },
        });
        response = voiceClarificationResponse('failed');
      }

      if (transcription) {
        const lowConfidence = this.voice.isLowConfidence(transcription);
        let normalizationFailed = false;
        let normalized = { normalizedText: transcription.text, verifiedCodes: [] as string[], productIds: [] as number[] };
        if (!lowConfidence) {
          try {
            normalized = await this.voice.normalizeProductCodes(transcription.text);
          } catch {
            normalizationFailed = true;
          }
        }
        voiceProductIds = normalized.productIds;
        customerMessage = combineVoiceAndText(normalized.normalizedText, additionalText);
        await this.messages.updateMessage(userMessage.id, {
          content: customerMessage,
          metadata: {
            ...baseMetadata,
            productIds: [...new Set([...imageProductIds, ...voiceProductIds])],
            verifiedProductCodes: normalized.verifiedCodes,
            transcription: {
              text: transcription.text,
              language: transcription.language,
              confidence: transcription.confidence,
              duration: transcription.duration,
            },
          },
        });
        if (lowConfidence) response = voiceClarificationResponse('low_confidence');
        else if (normalizationFailed) response = voiceClarificationResponse('processing_failed');
      }
    }

    if (!response) {
      const memory = await this.context.buildContext(conversation.id, {
        excludeMessageId: userMessage.id,
        maxProductIds: this.maxProductIds,
      });
      if (!memory) throw new Error('Conversation context could not be built');

      const contextProductIds = [
        ...new Set([...imageProductIds, ...voiceProductIds, ...memory.activeProductIds]),
      ].slice(0, this.maxProductIds);
      response = await this.orderConversation?.handle({
        message: customerMessage,
        conversationId: conversation.id,
        customer: {
          id: customer.id,
          name: customer.name,
          phone: customer.phone,
          address: (customer as typeof customer & { address?: string | null }).address,
        },
        productIds: contextProductIds,
      }) ?? undefined;

      if (!response) {
        const language = ['bn', 'banglish', 'en'].includes(customer.language ?? '')
          ? (customer.language as 'bn' | 'banglish' | 'en')
          : 'auto';
        response = await this.ai.respond({
          message: customerMessage,
          conversationId: conversation.id,
          customerId: customer.id,
          language,
          conversationHistory: memory.history,
          contextProductIds,
          customerContext: { name: customer.name, language: customer.language },
        });
      }
    }

    let handoverReason: HandoverReasonName | undefined;
    if (response.requiresHuman) {
      handoverReason = this.handoverReason(response);
      await (this.prisma as any).conversation.update({
        where: { id: conversation.id },
        data: { consecutiveAiFailures: 0 },
      });
    } else if (this.isFailureResponse(response)) {
      const failures = ((conversation as typeof conversation & { consecutiveAiFailures?: number })
        .consecutiveAiFailures ?? 0) + 1;
      await (this.prisma as any).conversation.update({
        where: { id: conversation.id },
        data: { consecutiveAiFailures: failures },
      });
      if (failures >= this.maxConsecutiveFailures) {
        response = {
          ...response,
          reply: 'ঠিক আছে ভাই, একজন টিম মেম্বার আপনার সাথে কথা বলবেন। একটু সময় দিন।',
          requiresHuman: true,
          action: 'request_human',
        };
        handoverReason = 'repeated_failure';
      }
    } else {
      await (this.prisma as any).conversation.update({
        where: { id: conversation.id },
        data: { consecutiveAiFailures: 0 },
      });
    }

    const assistantMessage = await this.messages.addMessage({
      conversationId: conversation.id,
      customerId: customer.id,
      role: 'assistant',
      content: response.reply,
      metadata: {
        intent: response.intent,
        confidence: response.confidence,
        requiresHuman: response.requiresHuman,
        action: response.action,
        ...(response.orderAction
          ? {
              orderAction: {
                type: response.orderAction.type,
                orderId: response.orderAction.orderId,
              },
            }
          : {}),
        productIds: response.productIds,
        products: response.products.map((product) => ({
          id: product.id,
          productCode: product.productCode,
        })),
        source: response.source,
      },
    });
    if (response.requiresHuman) {
      if (this.handovers && handoverReason) {
        await this.handovers.requestHandover({
          conversationId: conversation.id,
          reason: handoverReason,
          note: response.action ? `AI action: ${response.action}` : null,
          createdBy: 'ai',
        });
      } else {
        await this.conversations.markConversationHuman(conversation.id);
      }
    }

    return {
      conversationId: conversation.id,
      customerId: customer.id,
      conversationStatus: response.requiresHuman ? ('human' as const) : ('active' as const),
      assistantMessageId: assistantMessage.id,
      ...response,
      products: response.products.map((product) => {
        const match = imageResult?.matches.find((item) => item.productId === product.id);
        return match
          ? { ...product, matchConfidence: match.score, matchReasons: match.reasons }
          : product;
      }),
      ...(imageResult ? { imageRecognition: imageResult } : {}),
      ...(transcription ? { transcription } : {}),
    };
  }

  private isFailureResponse(response: AIResponse): boolean {
    return (
      response.intent === 'unknown' ||
      response.confidence < 0.45 ||
      response.source === 'fallback' ||
      ['request_product_clarification', 'request_voice_clarification'].includes(response.action ?? '')
    );
  }

  private handoverReason(response: AIResponse): HandoverReasonName {
    if (response.intent === 'human_request') return 'customer_requested_human';
    if (response.intent === 'order_intent') return 'order_problem';
    if (response.action === 'request_product_clarification') return 'unavailable_product';
    if (response.source === 'fallback' || response.confidence < 0.45) return 'ai_uncertain';
    return 'complex_question';
  }

  private async findReusableTranscription(
    conversationId: string,
    fingerprint: string,
  ): Promise<Transcription | null> {
    const recent = await this.messages.getRecentMessages(conversationId, 50);
    for (const message of [...recent].reverse()) {
      if (!message.metadata || typeof message.metadata !== 'object' || Array.isArray(message.metadata)) continue;
      const metadata = message.metadata as Record<string, unknown>;
      const audio = metadata.audio;
      if (!audio || typeof audio !== 'object' || Array.isArray(audio)) continue;
      if ((audio as Record<string, unknown>).fingerprint !== fingerprint) continue;
      const parsed = transcriptionSchema.safeParse(metadata.transcription);
      if (parsed.success) return parsed.data;
    }
    return null;
  }
}
