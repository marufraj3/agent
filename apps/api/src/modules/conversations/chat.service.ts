import type { PrismaClient } from '@alzeena/database';
import type { AIService } from '../ai/ai.service.js';
import type { AIResponse } from '../ai/ai.types.js';
import { extractEntities } from '../ai/entity-extractor.js';
import { transcriptionSchema, type AudioInput, type Transcription } from '../audio/audio.types.js';
import type { VoiceUnderstandingService } from '../audio/voice-understanding.service.js';
import type { ImageProductService } from '../images/image-product.service.js';
import type { ImageInput } from '../images/image.types.js';
import type { HandoverTool } from '../ai/sales-tool.interfaces.js';
import type { CustomerJourneyService } from '../automation/customer-journey.service.js';
import type { FollowUpService } from '../automation/follow-up.service.js';
import { parseFollowUpTime } from '../automation/follow-up-time.js';
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
  /** Server-internal transcript produced by the dedicated audio worker. */
  audioTranscription?: Transcription;
  /** Server-internal persisted inbound message to process without creating a duplicate. */
  existingMessageId?: string;
  channel: ConversationChannelName;
  conversationId?: string;
  newConversation?: boolean;
  externalMessageId?: string;
  sourceMetadata?: import('./conversation.types.js').JsonMetadata;
  /** Trusted admin-only diagnostic response; customer channels must leave this false. */
  includeDebug?: boolean;
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
    language: 'bn',
    entities: {
      productCode: null, productName: null, size: null, color: null, quantity: null,
      minPrice: null, maxPrice: null, customerName: null, phone: null, address: null,
      deliveryLocation: null, ordinalReference: null, correction: false, requestedFollowUp: false,
    },
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
    private readonly handovers?: HandoverTool,
    private readonly maxConsecutiveFailures = 2,
    private readonly lowConfidenceThreshold = 0.45,
    private readonly journey?: CustomerJourneyService,
    private readonly followUps?: FollowUpService,
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
      const persisted = input.existingMessageId
        ? await this.messages.getMessage(input.existingMessageId)
        : null;
      if (input.existingMessageId && (!persisted || persisted.conversationId !== conversation.id || persisted.customerId !== customer.id)) {
        throw new ConversationAccessError('Persisted message is unavailable for this customer');
      }
      const message = persisted ?? await this.messages.addMessage({
        conversationId: conversation.id,
        customerId: customer.id,
        role: 'user',
        content: initialContent,
        messageType: input.audio || input.audioTranscription ? 'audio' : input.image ? 'image' : 'text',
        externalMessageId: input.externalMessageId,
        ...(input.image || input.audio || input.audioTranscription || input.sourceMetadata
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
    const persistedMessage = input.existingMessageId
      ? await this.messages.getMessage(input.existingMessageId)
      : null;
    if (input.existingMessageId && (
      !persistedMessage || persistedMessage.conversationId !== conversation.id ||
      persistedMessage.customerId !== customer.id || persistedMessage.role !== 'USER'
    )) throw new ConversationAccessError('Persisted message is unavailable for this customer');
    const persistedMetadata = persistedMessage?.metadata && typeof persistedMessage.metadata === 'object' && !Array.isArray(persistedMessage.metadata)
      ? persistedMessage.metadata as Record<string, unknown>
      : {};
    const userMessage = persistedMessage ?? await this.messages.addMessage({
      conversationId: conversation.id,
      customerId: customer.id,
      role: 'user',
      content: initialContent,
      messageType: input.audio || input.audioTranscription ? 'audio' : input.image ? 'image' : 'text',
      externalMessageId: input.externalMessageId,
      ...(input.audio || input.audioTranscription || input.image || input.sourceMetadata ? { metadata: baseMetadata } : {}),
    });
    await this.followUps?.cancelPending(conversation.id, 'customer_replied');
    const optOut = /(?:আর\s*(?:message|মেসেজ)\s*(?:দিয়েন|দিবেন)\s*না|follow-?up\s*(?:লাগবে না|বন্ধ)|stop\s*(?:messages?|follow-?ups?))/iu.test(initialContent);
    if (optOut) await (this.prisma as any).customer.update({ where: { id: customer.id }, data: { automationOptOut: true } });
    else if (/(?:follow-?up|মেসেজ).*(?:আবার|চালু|resume|start)/iu.test(initialContent)) await (this.prisma as any).customer.update({ where: { id: customer.id }, data: { automationOptOut: false } });
    try {
      const currentState = (customer as typeof customer & { journeyState?: string }).journeyState ?? 'NEW';
      if (currentState === 'NEW') await this.journey?.transition(customer.id, 'ENGAGED', 'MESSAGE_RECEIVED', { summary: 'Customer sent a message', conversationId: conversation.id });
      else await this.journey?.record(customer.id, 'MESSAGE_RECEIVED', { summary: 'Customer sent a message', conversationId: conversation.id });
    } catch { /* Journey logging must not interrupt customer messaging. */ }

    let transcription: Transcription | undefined = input.audioTranscription;
    let voiceProductIds: number[] = [];
    let customerMessage = initialContent;
    let response: AIResponse | undefined;
    if ((preparedAudio || transcription) && this.voice) {
      try {
        if (!transcription && preparedAudio) {
          transcription = reusableTranscription ?? (await this.voice.transcribe(preparedAudio));
        }
      } catch {
        await this.messages.updateMessage(userMessage.id, {
          content: additionalText || '[Voice message could not be transcribed]',
          metadata: {
            ...persistedMetadata,
            ...baseMetadata,
            transcription: { status: 'FAILED' },
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
            ...persistedMetadata,
            ...baseMetadata,
            productIds: [...new Set([...imageProductIds, ...voiceProductIds])],
            verifiedProductCodes: normalized.verifiedCodes,
            transcription: {
              status: 'COMPLETED',
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

    if (/\b(?:my|preferred|আমার|পছন্দ)\b/iu.test(customerMessage)) {
      const preference = extractEntities(customerMessage);
      await (this.prisma as any).customer.update({ where: { id: customer.id }, data: { ...(preference.size ? { preferredSize: preference.size } : {}), ...(preference.color ? { preferredColor: preference.color } : {}) } });
    }

    if (!response && this.followUps) {
      const requested = parseFollowUpTime(customerMessage);
      if (requested.kind === 'ambiguous') {
        response = { reply: requested.question, intent: 'follow_up_request', confidence: 1, language: 'bn', entities: { ...extractEntities(customerMessage), requestedFollowUp: true }, requiresHuman: false, action: 'clarify', productIds: [], products: [], source: 'rules' };
      } else if (requested.kind === 'scheduled') {
        try {
          const followUp = await this.followUps.schedule({ customerId: customer.id, conversationId: conversation.id, type: 'CUSTOMER_REQUESTED_FOLLOWUP', scheduledAt: requested.at, message: 'আপনি পরে যোগাযোগ করতে বলেছিলেন। এখন কি প্রোডাক্ট বা অর্ডারে সাহায্য করতে পারি?', createdBy: 'customer' });
          const notEligible = ['NOT_ELIGIBLE','BLOCKED'].includes((followUp as any).status);
          response = { reply: notEligible ? 'এই সময়ে Messenger policy অনুযায়ী automatic reminder পাঠানো যাবে না। একজন admin প্রয়োজন হলে সাহায্য করতে পারবেন।' : `ঠিক আছে, ${requested.at.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' })}-এ মনে করিয়ে দেব।`, intent: 'follow_up_request', confidence: 1, language: 'bn', entities: { ...extractEntities(customerMessage), requestedFollowUp: true }, requiresHuman: false, action: notEligible ? 'reply' : 'schedule_followup', productIds: [], products: [], source: 'rules' };
        } catch { response = { reply: 'দুঃখিত, এখন follow-up schedule করা যাচ্ছে না। চাইলে একটি নির্দিষ্ট সময় আবার বলুন।', intent: 'follow_up_request', confidence: 0.7, language: 'bn', entities: { ...extractEntities(customerMessage), requestedFollowUp: true }, requiresHuman: false, action: 'clarify', productIds: [], products: [], source: 'fallback' }; }
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

      if (response?.orderAction) response = { ...response, entities: extractEntities(customerMessage) };

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
          conversationSummary: memory.conversation.summary,
          salesState: memory.conversation.salesState,
          customerContext: { name: customer.name, language: customer.language, preferredSize: (customer as any).preferredSize, preferredCategory: (customer as any).preferredCategory, preferredColor: (customer as any).preferredColor },
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
        language: response.language,
        entities: response.entities,
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
        ...(response.debug ? { aiDebug: response.debug } : {}),
      },
    });
    await this.persistSalesState(conversation.id, response, (conversation as typeof conversation & { conversationSummary?: unknown }).conversationSummary);
    try {
      if (!response.requiresHuman) {
      if (response.orderAction?.type === 'confirm_order') {
        await this.journey?.transition(customer.id, 'ORDER_CONFIRMED', 'ORDER_CONFIRMED', { summary: 'Customer confirmed order', conversationId: conversation.id, orderId: response.orderAction.orderId });
        await this.journey?.transition(customer.id, 'ORDER_SUBMITTED', 'ORDER_SUBMITTED', { summary: 'Order submitted to website', conversationId: conversation.id, orderId: response.orderAction.orderId });
      }
      else if (response.orderAction?.type === 'request_order_information') {
        await this.journey?.transition(customer.id, 'AWAITING_CONFIRMATION', 'ORDER_CONFIRMATION_REQUESTED', { summary: 'Order confirmation requested', conversationId: conversation.id, orderId: response.orderAction.orderId });
        await this.followUps?.scheduleConfirmationReminder({ customerId: customer.id, conversationId: conversation.id, orderId: response.orderAction.orderId });
      } else if (response.orderAction) {
        if (response.orderAction.type === 'create_order') {
          await this.journey?.record(customer.id, 'PRODUCT_SELECTED', { summary: response.entities.size ? `Selected ${response.entities.size} size` : 'Selected a product for order', conversationId: conversation.id, orderId: response.orderAction.orderId });
          await this.journey?.transition(customer.id, 'ORDER_STARTED', 'ORDER_STARTED', { summary: 'Customer started an order', conversationId: conversation.id, orderId: response.orderAction.orderId });
        }
        await this.journey?.transition(customer.id, 'AWAITING_CUSTOMER_INFO', response.orderAction.type === 'create_order' ? 'ORDER_DRAFT_CREATED' : 'CUSTOMER_INFO_PROVIDED', { summary: response.orderAction.type === 'create_order' ? 'Order draft created' : response.entities.size ? `Selected ${response.entities.size} size` : 'Order information updated', conversationId: conversation.id, orderId: response.orderAction.orderId });
      }
      else if (response.productIds.length) {
        await this.journey?.record(customer.id, 'PRODUCT_VIEWED', { summary: `Asked about ${response.products[0]?.productCode ?? 'a product'}`, conversationId: conversation.id, metadata: { productIds: response.productIds } });
        await this.journey?.transition(customer.id, 'PRODUCT_INTEREST', 'PRODUCT_INTEREST', { summary: `Interested in ${response.products[0]?.productCode ?? 'a product'}`, conversationId: conversation.id, metadata: { productIds: response.productIds } });
      }
      }
    } catch { /* Automation state must not interrupt the customer response. */ }
    if (response.requiresHuman) {
      await this.followUps?.cancelPending(conversation.id, 'human_handover');
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

    const { debug: _internalDebug, ...customerResponse } = response;
    return {
      conversationId: conversation.id,
      customerId: customer.id,
      conversationStatus: response.requiresHuman ? ('human' as const) : ('active' as const),
      assistantMessageId: assistantMessage.id,
      ...customerResponse,
      ...(input.includeDebug && _internalDebug ? { debug: _internalDebug } : {}),
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

  private async persistSalesState(conversationId: string, response: AIResponse, existing: unknown): Promise<void> {
    const salesState = response.requiresHuman
      ? 'HUMAN_HANDOVER'
      : response.orderAction?.type === 'confirm_order'
        ? 'ORDER_SUBMITTED'
        : response.orderAction?.type === 'request_order_information'
          ? 'CONFIRMATION'
          : response.intent === 'order_intent'
            ? 'ORDER_COLLECTION'
            : response.intent === 'product_search' || response.intent === 'product_inquiry'
              ? 'CONSIDERATION'
              : 'DISCOVERY';
    const previous = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing as Record<string, unknown> : {};
    const previousPreferences = previous.preferences && typeof previous.preferences === 'object' ? previous.preferences as Record<string, unknown> : {};
    const previousKnown = previous.customerFieldsKnown && typeof previous.customerFieldsKnown === 'object' ? previous.customerFieldsKnown as Record<string, unknown> : {};
    const summary = {
      version: 1,
      lastIntent: response.intent,
      language: response.language,
      productIds: response.productIds.slice(0, this.maxProductIds),
      preferences: {
        size: response.entities.size ?? previousPreferences.size ?? null,
        color: response.entities.color ?? previousPreferences.color ?? null,
        quantity: response.entities.quantity ?? previousPreferences.quantity ?? null,
        minPrice: response.entities.minPrice ?? previousPreferences.minPrice ?? null,
        maxPrice: response.entities.maxPrice ?? previousPreferences.maxPrice ?? null,
        deliveryLocation: response.entities.deliveryLocation ?? previousPreferences.deliveryLocation ?? null,
      },
      customerFieldsKnown: {
        name: Boolean(response.entities.customerName) || previousKnown.name === true,
        phone: Boolean(response.entities.phone) || previousKnown.phone === true,
        address: Boolean(response.entities.address) || previousKnown.address === true,
      },
      order: response.orderAction ? { id: response.orderAction.orderId, lastAction: response.orderAction.type } : previous.order ?? null,
    };
    await (this.prisma as any).conversation.update({
      where: { id: conversationId },
      data: { salesState, conversationSummary: summary, summaryUpdatedAt: new Date() },
    });
  }

  private isFailureResponse(response: AIResponse): boolean {
    return (
      response.intent === 'unknown' ||
      response.confidence < this.lowConfidenceThreshold ||
      response.source === 'fallback' ||
      ['request_product_clarification', 'request_voice_clarification'].includes(response.action ?? '')
    );
  }

  private handoverReason(response: AIResponse): HandoverReasonName {
    if (response.intent === 'human_request') return 'customer_requested_human';
    if (response.intent === 'order_intent') return 'order_problem';
    if (response.action === 'request_product_clarification') return 'unavailable_product';
    if (response.source === 'fallback' || response.confidence < this.lowConfidenceThreshold) return 'ai_uncertain';
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
