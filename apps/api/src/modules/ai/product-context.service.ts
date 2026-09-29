import type {
  CatalogSearchProduct,
  ProductAvailability,
} from '../products/product-catalog.service.js';
import type { ProductReadTool } from './sales-tool.interfaces.js';
import type { ConversationMessage } from './ai.types.js';
import { extractEntities } from './entity-extractor.js';

export interface AIProductContext { product: CatalogSearchProduct; availability: ProductAvailability | null; }
export interface ProductContextResult { products: AIProductContext[]; searchPerformed: boolean; searchTerms: string[]; currentSearchTerms: string[]; }

const STOP_WORDS = new Set(['ache','ase','available','product','koto','price','stock','size','please','vai','bhai','this','that','have','want','order','color','recommend','suggest','options','option','budget','within','under']);
const SIZE_WORDS = new Set(['xs','s','m','l','xl','xxl','xxxl']);

export function extractProductSearchTerms(message: string): string[] {
  const terms: string[] = [];
  const codes = message.match(/\b[A-Za-z]{2,}\s*-?\s*\d+[A-Za-z0-9-]*\b/g) ?? [];
  for (const code of codes) {
    const compact = code.replace(/\s+/g, '').trim();
    terms.push(compact, compact.replace(/^([A-Za-z]+)-?(\d)/, '$1-$2'));
  }
  const words = message.match(/[A-Za-z][A-Za-z0-9-]{2,}/g) ?? [];
  terms.push(...words.filter((word) => {
    const normalized = word.toLowerCase();
    return !STOP_WORDS.has(normalized) && !SIZE_WORDS.has(normalized) && !/^\d+$/.test(normalized);
  }));
  return [...new Set(terms.map((term) => term.trim()).filter(Boolean))].slice(0, 8);
}

export class ProductContextService {
  constructor(private readonly catalog: ProductReadTool) {}

  async findRelevantProducts(message: string, history: ConversationMessage[], limit: number, preferredProductIds: number[] = []): Promise<ProductContextResult> {
    const currentTerms = extractProductSearchTerms(message);
    const entities = extractEntities(message);
    const recommendationRequested = /recommend|suggest|option|budget|within|under|মধ্যে|দেখান|সাজেস্ট/iu.test(message) || entities.minPrice !== null || entities.maxPrice !== null;
    const historyTerms = history.slice(-6).reverse().flatMap((item) => extractProductSearchTerms(item.content));
    const searchTerms = [...new Set([...currentTerms, ...historyTerms])].slice(0, 10);
    const found = new Map<number, CatalogSearchProduct>();
    const add = (items: CatalogSearchProduct[]) => { for (const item of items) if (found.size < limit && !found.has(item.id)) found.set(item.id, item); };

    // Current explicit code/name is always stronger than remembered context.
    if (!recommendationRequested) for (const term of currentTerms) add(await this.catalog.searchProducts(term, limit - found.size || 1));

    if (recommendationRequested && found.size < limit) {
      add(await this.catalog.recommendProducts({ query: currentTerms.at(-1) ?? null, color: entities.color, size: entities.size, minPrice: entities.minPrice, maxPrice: entities.maxPrice }, Math.min(limit, 5)));
    }

    const preferred = await this.catalog.getProductsWithAvailability(preferredProductIds.slice(0, limit));
    add(preferred.map((item) => item.product));

    for (const term of historyTerms) {
      if (found.size >= limit) break;
      add(await this.catalog.searchProducts(term, limit - found.size));
    }

    const resolvedAvailability = await this.catalog.getProductsWithAvailability([...found.keys()]);
    const withAvailability = entities.size
      ? resolvedAvailability.filter((item) => item.availability.sizes.some((size) => size.sizeName.toUpperCase() === entities.size && size.orderable))
      : resolvedAvailability.filter((item) => item.availability.sizes.some((size) => size.orderable));
    const term = currentTerms[0]?.toLowerCase();
    const ranked = currentTerms.length === 0 ? withAvailability : [...withAvailability].sort((a, b) => {
      const score = (item: AIProductContext) => {
        const product = item.product;
        let value = product.productCode.toLowerCase() === term ? 100 : product.productName.toLowerCase() === term ? 90 : 0;
        if (term && product.productCode.toLowerCase().includes(term)) value += 40;
        if (term && product.productName.toLowerCase().includes(term)) value += 30;
        if (entities.color && product.color?.toLowerCase().includes(entities.color)) value += 15;
        if (entities.size && item.availability?.sizes.some((size) => size.sizeName.toUpperCase() === entities.size && size.orderable)) value += 20;
        if (item.availability?.sizes.some((size) => size.orderable)) value += 10;
        return value;
      };
      return score(b) - score(a);
    });

    return { products: ranked.slice(0, Math.min(limit, 5)), searchPerformed: preferredProductIds.length > 0 || searchTerms.length > 0 || recommendationRequested, searchTerms, currentSearchTerms: currentTerms };
  }
}
