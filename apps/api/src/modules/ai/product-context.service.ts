import type {
  CatalogSearchProduct,
  ProductAvailability,
  ProductCatalogService,
} from '../products/product-catalog.service.js';
import type { ConversationMessage } from './ai.types.js';

export interface AIProductContext {
  product: CatalogSearchProduct;
  availability: ProductAvailability | null;
}

export interface ProductContextResult {
  products: AIProductContext[];
  searchPerformed: boolean;
  searchTerms: string[];
  currentSearchTerms: string[];
}

const STOP_WORDS = new Set([
  'ache',
  'ase',
  'available',
  'product',
  'koto',
  'price',
  'stock',
  'size',
  'polo',
  'shirt',
  'please',
  'vai',
  'bhai',
  'this',
  'that',
  'have',
  'want',
]);
const SIZE_WORDS = new Set(['xs', 's', 'm', 'l', 'xl', 'xxl', 'xxxl']);

export function extractProductSearchTerms(message: string): string[] {
  const terms: string[] = [];
  const codes = message.match(/\b[A-Za-z]{2,}\s*-?\s*\d+[A-Za-z0-9-]*\b/g) ?? [];
  terms.push(...codes.map((code) => code.replace(/\s+/g, '').trim()));

  const words = message.match(/[A-Za-z][A-Za-z0-9-]{2,}/g) ?? [];
  terms.push(
    ...words.filter((word) => {
      const normalized = word.toLowerCase();
      return !STOP_WORDS.has(normalized) && !SIZE_WORDS.has(normalized) && !/^\d+$/.test(normalized);
    }),
  );

  return [...new Set(terms.map((term) => term.trim()).filter(Boolean))].slice(0, 8);
}

export class ProductContextService {
  constructor(private readonly catalog: ProductCatalogService) {}

  async findRelevantProducts(
    message: string,
    history: ConversationMessage[],
    limit: number,
    preferredProductIds: number[] = [],
  ): Promise<ProductContextResult> {
    const currentTerms = extractProductSearchTerms(message);
    const historyTerms = history
      .slice(-6)
      .reverse()
      .flatMap((item) => extractProductSearchTerms(item.content));
    const searchTerms = [...new Set([...currentTerms, ...historyTerms])].slice(0, 10);
    const found = new Map<number, CatalogSearchProduct>();
    const preferred = await this.catalog.getProductsWithAvailability(
      preferredProductIds.slice(0, limit),
    );
    for (const item of preferred) found.set(item.product.id, item.product);

    for (const term of searchTerms) {
      const remaining = limit - found.size;
      if (remaining <= 0) break;
      const products = await this.catalog.searchProducts(term, remaining);
      for (const product of products) {
        if (!found.has(product.id)) found.set(product.id, product);
        if (found.size >= limit) break;
      }
    }

    const products = await this.catalog.getProductsWithAvailability([...found.keys()]);

    return {
      products,
      searchPerformed: preferredProductIds.length > 0 || searchTerms.length > 0,
      searchTerms,
      currentSearchTerms: currentTerms,
    };
  }
}
