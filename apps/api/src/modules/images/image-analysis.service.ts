import { imageAnalysisSchema, type ImageAnalysis, type PreparedImage } from './image.types.js';
import type { VisionAnalysisResult, VisionProvider } from './providers/vision.provider.js';

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };
export const IMAGE_ANALYSIS_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object', additionalProperties: false,
  properties: {
    productName: nullableString, productCode: nullableString, brand: nullableString,
    category: nullableString, subCategory: nullableString, color: nullableString,
    visibleText: { type: 'array', items: { type: 'string' }, maxItems: 30 },
    designKeywords: { type: 'array', items: { type: 'string' }, maxItems: 20 },
    sizeVisible: nullableString, priceVisible: nullableString, description: nullableString,
    productNameHints: { type: 'array', items: { type: 'string' }, maxItems: 10 },
    categoryHints: { type: 'array', items: { type: 'string' }, maxItems: 10 },
    colorHints: { type: 'array', items: { type: 'string' }, maxItems: 10 },
    visualAttributes: { type: 'array', items: { type: 'string' }, maxItems: 20 },
    ocr: {
      type: 'object', additionalProperties: false,
      properties: { text: { type: 'string' }, confidence: { anyOf: [{ type: 'number', minimum: 0, maximum: 1 }, { type: 'null' }] } },
      required: ['text', 'confidence'],
    },
    detectedProducts: {
      type: 'array', maxItems: 10, items: {
        type: 'object', additionalProperties: false,
        properties: {
          index: { type: 'integer', minimum: 1 }, productName: nullableString, productCode: nullableString,
          category: nullableString, color: nullableString,
          attributes: { type: 'array', items: { type: 'string' }, maxItems: 10 },
        },
        required: ['index', 'productName', 'productCode', 'category', 'color', 'attributes'],
      },
    },
    sizeChart: {
      type: 'array', maxItems: 20, items: {
        type: 'object', additionalProperties: false,
        properties: { size: { type: 'string' }, measurement: { type: 'string' } }, required: ['size', 'measurement'],
      },
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: [
    'productName', 'productCode', 'brand', 'category', 'subCategory', 'color', 'visibleText',
    'designKeywords', 'sizeVisible', 'priceVisible', 'description', 'productNameHints',
    'categoryHints', 'colorHints', 'visualAttributes', 'ocr', 'detectedProducts', 'sizeChart', 'confidence',
  ],
};

export class ImageAnalysisError extends Error {
  constructor(message: string) { super(message); this.name = 'ImageAnalysisError'; }
}

export function parseImageAnalysis(text: string): ImageAnalysis | null {
  const trimmed = text.trim();
  const candidates = [trimmed, trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')];
  const firstBrace = text.indexOf('{'); const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(text.slice(firstBrace, lastBrace + 1));
  for (const candidate of [...new Set(candidates)]) {
    try { const parsed = imageAnalysisSchema.safeParse(JSON.parse(candidate)); if (parsed.success) return parsed.data; }
    catch { /* Try the next bounded JSON candidate. */ }
  }
  return null;
}

export class ImageAnalysisService {
  private readonly cache = new Map<string, VisionAnalysisResult>();
  constructor(private readonly provider?: VisionProvider) {}

  async analyzeWithMetadata(image: PreparedImage, caption?: string): Promise<VisionAnalysisResult> {
    const cached = this.cache.get(image.sha256); if (cached) return cached;
    if (!this.provider) throw new ImageAnalysisError('Vision provider is not configured');
    const result = await this.provider.analyzeImage(image, caption);
    if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value ?? '');
    this.cache.set(image.sha256, result);
    return result;
  }

  async analyze(image: PreparedImage, caption?: string): Promise<ImageAnalysis> {
    return (await this.analyzeWithMetadata(image, caption)).analysis;
  }
}
