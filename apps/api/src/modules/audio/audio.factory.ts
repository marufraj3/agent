import type { PrismaClient } from '@alzeena/database';
import { env } from '../../config/env.js';
import { createAIProvider } from '../ai/ai.factory.js';
import { ProductCatalogService } from '../products/product-catalog.service.js';
import { AudioService } from './audio.service.js';
import { AudioValidationService } from './audio-validation.service.js';
import { GeminiSpeechToTextProvider } from './providers/gemini-speech-to-text.provider.js';
import { SpeechToTextService } from './speech-to-text.service.js';
import { VoiceProductCodeService } from './voice-product-code.service.js';
import { VoiceUnderstandingService } from './voice-understanding.service.js';

export function createVoiceUnderstandingService(prisma: PrismaClient): VoiceUnderstandingService {
  const aiProvider = createAIProvider();
  const speechProvider = aiProvider ? new GeminiSpeechToTextProvider(aiProvider) : undefined;
  return new VoiceUnderstandingService(
    new AudioService(
      new AudioValidationService(env.MAX_AUDIO_SIZE_MB, env.MAX_AUDIO_DURATION_SECONDS),
      env.AUDIO_REQUEST_TIMEOUT_MS,
    ),
    new SpeechToTextService(
      speechProvider,
      env.VOICE_TRANSCRIPTION_LOW_CONFIDENCE,
      env.AUDIO_REQUEST_TIMEOUT_MS,
      env.MAX_AUDIO_DURATION_SECONDS,
    ),
    new VoiceProductCodeService(new ProductCatalogService(prisma)),
  );
}
