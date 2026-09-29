import { ImageAnalysisService } from './image-analysis.service.js';
import { ImageService } from './image.service.js';
import type { ImageAnalysis, ImageInput } from './image.types.js';
import {
  cluesFromCaption, mergeProductClues, type ImageProductMatcher, type ProductMatchResult,
} from './product-matching.service.js';

export interface ImageProductResult {
  image: {
    mimeType: string; sizeBytes: number; width: number | null; height: number | null;
    source: string; fingerprint: string; temporary: true;
  };
  analysis: ImageAnalysis | null;
  analysisStatus: 'completed' | 'skipped_exact_caption_match' | 'unavailable';
  matches: ProductMatchResult['matches'];
  selectedProduct: ProductMatchResult['selectedProduct'];
  confidenceLevel: ProductMatchResult['confidenceLevel'];
  detectedProducts: Array<{ index: number; matches: ProductMatchResult['matches']; selectedProduct: ProductMatchResult['selectedProduct']; confidenceLevel: ProductMatchResult['confidenceLevel'] }>;
  vision: { provider: string; model: string; durationMs: number } | null;
}

export class ImageProductService {
  constructor(
    private readonly images: ImageService,
    private readonly analysis: ImageAnalysisService,
    private readonly matching: ImageProductMatcher,
    private readonly maxCandidates = 5,
  ) {}

  async identify(input: ImageInput, caption = '', failOnAnalysisError = false): Promise<ImageProductResult> {
    const prepared = await this.images.prepare(input);
    const image = {
      mimeType: prepared.mimeType, sizeBytes: prepared.sizeBytes,
      width: prepared.width, height: prepared.height, source: prepared.source,
      fingerprint: prepared.sha256, temporary: true as const,
    };
    const captionClues = cluesFromCaption(caption);
    const captionMatch = await this.matching.match(captionClues, 1);
    if (captionMatch.selectedProduct?.reasons.includes('product_code_exact')) {
      return { image, analysis: null, analysisStatus: 'skipped_exact_caption_match', detectedProducts: [], vision: null, ...captionMatch };
    }

    try {
      const analyzed = await this.analysis.analyzeWithMetadata(prepared, caption);
      const primary = await this.matching.match(mergeProductClues(captionClues, analyzed.analysis), analyzed.analysis.confidence);
      const detectedProducts = await Promise.all(analyzed.analysis.detectedProducts.map(async (region) => ({
        index: region.index,
        ...await this.matching.match({
          productName: region.productName, productCode: region.productCode, category: region.category,
          color: region.color, designKeywords: region.attributes,
        }, analyzed.analysis.confidence),
      })));
      // Preserve visual reading order and make region candidates available to ordinal conversation context.
      const byId = new Map<number, ProductMatchResult['matches'][number]>();
      if (detectedProducts.length > 1) {
        for (const region of [...detectedProducts].sort((a, b) => a.index - b.index)) for (const match of region.matches) if (!byId.has(match.productId)) byId.set(match.productId, match);
      }
      for (const match of primary.matches) if (!byId.has(match.productId)) byId.set(match.productId, match);
      if (detectedProducts.length <= 1) for (const region of detectedProducts) for (const match of region.matches) if (!byId.has(match.productId)) byId.set(match.productId, match);
      const matches = [...byId.values()].slice(0, this.maxCandidates);
      const selectedProduct = primary.selectedProduct ?? (detectedProducts.length === 1 ? detectedProducts[0]?.selectedProduct ?? null : null);
      const confidenceLevel = selectedProduct ? 'high' : matches.length > 0 ? 'medium' : 'low';
      return {
        image, analysis: analyzed.analysis, analysisStatus: 'completed',
        ...primary, matches, selectedProduct, confidenceLevel, detectedProducts,
        vision: { provider: analyzed.provider, model: analyzed.model, durationMs: analyzed.durationMs },
      };
    } catch (error) {
      if (failOnAnalysisError) throw error;
      return { image, analysis: null, analysisStatus: 'unavailable', detectedProducts: [], vision: null, ...captionMatch };
    }
  }
}
