import type { PrismaClient } from '@alzeena/database';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { ChatService } from '../conversations/chat.service.js';
import { MessageService } from '../conversations/message.service.js';
import type { MessengerSender } from '../channels/messenger/messenger.sender.js';
import type { MessengerOutgoingService } from '../channels/messenger/messenger-outgoing.service.js';
import { ImageFetchError } from './image.service.js';
import { ImageValidationError } from './image-validation.service.js';
import type { ImageProductService } from './image-product.service.js';
import type { ImageAnalysisJobData } from './image-analysis.queue.js';

const SAFE_IMAGE_RESPONSES: Record<string, string> = {
  IMAGE_TOO_LARGE: 'ছবিটি বেশি বড় হয়েছে। একটু ছোট করে আবার পাঠাবেন?',
  UNSUPPORTED_IMAGE_TYPE: 'এই ছবির ফরম্যাটটি সাপোর্ট হচ্ছে না। JPG, PNG বা WebP হিসেবে পাঠাবেন?',
  INVALID_IMAGE: 'ছবিটি ঠিকমতো পড়া যায়নি। আরেকবার পরিষ্কার ছবি পাঠাবেন?',
  FAILED: 'ছবিটি এখন বিশ্লেষণ করা যাচ্ছে না। প্রোডাক্টের নাম বা কোড লিখে দিলে আমি দেখে দিচ্ছি।',
};

export class PermanentImageError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'PermanentImageError'; }
}

export class ImageAnalysisProcessor {
  private readonly db: any;
  private readonly messages: MessageService;
  constructor(
    prisma: PrismaClient,
    private readonly images: ImageProductService,
    private readonly chat: ChatService,
    private readonly sender: MessengerSender,
    private readonly redis: Redis,
    private readonly logger: Logger,
    private readonly retentionHours: number,
    private readonly outgoing?: MessengerOutgoingService,
  ) { this.db = prisma as any; this.messages = new MessageService(prisma); }

  async process(data: ImageAnalysisJobData, attempt: number, maxAttempts: number) {
    const lifecycle = await this.db.imageProcessing.findUnique({ where: { messageId: data.messageId }, include: { message: true } });
    if (!lifecycle || lifecycle.status === 'EXPIRED') return { duplicate: true };
    const [emergency, page] = await Promise.all([
      this.db.setting?.findUnique ? this.db.setting.findUnique({ where: { key: 'messenger.emergency_stop' } }) : null,
      this.db.messengerPage?.findUnique ? this.db.messengerPage.findUnique({ where: { pageId: lifecycle.message.metadata?.pageId } }) : null,
    ]);
    if (emergency?.value === 'true' || page?.aiEnabled === false) {
      await this.db.messengerEventLog.update({ where: { id: data.eventLogId }, data: { status: 'IGNORED', processedAt: new Date(), processingCompletedAt: new Date(), errorType: emergency?.value === 'true' ? 'EMERGENCY_STOP' : 'AI_DISABLED' } });
      return { ignored: true };
    }
    if (lifecycle.aiProcessedAt && !data.reanalyzeOnly) {
      const log = await this.db.messengerEventLog.findUnique({ where: { id: data.eventLogId } });
      return log?.localOutboundMessageId && log.status !== 'PROCESSED' ? this.retryDelivery(log, data.senderId) : { duplicate: true };
    }
    if (['FAILED', 'UNSUPPORTED'].includes(lifecycle.status) && !data.reanalyzeOnly) {
      const log = await this.db.messengerEventLog.findUnique({ where: { id: data.eventLogId } });
      return log?.localOutboundMessageId ? this.retryDelivery(log, data.senderId) : { duplicate: true };
    }
    if (lifecycle.status === 'COMPLETED' && !data.reanalyzeOnly) return this.processWithAI(data, lifecycle);
    if (!lifecycle.providerUrl) throw new PermanentImageError('IMAGE_EXPIRED');
    const started = Date.now();
    await this.db.imageProcessing.update({ where: { messageId: data.messageId }, data: {
      status: 'PROCESSING', processingStartedAt: new Date(), attemptCount: { increment: 1 }, errorCode: null,
    } });
    this.logger.info({ messageId: data.messageId, attempt }, 'Image analysis started');
    try {
      const caption = lifecycle.message.content === '[Product image]' ? '' : lifecycle.message.content;
      const matchingStarted = Date.now();
      const result = await this.images.identify({
        type: 'image', url: lifecycle.providerUrl, source: 'messenger',
        ...(lifecycle.sourceMimeType ? { mimeType: lifecycle.sourceMimeType } : {}), caption,
      }, caption, true);
      const totalAnalysisMs = Date.now() - matchingStarted;
      const retainedUntil = this.retentionHours > 0 ? new Date(Date.now() + this.retentionHours * 3_600_000) : null;
      const candidates = result.matches.map((match) => ({
        productId: match.productId, productCode: match.product.productCode, productName: match.product.productName,
        score: match.score, reasons: match.reasons,
        currentPrice: match.product.flashSellPrice && Number(match.product.flashSellPrice) > 0 ? match.product.flashSellPrice : match.product.discountPrice && Number(match.product.discountPrice) > 0 ? match.product.discountPrice : match.product.sellPrice,
        sizes: match.availability.sizes.map((size) => ({ size: size.sizeName, stock: size.stock, orderable: size.orderable })),
      }));
      const metadata = this.mergeMetadata(lifecycle.message.metadata, {
        inputType: 'image', productIds: candidates.map((candidate) => candidate.productId),
        image: {
          source: 'messenger', status: 'COMPLETED', mimeType: result.image.mimeType,
          fileSize: result.image.sizeBytes, width: result.image.width, height: result.image.height,
          fingerprint: result.image.fingerprint,
          ...(retainedUntil ? { url: lifecycle.providerUrl, retainedUntil: retainedUntil.toISOString() } : { url: null }),
        },
        imageAnalysis: {
          status: 'COMPLETED', analysisStatus: result.analysisStatus, description: result.analysis?.description ?? null,
          ocr: result.analysis?.ocr ?? null, detectedProductCode: result.analysis?.productCode ?? null,
          visualAttributes: result.analysis?.visualAttributes ?? [], sizeChart: result.analysis?.sizeChart ?? [],
          detectedProducts: result.analysis?.detectedProducts ?? [], candidates,
          selectedProductId: result.selectedProduct?.productId ?? null,
          confidenceLevel: result.confidenceLevel.toUpperCase(), provider: result.vision?.provider ?? null,
          model: result.vision?.model ?? null, visionDurationMs: result.vision?.durationMs ?? null,
          totalAnalysisMs,
        },
      });
      await this.db.$transaction([
        this.db.imageProcessing.update({ where: { messageId: data.messageId }, data: {
          status: 'COMPLETED', detectedMimeType: result.image.mimeType, fileSizeBytes: result.image.sizeBytes,
          width: result.image.width, height: result.image.height, imageHash: result.image.fingerprint,
          analysisStatus: result.analysisStatus, analysisResult: result.analysis, candidates,
          confidenceLevel: result.confidenceLevel.toUpperCase(), selectedProductId: result.selectedProduct?.productId ?? null,
          provider: result.vision?.provider ?? null, model: result.vision?.model ?? null,
          visionDurationMs: result.vision?.durationMs ?? null,
          matchingDurationMs: Math.max(0, totalAnalysisMs - (result.vision?.durationMs ?? 0)),
          totalDurationMs: Date.now() - started, analyzedAt: new Date(), retainedUntil,
          ...(!retainedUntil ? { providerUrl: null } : {}),
        } }),
        this.db.message.update({ where: { id: data.messageId }, data: { metadata } }),
        ...(result.selectedProduct ? [this.db.imageMatchFeedback.create({ data: {
          messageId: data.messageId, type: 'AI_MATCH', aiProductId: result.selectedProduct.productId,
          actor: 'image-worker', metadata: { confidenceLevel: result.confidenceLevel, score: result.selectedProduct.score },
        } })] : []),
      ]);
      this.logger.info({ messageId: data.messageId, imageHash: result.image.fingerprint, confidenceLevel: result.confidenceLevel, candidateCount: candidates.length }, 'Image analysis completed');
      if (data.reanalyzeOnly) return { analyzed: true };
      return this.processWithAI(data, { ...lifecycle, status: 'COMPLETED', message: { ...lifecycle.message, metadata }, result });
    } catch (error) {
      const permanent = error instanceof ImageValidationError ? error.code : null;
      if (data.reanalyzeOnly && (permanent || attempt >= maxAttempts)) {
        await this.db.imageProcessing.update({ where: { messageId: data.messageId }, data: { status: lifecycle.analysisResult ? 'COMPLETED' : 'FAILED', errorCode: permanent ?? 'ADMIN_REANALYZE_FAILED' } });
        if (permanent) throw new PermanentImageError(permanent);
        return { failed: true };
      }
      if (permanent) { await this.finalizeFailure(data, lifecycle, permanent, true); throw new PermanentImageError(permanent); }
      if (attempt >= maxAttempts) { await this.finalizeFailure(data, lifecycle, 'FAILED', false); return { failed: true }; }
      await this.db.imageProcessing.update({ where: { messageId: data.messageId }, data: { status: 'PENDING', errorCode: 'TEMPORARY_VISION_FAILURE' } });
      this.logger.warn({ messageId: data.messageId, attempt, errorType: error instanceof Error ? error.name : 'unknown' }, 'Temporary image analysis failure');
      throw error instanceof Error ? error : new ImageFetchError('Image processing failed');
    }
  }

  async expireRetainedImages() {
    const expired = await this.db.imageProcessing.findMany({ where: { retainedUntil: { lte: new Date() }, providerUrl: { not: null } }, include: { message: true } });
    for (const record of expired) {
      const image = this.objectPart(record.message.metadata, 'image');
      await this.db.$transaction([
        this.db.imageProcessing.update({ where: { messageId: record.messageId }, data: { status: 'EXPIRED', providerUrl: null, retainedUntil: null } }),
        this.db.message.update({ where: { id: record.messageId }, data: { metadata: this.mergeMetadata(record.message.metadata, { image: { ...image, status: 'EXPIRED', url: null, retainedUntil: null } }) } }),
      ]);
    }
    return expired.length;
  }

  private async processWithAI(data: ImageAnalysisJobData, lifecycle: any) {
    const log = await this.db.messengerEventLog.findUnique({ where: { id: data.eventLogId } });
    if (log?.localOutboundMessageId && log.status === 'PROCESSED') return { duplicate: true };
    if (log?.localOutboundMessageId) return this.retryDelivery(log, data.senderId);
    const lockKey = `conversation:processing:messenger:${lifecycle.message.metadata?.pageId ?? 'unknown'}:${data.senderId}`; const token = `${data.eventLogId}:${Date.now()}`;
    const locked = await this.redis.set(lockKey, token, 'PX', 90_000, 'NX');
    if (!locked) throw new Error('Conversation is already processing another input');
    try {
      const fresh = lifecycle.result ?? await this.resultFromLifecycle(lifecycle);
      const caption = lifecycle.message.content === '[Product image]' ? '' : lifecycle.message.content;
      const aiStarted = Date.now();
      const result = await this.chat.send({
        customer: { platform: 'messenger', platformPageId: lifecycle.message.metadata?.pageId, platformUserId: data.senderId }, channel: 'messenger',
        conversationId: lifecycle.message.conversationId, existingMessageId: lifecycle.messageId,
        message: caption || 'এই ছবির প্রোডাক্ট সম্পর্কে তথ্য দিন', imageRecognition: fresh,
        sourceMetadata: { inputType: 'image', imageProcessingId: lifecycle.id, correlationId: log?.correlationId ?? data.eventLogId, requestId: log?.correlationId ?? data.requestId ?? data.eventLogId },
      });
      const aiDurationMs = Date.now() - aiStarted;
      if (!result.reply || !('assistantMessageId' in result) || !result.assistantMessageId) {
        await this.db.imageProcessing.update({ where: { messageId: lifecycle.messageId }, data: { aiProcessedAt: new Date(), aiDurationMs, totalDurationMs: (lifecycle.totalDurationMs ?? 0) + aiDurationMs } });
        await this.completeEvent(data.eventLogId); return { delivered: false, humanLocked: true };
      }
      const outboundId = String(result.assistantMessageId);
      await this.db.messengerEventLog.update({ where: { id: data.eventLogId }, data: { localOutboundMessageId: outboundId } });
      await this.db.imageProcessing.update({ where: { messageId: lifecycle.messageId }, data: { aiProcessedAt: new Date(), aiDurationMs, totalDurationMs: (lifecycle.totalDurationMs ?? 0) + aiDurationMs } });
      const outbound = await this.db.message.findUnique({ where: { id: outboundId } });
      await this.db.message.update({ where: { id: outboundId }, data: { metadata: this.mergeMetadata(outbound?.metadata, {
        imageDebug: {
          inputType: 'image', previewAvailable: Boolean(lifecycle.providerUrl),
          visionDescription: fresh.analysis?.description ?? null, ocr: fresh.analysis?.ocr ?? null,
          detectedProductCode: fresh.analysis?.productCode ?? null,
          attributes: fresh.analysis?.visualAttributes ?? [], candidates: fresh.matches.map((match: any) => ({ productId: match.productId, productCode: match.product.productCode, name: match.product.productName, score: match.score })),
          selectedProductId: fresh.selectedProduct?.productId ?? null, confidenceLevel: fresh.confidenceLevel.toUpperCase(),
          provider: fresh.vision?.provider ?? lifecycle.provider, model: fresh.vision?.model ?? lifecycle.model,
          visionDurationMs: fresh.vision?.durationMs ?? lifecycle.visionDurationMs, aiDurationMs,
          totalDurationMs: (lifecycle.totalDurationMs ?? 0) + aiDurationMs,
        },
      }) } });
      return this.deliver(data.eventLogId, outboundId, data.senderId, result.reply);
    } finally {
      await this.redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, lockKey, token).catch(() => undefined);
    }
  }

  private async resultFromLifecycle(lifecycle: any): Promise<any> {
    const candidates = Array.isArray(lifecycle.candidates) ? lifecycle.candidates : [];
    const ids = candidates.map((candidate: any) => candidate.productId).filter(Number.isInteger);
    const products = ids.length ? await this.db.product.findMany({ where: { websiteProductId: { in: ids }, presentInFeed: true }, include: { variations: true } }) : [];
    const byId = new Map(products.map((product: any) => [product.websiteProductId, product]));
    const matches = candidates.flatMap((candidate: any) => {
      const product: any = byId.get(candidate.productId); if (!product) return [];
      const mapped = { id: product.websiteProductId, internalId: product.id, productName: product.productName, productCode: product.productCode, slug: product.slug, productDetails: product.productDetails, productStatus: product.productStatus, active: product.productStatus === '1', sellPrice: String(product.sellPrice), discountPrice: product.discountPrice == null ? null : String(product.discountPrice), flashSellPrice: product.flashSellPrice == null ? null : String(product.flashSellPrice), isPreOrder: product.isPreOrder, image: product.productImage, color: product.colorName, category: product.categoryName, subCategory: product.subCategoryName, variations: product.variations.map((v: any) => ({ websiteVariationId: v.websiteVariationId, websiteSizeId: v.websiteSizeId, sizeName: v.sizeName, stockQuantity: v.stockQuantity, active: v.active })) };
      return [{ productId: candidate.productId, score: candidate.score, reasons: candidate.reasons, product: mapped, availability: { id: mapped.id, productName: mapped.productName, productCode: mapped.productCode, productStatus: mapped.productStatus, active: mapped.active, presentInFeed: true, isPreOrder: mapped.isPreOrder, sizes: mapped.variations.map((v: any) => ({ websiteVariationId: v.websiteVariationId, websiteSizeId: v.websiteSizeId, sizeName: v.sizeName, stock: v.stockQuantity, active: v.active, orderable: mapped.active && v.active && (v.stockQuantity > 0 || mapped.isPreOrder), availabilityType: v.stockQuantity > 0 ? 'in_stock' : mapped.isPreOrder ? 'pre_order' : 'unavailable' })) } }];
    });
    return { image: { mimeType: lifecycle.detectedMimeType, sizeBytes: lifecycle.fileSizeBytes, width: lifecycle.width, height: lifecycle.height, source: 'messenger', fingerprint: lifecycle.imageHash, temporary: true }, analysis: lifecycle.analysisResult, analysisStatus: lifecycle.analysisStatus, matches, selectedProduct: matches.find((m: any) => m.productId === lifecycle.selectedProductId) ?? null, confidenceLevel: (lifecycle.confidenceLevel ?? 'LOW').toLowerCase(), detectedProducts: [], vision: lifecycle.provider ? { provider: lifecycle.provider, model: lifecycle.model, durationMs: lifecycle.visionDurationMs } : null };
  }

  private async finalizeFailure(data: ImageAnalysisJobData, lifecycle: any, code: string, unsupported: boolean) {
    const status = unsupported ? 'UNSUPPORTED' : 'FAILED';
    await this.db.$transaction([
      this.db.imageProcessing.update({ where: { messageId: data.messageId }, data: { status, errorCode: code, providerUrl: null } }),
      this.db.message.update({ where: { id: data.messageId }, data: { metadata: this.mergeMetadata(lifecycle.message.metadata, { image: { source: 'messenger', status, url: null }, imageAnalysis: { status, errorCode: code } }) } }),
    ]);
    const assistant = await this.messages.addMessage({ conversationId: lifecycle.message.conversationId, customerId: lifecycle.message.customerId, role: 'assistant', content: SAFE_IMAGE_RESPONSES[code] ?? SAFE_IMAGE_RESPONSES.FAILED!, metadata: { inputType: 'image', imageFailure: code, platform: 'messenger', direction: 'outbound' } });
    await this.db.messengerEventLog.update({ where: { id: data.eventLogId }, data: { localOutboundMessageId: assistant.id } });
    await this.deliver(data.eventLogId, assistant.id, data.senderId, assistant.content);
  }

  private async deliver(eventLogId: string, messageId: string, senderId: string, text: string) {
    const message = await this.db.message.findUnique({ where: { id: messageId } });
    const eventLog = await this.db.messengerEventLog.findUnique({ where: { id: eventLogId } });
    if (this.outgoing && message && eventLog) {
      await this.outgoing.enqueue({ messageId, conversationId: message.conversationId, eventLogId, pageId: eventLog.pageId, recipientId: senderId, correlationId: eventLog.correlationId ?? eventLogId });
      await this.db.message.update({ where: { id: messageId }, data: { metadata: this.mergeMetadata(message.metadata, { platform: 'messenger', direction: 'outbound', delivery: { status: 'queued', provider: 'facebook-messenger', correlationId: eventLog.correlationId ?? eventLogId } }) } });
      return { queued: true };
    }
    const result = await this.sender.sendText(senderId, text);
    await this.db.message.update({ where: { id: messageId }, data: {
      metadata: this.mergeMetadata(message?.metadata, { platform: 'messenger', direction: 'outbound', delivery: { status: result.success ? 'sent' : 'failed', provider: 'facebook-messenger', errorCode: result.errorCode } }),
      ...(result.externalMessageId ? { externalMessageId: result.externalMessageId } : {}),
    } });
    await this.db.messengerEventLog.update({ where: { id: eventLogId }, data: result.success ? { status: 'PROCESSED', processedAt: new Date(), errorMessage: null } : { status: result.retryable ? 'DELIVERY_FAILED' : 'FAILED', processedAt: result.retryable ? null : new Date(), errorMessage: (result.errorMessage ?? result.errorCode ?? 'Delivery failed').slice(0, 500) } });
    if (!result.success && result.retryable) throw new Error('Temporary Messenger delivery failure');
    return { delivered: result.success };
  }
  private async retryDelivery(log: any, senderId: string) {
    const fresh = await this.db.messengerEventLog.findUnique({ where: { id: log.id } }); if (fresh?.status === 'PROCESSED') return { duplicate: true };
    const outbound = await this.db.message.findUnique({ where: { id: log.localOutboundMessageId } }); if (!outbound) throw new PermanentImageError('OUTBOUND_MISSING');
    return this.deliver(log.id, outbound.id, senderId, outbound.content);
  }
  private completeEvent(id: string) { return this.db.messengerEventLog.update({ where: { id }, data: { status: 'PROCESSED', processedAt: new Date(), errorMessage: null } }); }
  private mergeMetadata(existing: unknown, added: Record<string, unknown>) { const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing as Record<string, unknown> : {}; return { ...base, ...added }; }
  private objectPart(metadata: unknown, key: string) { const base = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata as Record<string, unknown> : {}; const value = base[key]; return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
}
