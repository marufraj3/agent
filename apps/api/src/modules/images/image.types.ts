import { z } from 'zod';

export const supportedImageMimeTypes = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type SupportedImageMimeType = (typeof supportedImageMimeTypes)[number];

export const imageInputSchema = z
  .object({
    type: z.literal('image').default('image'),
    url: z.url().max(2_048).optional(),
    data: z.string().min(1).optional(),
    mimeType: z.enum(supportedImageMimeTypes).optional(),
    caption: z.string().trim().max(4_000).optional(),
    source: z.string().trim().min(1).max(50).default('web'),
  })
  .strict()
  .refine((image) => Boolean(image.url) !== Boolean(image.data), {
    message: 'Provide exactly one of image.url or image.data',
  });

export type ImageInput = z.infer<typeof imageInputSchema>;

export interface PreparedImage {
  data: Buffer;
  base64: string;
  mimeType: SupportedImageMimeType;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  sha256: string;
  source: string;
  temporary: true;
}

export const imageAnalysisSchema = z
  .object({
    productName: z.string().trim().min(1).max(255).nullable(),
    productCode: z.string().trim().min(1).max(100).nullable(),
    brand: z.string().trim().min(1).max(100).nullable(),
    category: z.string().trim().min(1).max(100).nullable(),
    subCategory: z.string().trim().min(1).max(100).nullable(),
    color: z.string().trim().min(1).max(100).nullable(),
    visibleText: z.array(z.string().trim().min(1).max(255)).max(30),
    designKeywords: z.array(z.string().trim().min(1).max(100)).max(20),
    sizeVisible: z.string().trim().min(1).max(50).nullable(),
    priceVisible: z.string().trim().min(1).max(50).nullable(),
    description: z.string().trim().min(1).max(1_000).nullable(),
    productNameHints: z.array(z.string().trim().min(1).max(255)).max(10),
    categoryHints: z.array(z.string().trim().min(1).max(100)).max(10),
    colorHints: z.array(z.string().trim().min(1).max(100)).max(10),
    visualAttributes: z.array(z.string().trim().min(1).max(100)).max(20),
    ocr: z.object({
      text: z.string().max(5_000),
      confidence: z.number().min(0).max(1).nullable(),
    }).strict(),
    detectedProducts: z.array(z.object({
      index: z.number().int().positive(),
      productName: z.string().trim().min(1).max(255).nullable(),
      productCode: z.string().trim().min(1).max(100).nullable(),
      category: z.string().trim().min(1).max(100).nullable(),
      color: z.string().trim().min(1).max(100).nullable(),
      attributes: z.array(z.string().trim().min(1).max(100)).max(10),
    }).strict()).max(10),
    sizeChart: z.array(z.object({
      size: z.string().trim().min(1).max(50),
      measurement: z.string().trim().min(1).max(100),
    }).strict()).max(20),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type ImageAnalysis = z.infer<typeof imageAnalysisSchema>;
