import type { PrismaClient } from '@alzeena/database';
import { env } from '../../config/env.js';
import { GeminiProvider } from '../ai/providers/gemini.provider.js';
import { ProductCatalogService } from '../products/product-catalog.service.js';
import { AudioService } from './audio.service.js';
import { AudioValidationService } from './audio-validation.service.js';
import { GeminiSpeechToTextProvider } from './providers/gemini-speech-to-text.provider.js';
import { SpeechToTextService } from './speech-to-text.service.js';
import { VoiceProductCodeService } from './voice-product-code.service.js';
import { VoiceUnderstandingService } from './voice-understanding.service.js';

export function createVoiceUnderstandingService(prisma: PrismaClient): VoiceUnderstandingService {
  const aiProvider = env.STT_PROVIDER === 'gemini' && env.GEMINI_API_KEY
    ? new GeminiProvider({
        apiKey: env.GEMINI_API_KEY,
        model: env.STT_MODEL,
        temperature: 0,
        maxOutputTokens: env.GEMINI_MAX_OUTPUT_TOKENS,
        timeoutMs: env.STT_TIMEOUT * 1_000,
      })
    : undefined;
  const speechProvider = aiProvider ? new GeminiSpeechToTextProvider(aiProvider) : undefined;
  return new VoiceUnderstandingService(
    new AudioService(
      new AudioValidationService(env.STT_MAX_FILE_SIZE, env.STT_MAX_DURATION),
      env.AUDIO_REQUEST_TIMEOUT_MS,
    ),
    new SpeechToTextService(
      speechProvider,
      env.VOICE_TRANSCRIPTION_LOW_CONFIDENCE,
      env.STT_TIMEOUT * 1_000,
      env.STT_MAX_DURATION,
    ),
    new VoiceProductCodeService(new ProductCatalogService(prisma)),
  );
}
