import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../../config/env.js';
import { AppError } from '../../../errors/app-error.js';
import { requireAdmin } from '../../admin/auth/require-admin.js';
import { createAIService } from '../../ai/ai.factory.js';
import { enforceAIRateLimit } from '../../ai/ai-rate-limit.js';
import { createImageProductService } from '../image.factory.js';
import { ImageFetchError } from '../image.service.js';
import { imageInputSchema } from '../image.types.js';
import { ImageValidationError } from '../image-validation.service.js';

const analyzeImageRequestSchema = z
  .object({
    imageUrl: z.url().max(2_048).optional(),
    imageData: z.string().min(1).optional(),
    mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']).optional(),
    caption: z.string().trim().max(4_000).default(''),
  })
  .strict()
  .refine((input) => Boolean(input.imageUrl) !== Boolean(input.imageData), {
    message: 'Provide exactly one of imageUrl or imageData',
  });

export async function imageRoutes(app: FastifyInstance): Promise<void> {
  const images = createImageProductService(app.prisma);
  const ai = createAIService(app.prisma, app.log);

  app.post(
    '/api/ai/analyze-image',
    {
      preHandler: [requireAdmin, enforceAIRateLimit],
      bodyLimit: Math.ceil(env.MAX_IMAGE_SIZE_MB * 1024 * 1024 * (4 / 3)) + 100_000,
    },
    async (request) => {
      const parsed = analyzeImageRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        const message = parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
          .join('; ');
        throw new AppError(message, 400, 'VALIDATION_ERROR');
      }

      try {
        const imageInput = imageInputSchema.parse({
          type: 'image',
          ...(parsed.data.imageUrl ? { url: parsed.data.imageUrl } : { data: parsed.data.imageData }),
          ...(parsed.data.mimeType ? { mimeType: parsed.data.mimeType } : {}),
          caption: parsed.data.caption,
          source: 'admin_test',
        });
        const result = await images.identify(imageInput, parsed.data.caption);
        const productIds = result.selectedProduct
          ? [result.selectedProduct.productId]
          : result.confidenceLevel === 'medium'
            ? result.matches.map((match) => match.productId)
            : [];
        const aiResponse = await ai.respond({
          message: parsed.data.caption || 'Which product is shown in this image?',
          language: 'auto',
          conversationHistory: [],
          contextProductIds: productIds,
        });

        return {
          success: true,
          data: {
            analysis: result.analysis,
            analysisStatus: result.analysisStatus,
            matches: result.matches,
            selectedProduct: result.selectedProduct,
            aiResponse,
            confidence: result.selectedProduct?.score ?? result.matches[0]?.score ?? 0,
          },
        };
      } catch (error) {
        if (error instanceof ImageValidationError) {
          throw new AppError(error.message, 400, error.code);
        }
        if (error instanceof ImageFetchError) {
          throw new AppError(error.message, 422, 'IMAGE_FETCH_FAILED');
        }
        request.log.error(
          { errorType: error instanceof Error ? error.name : 'UnknownError' },
          'Image analysis request failed',
        );
        throw new AppError(
          'Image analysis is temporarily unavailable',
          503,
          'IMAGE_ANALYSIS_UNAVAILABLE',
        );
      }
    },
  );
}
