import type {
  CatalogProductWithAvailability,
  ProductCatalogService,
} from '../products/product-catalog.service.js';
import type { ImageAnalysis } from './image.types.js';

export interface ProductClues {
  productName?: string | null;
  productCode?: string | null;
  brand?: string | null;
  category?: string | null;
  subCategory?: string | null;
  color?: string | null;
  visibleText?: string[];
  designKeywords?: string[];
}

export interface ProductMatch {
  productId: number;
  score: number;
  reasons: string[];
  product: CatalogProductWithAvailability['product'];
  availability: CatalogProductWithAvailability['availability'];
}

export interface ProductMatchResult {
  confidenceLevel: 'high' | 'medium' | 'low';
  matches: ProductMatch[];
  selectedProduct: ProductMatch | null;
}

/** Future vector/embedding matchers can implement this without changing orchestration. */
export interface ImageProductMatcher {
  match(clues: ProductClues, clueConfidence?: number): Promise<ProductMatchResult>;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function tokens(value: string): Set<string> {
  return new Set(normalize(value).split(/\s+/).filter((token) => token.length >= 2));
}

function similarity(left: string, right: string): number {
  const a = tokens(left);
  const b = tokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  return common / new Set([...a, ...b]).size;
}

function codeTokens(value: string): string[] {
  return value.match(/\b[A-Za-z]{2,}\s*-?\s*\d+[A-Za-z0-9-]*\b/g)?.map((code) => normalize(code).replace(/\s/g, '')) ?? [];
}

export function cluesFromCaption(caption: string): ProductClues {
  const codes = codeTokens(caption);
  return {
    productCode: codes[0] ?? null,
    visibleText: caption.trim() ? [caption.trim()] : [],
  };
}

export function mergeProductClues(
  captionClues: ProductClues,
  analysis?: ImageAnalysis | null,
): ProductClues {
  if (!analysis) return captionClues;
  return {
    productName: analysis.productName,
    productCode:
      captionClues.productCode ??
      analysis.productCode ??
      codeTokens(analysis.visibleText.join(' '))[0] ??
      null,
    brand: analysis.brand,
    category: analysis.category,
    subCategory: analysis.subCategory,
    color: analysis.color,
    designKeywords: [...analysis.designKeywords, ...analysis.visualAttributes],
    visibleText: [
      ...(captionClues.visibleText ?? []), ...analysis.visibleText,
      analysis.ocr.text, analysis.description ?? '', ...analysis.productNameHints, ...analysis.categoryHints, ...analysis.colorHints,
    ].filter(Boolean),
  };
}

export class ProductMatchingService {
  constructor(
    private readonly catalog: ProductCatalogService,
    private readonly highThreshold: number,
    private readonly mediumThreshold: number,
    private readonly candidateLimit = 5,
  ) {}

  async match(clues: ProductClues, clueConfidence = 1): Promise<ProductMatchResult> {
    const searchTerms = [
      clues.productCode,
      clues.productName,
      clues.brand,
      clues.color,
      clues.category,
      clues.subCategory,
      ...(clues.designKeywords ?? []),
      ...(clues.visibleText ?? []),
    ]
      .filter((value): value is string => Boolean(value?.trim()))
      .map((value) => value.trim().slice(0, 100));

    const candidates = new Map<number, Awaited<ReturnType<ProductCatalogService['searchProducts']>>[number]>();
    for (const term of [...new Set(searchTerms)].slice(0, 12)) {
      const products = await this.catalog.searchProducts(term, 15);
      for (const product of products) candidates.set(product.id, product);
      if (candidates.size >= 50) break;
    }

    const scored = [...candidates.values()]
      .map((product) => {
        const reasons: string[] = [];
        let score = 0;
        const requestedCodes = codeTokens(clues.productCode ?? '');
        const productCodes = codeTokens(product.productCode);
        if (requestedCodes.some((code) => productCodes.includes(code))) {
          score = Math.max(score, 0.96);
          reasons.push('product_code_exact');
        } else if (
          clues.productCode &&
          (normalize(product.productCode).includes(normalize(clues.productCode)) ||
            normalize(clues.productCode).includes(normalize(product.productCode)))
        ) {
          score = Math.max(score, 0.8);
          reasons.push('product_code_partial');
        }

        if (clues.productName) {
          const nameSimilarity = similarity(clues.productName, product.productName);
          if (normalize(clues.productName) === normalize(product.productName)) {
            score = Math.max(score, 0.92);
            reasons.push('product_name_exact');
          } else if (nameSimilarity >= 0.45) {
            score = Math.max(score, 0.62 + nameSimilarity * 0.25);
            reasons.push('product_name_similar');
          }
        }

        const attributeChecks: Array<[string | null | undefined, string | null, string]> = [
          [clues.color, product.color, 'color'],
          [clues.category, product.category, 'category'],
          [clues.subCategory, product.subCategory, 'sub_category'],
        ];
        let attributeMatches = 0;
        for (const [clue, actual, reason] of attributeChecks) {
          if (
            clue &&
            actual &&
            (normalize(actual).includes(normalize(clue)) ||
              normalize(clue).includes(normalize(actual)))
          ) {
            attributeMatches += 1;
            score += 0.12;
            reasons.push(reason);
          }
        }
        if (attributeMatches >= 3) score = Math.max(score, 0.7);
        else if (attributeMatches === 2) score = Math.max(score, 0.58);

        const keywordText = [
          clues.brand ?? '',
          ...(clues.designKeywords ?? []),
          ...(clues.visibleText ?? []),
        ].join(' ');
        const visualSimilarity = similarity(
          keywordText,
          `${product.productName} ${product.productCode} ${product.productDetails ?? ''} ${product.color ?? ''}`,
        );
        if (visualSimilarity >= 0.15) {
          score += Math.min(0.2, visualSimilarity * 0.25);
          if (visualSimilarity >= 0.5) score = Math.max(score, 0.4 + visualSimilarity * 0.5);
          reasons.push('visible_text_or_design');
        }

        const confidenceFactor = 0.7 + Math.max(0, Math.min(clueConfidence, 1)) * 0.3;
        return {
          productId: product.id,
          score: Math.min(1, score * confidenceFactor),
          reasons: [...new Set(reasons)],
        };
      })
      .filter((match) => match.score > 0)
      .sort((a, b) => b.score - a.score || a.productId - b.productId)
      .slice(0, 10);

    const currentProducts = await this.catalog.getProductsWithAvailability(
      scored.map((match) => match.productId),
    );
    const currentById = new Map(currentProducts.map((item) => [item.product.id, item]));
    const matches: ProductMatch[] = scored.flatMap((match) => {
      const current = currentById.get(match.productId);
      return current ? [{ ...match, score: Number(match.score.toFixed(4)), ...current }] : [];
    });

    const first = matches[0];
    const second = matches[1];
    const clearlyAhead = !second || first!.score - second.score >= 0.1;
    const exactCode = first?.reasons.includes('product_code_exact') ?? false;
    const selectedProduct =
      first && first.score >= this.highThreshold && (clearlyAhead || exactCode) ? first : null;
    const confidenceLevel = selectedProduct
      ? 'high'
      : first && first.score >= this.mediumThreshold
        ? 'medium'
        : 'low';

    return {
      confidenceLevel,
      matches: matches.filter((match) => match.score >= this.mediumThreshold).slice(0, this.candidateLimit),
      selectedProduct,
    };
  }
}
