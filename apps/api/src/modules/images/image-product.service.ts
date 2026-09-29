import { ImageAnalysisService } from './image-analysis.service.js';
import { ImageService } from './image.service.js';
import type { ImageAnalysis, ImageInput } from './image.types.js';
import {
  cluesFromCaption,
  mergeProductClues,
  ProductMatchingService,
  type ProductMatchResult,
} from './product-matching.service.js';

export interface ImageProductResult {
  image: {
    mimeType: string;
    sizeBytes: number;
    source: string;
    temporary: true;
  };
  analysis: ImageAnalysis | null;
  analysisStatus: 'completed' | 'skipped_exact_caption_match' | 'unavailable';
  matches: ProductMatchResult['matches'];
  selectedProduct: ProductMatchResult['selectedProduct'];
  confidenceLevel: ProductMatchResult['confidenceLevel'];
}

export class ImageProductService {
  constructor(
    private readonly images: ImageService,
    private readonly analysis: ImageAnalysisService,
    private readonly matching: ProductMatchingService,
  ) {}

  async identify(input: ImageInput, caption = ''): Promise<ImageProductResult> {
    const prepared = await this.images.prepare(input);
    const captionClues = cluesFromCaption(caption);
    const captionMatch = await this.matching.match(captionClues, 1);

    if (captionMatch.selectedProduct?.reasons.includes('product_code_exact')) {
      return {
        image: {
          mimeType: prepared.mimeType,
          sizeBytes: prepared.sizeBytes,
          source: prepared.source,
          temporary: true,
        },
        analysis: null,
        analysisStatus: 'skipped_exact_caption_match',
        ...captionMatch,
      };
    }

    let imageAnalysis: ImageAnalysis;
    try {
      imageAnalysis = await this.analysis.analyze(prepared, caption);
    } catch {
      return {
        image: {
          mimeType: prepared.mimeType,
          sizeBytes: prepared.sizeBytes,
          source: prepared.source,
          temporary: true,
        },
        analysis: null,
        analysisStatus: 'unavailable',
        ...captionMatch,
      };
    }

    const match = await this.matching.match(
      mergeProductClues(captionClues, imageAnalysis),
      imageAnalysis.confidence,
    );
    return {
      image: {
        mimeType: prepared.mimeType,
        sizeBytes: prepared.sizeBytes,
        source: prepared.source,
        temporary: true,
      },
      analysis: imageAnalysis,
      analysisStatus: 'completed',
      ...match,
    };
  }
}
