import type { PrismaClient } from '@alzeena/database';
import { env } from '../../config/env.js';
import { GeminiProvider } from '../ai/providers/gemini.provider.js';
import { ProductCatalogService } from '../products/product-catalog.service.js';
import { ImageAnalysisService } from './image-analysis.service.js';
import { ImageProductService } from './image-product.service.js';
import { ImageService } from './image.service.js';
import { ImageValidationService } from './image-validation.service.js';
import { ProductMatchingService } from './product-matching.service.js';
import { GeminiVisionProvider } from './providers/gemini-vision.provider.js';

export function createImageProductService(prisma: PrismaClient): ImageProductService {
  const catalog = new ProductCatalogService(prisma);
  const gemini = env.VISION_PROVIDER === 'gemini' && env.GEMINI_API_KEY
    ? new GeminiProvider({
        apiKey: env.GEMINI_API_KEY, model: env.VISION_MODEL, temperature: 0,
        maxOutputTokens: env.GEMINI_MAX_OUTPUT_TOKENS, timeoutMs: env.VISION_TIMEOUT * 1_000,
      })
    : undefined;
  return new ImageProductService(
    new ImageService(
      new ImageValidationService(env.IMAGE_MAX_FILE_SIZE, env.IMAGE_MAX_DIMENSION),
      env.IMAGE_REQUEST_TIMEOUT_MS,
    ),
    new ImageAnalysisService(gemini ? new GeminiVisionProvider(gemini) : undefined),
    new ProductMatchingService(
      catalog, env.IMAGE_MATCH_HIGH_THRESHOLD, env.IMAGE_MATCH_MEDIUM_THRESHOLD,
      env.IMAGE_MATCH_CANDIDATES,
    ),
    env.IMAGE_MATCH_CANDIDATES,
  );
}
