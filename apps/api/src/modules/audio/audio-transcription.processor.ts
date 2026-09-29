import type { PrismaClient } from '@alzeena/database';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { ChatService } from '../conversations/chat.service.js';
import { MessageService } from '../conversations/message.service.js';
import type { MessengerSender } from '../channels/messenger/messenger.sender.js';
import type { MessengerOutgoingService } from '../channels/messenger/messenger-outgoing.service.js';
import { HumanHandoverService } from '../handovers/human-handover.service.js';
import { AudioFetchError } from './audio.service.js';
import { AudioValidationError } from './audio-validation.service.js';
import { SpeechToTextDurationError } from './speech-to-text.service.js';
import type { VoiceUnderstandingService } from './voice-understanding.service.js';
import type { AudioBatchJobData, AudioTranscriptionJobData, AudioTranscriptionQueue } from './audio-transcription.queue.js';
import { enqueueAudioBatch } from './audio-transcription.queue.js';

const SAFE_AUDIO_RESPONSES: Record<string, string> = {
  AUDIO_TOO_LONG: 'ভয়েসটি একটু বেশি লম্বা হয়েছে। ছোট করে আবার পাঠাবেন, অথবা কথাটি লিখে দিন।',
  AUDIO_TOO_LARGE: 'ভয়েস ফাইলটি বেশি বড় হয়েছে। ছোট করে আবার পাঠাবেন, অথবা কথাটি লিখে দিন।',
  UNSUPPORTED_AUDIO_TYPE: 'এই অডিও ফরম্যাটটি বুঝতে পারছি না। Messenger voice note হিসেবে আবার পাঠাবেন, অথবা লিখে দিন।',
  INVALID_AUDIO: 'ভয়েসটি ঠিকমতো পড়া যায়নি। আরেকবার পাঠাবেন, অথবা কথাটি লিখে দিন।',
  FAILED: 'ভয়েসটি এখন বুঝতে পারিনি। আরেকবার পরিষ্কার করে পাঠাবেন, অথবা কথাটি লিখে দিন।',
};

export class PermanentAudioError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'PermanentAudioError'; }
}

export class AudioTranscriptionProcessor {
  private readonly db: any;
  private readonly messages: MessageService;
  private readonly handovers: HumanHandoverService;

  constructor(
    prisma: PrismaClient,
    private readonly voice: VoiceUnderstandingService,
    private readonly chat: ChatService,
    private readonly sender: MessengerSender,
    private readonly queue: AudioTranscriptionQueue,
    private readonly redis: Redis,
    private readonly logger: Logger,
    private readonly provider: string,
    private readonly model: string,
    private readonly retentionHours: number,
    private readonly debounceMs: number,
    private readonly outgoing?: MessengerOutgoingService,
  ) {
    this.db = prisma as any;
    this.messages = new MessageService(prisma);
    this.handovers = new HumanHandoverService(prisma);
  }

  async transcribe(data: AudioTranscriptionJobData, attempt: number, maxAttempts: number) {
    const lifecycle = await this.db.audioTranscription.findUnique({
      where: { messageId: data.messageId }, include: { message: true },
    });
    if (!lifecycle || lifecycle.status === 'EXPIRED' || (lifecycle.aiProcessedAt && !data.retranscribeOnly)) return { duplicate: true };
    const [emergency, page] = await Promise.all([
      this.db.setting?.findUnique ? this.db.setting.findUnique({ where: { key: 'messenger.emergency_stop' } }) : null,
      this.db.messengerPage?.findUnique ? this.db.messengerPage.findUnique({ where: { pageId: lifecycle.message.metadata?.pageId } }) : null,
    ]);
    if (emergency?.value === 'true' || page?.aiEnabled === false) {
      await this.db.messengerEventLog.update({ where: { id: data.eventLogId }, data: { status: 'IGNORED', processedAt: new Date(), processingCompletedAt: new Date(), errorType: emergency?.value === 'true' ? 'EMERGENCY_STOP' : 'AI_DISABLED' } });
      return { ignored: true };
    }
    if (['FAILED', 'UNSUPPORTED'].includes(lifecycle.status) && !data.retranscribeOnly) {
      const eventLog = await this.db.messengerEventLog.findUnique({ where: { id: data.eventLogId } });
      return eventLog?.localOutboundMessageId ? this.retryDelivery(eventLog, data.senderId) : { duplicate: true };
    }
    if (lifecycle.status === 'COMPLETED' && !data.retranscribeOnly) {
      await enqueueAudioBatch(this.queue, { conversationId: lifecycle.message.conversationId, senderId: data.senderId, eventLogId: data.eventLogId }, this.debounceMs);
      return { alreadyTranscribed: true };
    }
    const started = Date.now();
    await this.db.audioTranscription.update({
      where: { messageId: data.messageId },
      data: { status: 'PROCESSING', processingStartedAt: new Date(), attemptCount: { increment: 1 }, errorCode: null },
    });
    this.logger.info({ messageId: data.messageId, attempt }, 'Audio transcription started');
    try {
      if (!lifecycle.providerUrl) throw new AudioValidationError('Audio URL has expired', 'INVALID_AUDIO_URL');
      const prepared = await this.voice.prepare({
        type: 'audio', url: lifecycle.providerUrl, source: 'messenger',
        ...(lifecycle.sourceMimeType ? { mimeType: lifecycle.sourceMimeType } : {}),
      });
      const sttStarted = Date.now();
      const transcription = await this.voice.transcribe(prepared);
      const sttDurationMs = Date.now() - sttStarted;
      const normalized = await this.voice.normalizeProductCodes(transcription.text);
      const retainedUntil = this.retentionHours > 0
        ? new Date(Date.now() + this.retentionHours * 3_600_000)
        : null;
      const metadata = this.mergeMetadata(lifecycle.message.metadata, {
        inputType: 'audio',
        audio: {
          source: 'messenger', status: 'COMPLETED', mimeType: prepared.mimeType,
          duration: prepared.duration, fileSize: prepared.sizeBytes,
          ...(retainedUntil ? { url: lifecycle.providerUrl, retainedUntil: retainedUntil.toISOString() } : { url: null }),
        },
        transcription: {
          status: 'COMPLETED', text: transcription.text, normalizedText: normalized.normalizedText,
          language: transcription.language, confidence: transcription.confidence,
          duration: transcription.duration, provider: this.provider, model: this.model,
          sttDurationMs,
        },
      });
      await this.db.$transaction([
        this.db.audioTranscription.update({
          where: { messageId: data.messageId },
          data: {
            status: 'COMPLETED', provider: this.provider, model: this.model,
            detectedMimeType: prepared.mimeType, durationSeconds: transcription.duration ?? prepared.duration,
            fileSizeBytes: prepared.sizeBytes, originalTranscript: transcription.text,
            normalizedTranscript: normalized.normalizedText, language: transcription.language,
            confidence: transcription.confidence, sttDurationMs, totalDurationMs: Date.now() - started,
            transcribedAt: new Date(), retainedUntil,
            ...(!retainedUntil ? { providerUrl: null } : {}),
          },
        }),
        this.db.message.update({ where: { id: data.messageId }, data: { content: transcription.text, metadata } }),
      ]);
      if (!data.retranscribeOnly) {
        await enqueueAudioBatch(this.queue, { conversationId: lifecycle.message.conversationId, senderId: data.senderId, eventLogId: data.eventLogId }, this.debounceMs);
      }
      this.logger.info({ messageId: data.messageId, durationSeconds: transcription.duration, sttDurationMs, provider: this.provider, model: this.model }, 'Audio transcription completed');
      return { transcribed: true };
    } catch (error) {
      const permanentCode = this.permanentCode(error);
      if (data.retranscribeOnly) {
        if (permanentCode || attempt >= maxAttempts) {
          await this.db.audioTranscription.update({
            where: { messageId: data.messageId },
            data: { status: 'COMPLETED', errorCode: permanentCode ?? 'ADMIN_RETRANSCRIBE_FAILED' },
          });
          if (permanentCode) throw new PermanentAudioError(permanentCode);
          return { failed: true };
        }
        throw error;
      }
      if (permanentCode) {
        await this.finalizeFailure(data, lifecycle, permanentCode, true);
        throw new PermanentAudioError(permanentCode);
      }
      if (attempt >= maxAttempts) {
        await this.finalizeFailure(data, lifecycle, 'FAILED', false);
        return { failed: true };
      }
      await this.db.audioTranscription.update({ where: { messageId: data.messageId }, data: { status: 'PENDING', errorCode: 'TEMPORARY_PROVIDER_FAILURE' } });
      this.logger.warn({ messageId: data.messageId, attempt, errorType: error instanceof Error ? error.name : 'unknown' }, 'Temporary audio transcription failure');
      throw error instanceof Error ? error : new AudioFetchError('Audio processing failed');
    }
  }

  async processBatch(data: AudioBatchJobData) {
    const eventLog = await this.db.messengerEventLog.findUnique({ where: { id: data.eventLogId } });
    if (eventLog?.localOutboundMessageId && eventLog.status === 'PROCESSED') return { duplicate: true };
    if (eventLog?.localOutboundMessageId) return this.retryDelivery(eventLog, data.senderId);
    const lockKey = `conversation:processing:messenger:${eventLog?.pageId ?? 'unknown'}:${data.senderId}`;
    const token = `${data.eventLogId}:${Date.now()}`;
    const locked = await this.redis.set(lockKey, token, 'PX', 90_000, 'NX');
    if (!locked) throw new Error('Audio batch is already processing');
    try {
      const records = await this.db.audioTranscription.findMany({
        where: { status: 'COMPLETED', aiProcessedAt: null, message: { conversationId: data.conversationId } },
        include: { message: { include: { customer: true } } }, orderBy: { createdAt: 'asc' }, take: 10,
      });
      if (!records.length) return { empty: true };
      const latest = records.at(-1)!;
      const texts = records.map((record: any) => record.originalTranscript).filter(Boolean);
      const combined = texts.join('\n');
      const languages = [...new Set<string>(records.map((record: any) => record.language).filter(Boolean))];
      const mergedLanguage: 'bn' | 'en' | 'mixed' | 'unknown' = languages.length === 1 && ['bn', 'en', 'mixed', 'unknown'].includes(languages[0]!)
        ? languages[0] as 'bn' | 'en' | 'mixed' | 'unknown'
        : 'mixed';
      const knownDurations = records.map((record: any) => record.durationSeconds).filter((value: unknown) => typeof value === 'number');
      const duration = knownDurations.length === records.length ? knownDurations.reduce((sum: number, value: number) => sum + value, 0) : null;
      const aiStarted = Date.now();
      const result = await this.chat.send({
        customer: { platform: 'messenger', platformPageId: records[0]?.message.metadata?.pageId, platformUserId: data.senderId }, channel: 'messenger',
        conversationId: data.conversationId, existingMessageId: latest.messageId,
        message: combined,
        audioTranscription: { text: combined, language: mergedLanguage, confidence: null, duration },
        sourceMetadata: {
          inputType: 'audio', audioMessageIds: records.map((record: any) => record.messageId),
          stt: { provider: this.provider, model: this.model, durationMs: records.reduce((sum: number, record: any) => sum + (record.sttDurationMs ?? 0), 0) },
        },
      });
      const aiDurationMs = Date.now() - aiStarted;
      if (!result.reply || !('assistantMessageId' in result) || !result.assistantMessageId) {
        await this.markProcessed(records, aiDurationMs);
        await this.completeEvents(records);
        return { delivered: false, humanLocked: true };
      }
      const outboundId = String(result.assistantMessageId);
      const outbound = await this.db.message.findUnique({ where: { id: outboundId } });
      const sttDurationMs = records.reduce((sum: number, record: any) => sum + (record.sttDurationMs ?? 0), 0);
      await this.db.message.update({
        where: { id: outboundId },
        data: { metadata: this.mergeMetadata(outbound?.metadata, {
          audioDebug: {
            inputType: 'audio', durationSeconds: duration, provider: this.provider, model: this.model,
            transcript: combined, sttDurationMs, aiDurationMs, totalDurationMs: sttDurationMs + aiDurationMs,
            estimatedCost: null,
          },
        }) },
      });
      const externalIds = records.map((record: any) => record.message.externalMessageId).filter(Boolean);
      await this.db.messengerEventLog.updateMany({ where: { externalMessageId: { in: externalIds } }, data: { localOutboundMessageId: outboundId } });
      await this.markProcessed(records, aiDurationMs);
      return this.deliver(records, outboundId, data.senderId, result.reply);
    } catch (error) {
      throw error;
    } finally {
      await this.redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, lockKey, token).catch(() => undefined);
    }
  }

  async expireRetainedAudio() {
    const expired = await this.db.audioTranscription.findMany({ where: { retainedUntil: { lte: new Date() }, providerUrl: { not: null } }, select: { messageId: true } });
    for (const record of expired) {
      const message = await this.db.message.findUnique({ where: { id: record.messageId } });
      const metadata = this.mergeMetadata(message?.metadata, { audio: { ...(this.objectPart(message?.metadata, 'audio')), status: 'EXPIRED', url: null, retainedUntil: null } });
      await this.db.$transaction([
        this.db.audioTranscription.update({ where: { messageId: record.messageId }, data: { status: 'EXPIRED', providerUrl: null, retainedUntil: null } }),
        this.db.message.update({ where: { id: record.messageId }, data: { metadata } }),
      ]);
    }
    return expired.length;
  }

  private async finalizeFailure(data: AudioTranscriptionJobData, lifecycle: any, code: string, unsupported: boolean) {
    const status = unsupported ? 'UNSUPPORTED' : 'FAILED';
    const metadata = this.mergeMetadata(lifecycle.message.metadata, {
      inputType: 'audio', audio: { source: 'messenger', status, url: null },
      transcription: { status, errorCode: code },
    });
    await this.db.$transaction([
      this.db.audioTranscription.update({ where: { messageId: data.messageId }, data: { status, errorCode: code, providerUrl: null } }),
      this.db.message.update({ where: { id: data.messageId }, data: { metadata } }),
    ]);
    const handedOver = await this.incrementFailure(lifecycle.message.conversationId);
    const reply = handedOver
      ? 'ভয়েসটি বুঝতে সমস্যা হচ্ছে। একজন টিম মেম্বার আপনার সাথে কথা বলবেন—একটু সময় দিন।'
      : SAFE_AUDIO_RESPONSES[code] ?? SAFE_AUDIO_RESPONSES.FAILED!;
    const assistant = await this.messages.addMessage({
      conversationId: lifecycle.message.conversationId, customerId: lifecycle.message.customerId,
      role: 'assistant', content: reply,
      metadata: { inputType: 'audio', audioFailure: code, platform: 'messenger', direction: 'outbound', handedOver },
    });
    await this.db.messengerEventLog.update({ where: { id: data.eventLogId }, data: { localOutboundMessageId: assistant.id } });
    await this.deliver([{ message: lifecycle.message }], assistant.id, data.senderId, assistant.content);
    this.logger.warn({ messageId: data.messageId, errorCode: code, permanent: unsupported }, 'Audio transcription failed');
  }

  private async incrementFailure(conversationId: string): Promise<boolean> {
    const conversation = await this.db.conversation.update({ where: { id: conversationId }, data: { consecutiveAiFailures: { increment: 1 } } });
    if (conversation.status === 'HUMAN') return true;
    if (conversation.consecutiveAiFailures < 2) return false;
    try {
      await this.handovers.requestHandover({
        conversationId, reason: 'repeated_failure',
        note: 'Repeated voice transcription failures', createdBy: 'audio-worker',
      });
      return true;
    } catch {
      this.logger.warn({ conversationId }, 'Audio failure handover could not be created');
      return false;
    }
  }

  private permanentCode(error: unknown): string | null {
    if (error instanceof SpeechToTextDurationError) return 'AUDIO_TOO_LONG';
    if (error instanceof AudioValidationError) return error.code;
    return null;
  }

  private async markProcessed(records: any[], aiDurationMs: number) {
    await Promise.all(records.map((record) => this.db.audioTranscription.update({
      where: { id: record.id },
      data: { aiProcessedAt: new Date(), aiDurationMs, totalDurationMs: (record.sttDurationMs ?? 0) + aiDurationMs },
    })));
  }

  private completeEvents(records: any[]) {
    const externalIds = records.map((record) => record.message.externalMessageId).filter(Boolean);
    return this.db.messengerEventLog.updateMany({ where: { externalMessageId: { in: externalIds } }, data: { status: 'PROCESSED', processedAt: new Date(), errorMessage: null } });
  }

  private async deliver(records: any[], outboundId: string, senderId: string, text: string) {
    const externalIds = records.map((record) => record.message.externalMessageId).filter(Boolean);
    const eventLog = await this.db.messengerEventLog.findFirst({ where: { externalMessageId: { in: externalIds } }, orderBy: { receivedAt: 'asc' } });
    const outbound = await this.db.message.findUnique({ where: { id: outboundId } });
    if (this.outgoing && eventLog && outbound) {
      await this.outgoing.enqueue({ messageId: outboundId, conversationId: outbound.conversationId, eventLogId: eventLog.id, pageId: eventLog.pageId, recipientId: senderId, correlationId: eventLog.correlationId ?? eventLog.id });
      await this.db.messengerEventLog.updateMany({ where: { externalMessageId: { in: externalIds }, id: { not: eventLog.id } }, data: { status: 'IGNORED', processedAt: new Date(), processingCompletedAt: new Date(), errorType: 'BATCHED' } });
      return { queued: true };
    }
    const result = await this.sender.sendText(senderId, text);
    await this.db.messengerEventLog.updateMany({
      where: { externalMessageId: { in: externalIds } },
      data: result.success
        ? { status: 'PROCESSED', processedAt: new Date(), errorMessage: null }
        : { status: result.retryable ? 'DELIVERY_FAILED' : 'FAILED', processedAt: result.retryable ? null : new Date(), errorMessage: (result.errorMessage ?? result.errorCode ?? 'Delivery failed').slice(0, 500) },
    });
    if (!result.success && result.retryable) throw new Error('Temporary Messenger delivery failure');
    return { delivered: result.success, externalMessageId: result.externalMessageId };
  }

  private async retryDelivery(eventLog: any, senderId: string) {
    const lockKey = `audio-delivery:${eventLog.localOutboundMessageId}`;
    const token = `${eventLog.id}:${Date.now()}`;
    const locked = await this.redis.set(lockKey, token, 'PX', 30_000, 'NX');
    if (!locked) throw new Error('Audio reply delivery is already processing');
    try {
      const fresh = await this.db.messengerEventLog.findUnique({ where: { id: eventLog.id } });
      if (fresh?.status === 'PROCESSED') return { duplicate: true };
      const outbound = await this.db.message.findUnique({ where: { id: eventLog.localOutboundMessageId } });
      if (!outbound) throw new PermanentAudioError('OUTBOUND_MISSING');
      if (this.outgoing) {
        await this.outgoing.enqueue({ messageId: outbound.id, conversationId: outbound.conversationId, eventLogId: eventLog.id, pageId: eventLog.pageId, recipientId: senderId, correlationId: eventLog.correlationId ?? eventLog.id });
        return { queued: true };
      }
      const result = await this.sender.sendText(senderId, outbound.content);
      await this.db.messengerEventLog.updateMany({ where: { localOutboundMessageId: eventLog.localOutboundMessageId }, data: result.success ? { status: 'PROCESSED', processedAt: new Date(), errorMessage: null } : { status: result.retryable ? 'DELIVERY_FAILED' : 'FAILED', processedAt: result.retryable ? null : new Date(), errorMessage: 'Delivery failed' } });
      if (!result.success && result.retryable) throw new Error('Temporary Messenger delivery failure');
      return { delivered: result.success };
    } finally {
      await this.redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, lockKey, token).catch(() => undefined);
    }
  }

  private mergeMetadata(existing: unknown, added: Record<string, unknown>) {
    const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing as Record<string, unknown> : {};
    return { ...base, ...added };
  }

  private objectPart(metadata: unknown, key: string): Record<string, unknown> {
    const root = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata as Record<string, unknown> : {};
    const value = root[key];
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }
}
