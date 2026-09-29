import type { PrismaClient } from '@alzeena/database';
import { env } from '../../config/env.js';
import { createAIProvider } from '../ai/ai.factory.js';
import { ProductCatalogService } from '../products/product-catalog.service.js';
import { ImageAnalysisService } from './image-analysis.service.js';
import { ImageProductService } from './image-product.service.js';
import { ImageService } from './image.service.js';
import { ImageValidationService } from './image-validation.service.js';
import { ProductMatchingService } from './product-matching.service.js';

export function createImageProductService(prisma: PrismaClient): ImageProductService {
  const catalog = new ProductCatalogService(prisma);
  return new ImageProductService(
    new ImageService(
      new ImageValidationService(env.MAX_IMAGE_SIZE_MB),
      env.IMAGE_REQUEST_TIMEOUT_MS,
    ),
    new ImageAnalysisService(createAIProvider()),
    new ProductMatchingService(
      catalog,
      env.IMAGE_MATCH_HIGH_THRESHOLD,
      env.IMAGE_MATCH_MEDIUM_THRESHOLD,
    ),
  );
}
