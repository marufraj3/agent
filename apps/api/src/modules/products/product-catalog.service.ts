import type { Prisma, PrismaClient } from '@alzeena/database';

export function isKnownActiveProductStatus(status: string): boolean {
  // The observed feed uses "1" for active. Unknown source values fail closed rather
  // than being incorrectly exposed as orderable.
  return status === '1';
}

export function isVariationOrderable(input: {
  stockQuantity: number;
  variationActive: boolean;
  productActive: boolean;
  isPreOrder: boolean;
}): boolean {
  return (
    input.productActive &&
    input.variationActive &&
    (input.stockQuantity > 0 || input.isPreOrder)
  );
}

export interface CatalogProductVariation {
  websiteVariationId: number;
  websiteSizeId: number;
  sizeName: string;
  stockQuantity: number;
  active: boolean;
}

export interface CatalogSearchProduct {
  id: number;
  internalId: string;
  productName: string;
  productCode: string;
  slug: string;
  productDetails: string | null;
  productStatus: string;
  active: boolean;
  sellPrice: string;
  discountPrice: string | null;
  flashSellPrice: string | null;
  isPreOrder: boolean;
  image: string | null;
  color: string | null;
  category: string | null;
  subCategory: string | null;
  variations: CatalogProductVariation[];
}

export type AvailabilityType = 'in_stock' | 'pre_order' | 'unavailable';

export interface CatalogProductWithAvailability {
  product: CatalogSearchProduct;
  availability: ProductAvailability;
}

export interface ProductAvailability {
  id: number;
  productName: string;
  productCode: string;
  productStatus: string;
  active: boolean;
  presentInFeed: boolean;
  isPreOrder: boolean;
  sizes: Array<{
    websiteVariationId: number;
    websiteSizeId: number;
    sizeName: string;
    stock: number;
    active: boolean;
    orderable: boolean;
    availabilityType: AvailabilityType;
  }>;
}

type ProductWithVariations = Prisma.ProductGetPayload<{ include: { variations: true } }>;

function toCatalogProduct(product: ProductWithVariations): CatalogSearchProduct {
  return {
    id: product.websiteProductId,
    internalId: product.id,
    productName: product.productName,
    productCode: product.productCode,
    slug: product.slug,
    productDetails: product.productDetails,
    productStatus: product.productStatus,
    active: isKnownActiveProductStatus(product.productStatus),
    sellPrice: product.sellPrice.toFixed(2),
    discountPrice: product.discountPrice?.toFixed(2) ?? null,
    flashSellPrice: product.flashSellPrice?.toFixed(2) ?? null,
    isPreOrder: product.isPreOrder,
    image: product.productImage,
    color: product.colorName,
    category: product.categoryName,
    subCategory: product.subCategoryName,
    variations: product.variations.map((variation) => ({
      websiteVariationId: variation.websiteVariationId,
      websiteSizeId: variation.websiteSizeId,
      sizeName: variation.sizeName,
      stockQuantity: variation.stockQuantity,
      active: variation.active,
    })),
  };
}

function toAvailability(product: ProductWithVariations): ProductAvailability {
  const productActive = product.presentInFeed && isKnownActiveProductStatus(product.productStatus);
  return {
    id: product.websiteProductId,
    productName: product.productName,
    productCode: product.productCode,
    productStatus: product.productStatus,
    active: productActive,
    presentInFeed: product.presentInFeed,
    isPreOrder: product.isPreOrder,
    sizes: product.variations.map((variation) => {
      const orderable = isVariationOrderable({
        stockQuantity: variation.stockQuantity,
        variationActive: variation.active,
        productActive,
        isPreOrder: product.isPreOrder,
      });
      const availabilityType: AvailabilityType = !orderable
        ? 'unavailable'
        : variation.stockQuantity > 0
          ? 'in_stock'
          : 'pre_order';
      return {
        websiteVariationId: variation.websiteVariationId,
        websiteSizeId: variation.websiteSizeId,
        sizeName: variation.sizeName,
        stock: variation.stockQuantity,
        active: variation.active,
        orderable,
        availabilityType,
      };
    }),
  };
}

export interface ProductRecommendationFilters {
  query?: string | null;
  color?: string | null;
  category?: string | null;
  subCategory?: string | null;
  minPrice?: number | null;
  maxPrice?: number | null;
  includePreOrder?: boolean;
}

export class ProductCatalogService {
  constructor(private readonly prisma: PrismaClient) {}

  async searchProducts(query: string, requestedLimit = 10): Promise<CatalogSearchProduct[]> {
    const normalizedQuery = query.trim().slice(0, 100);
    if (!normalizedQuery) return [];
    const limit = Math.min(Math.max(requestedLimit, 1), 50);

    const products = await this.prisma.product.findMany({
      where: {
        presentInFeed: true,
        OR: [
          { productName: { contains: normalizedQuery, mode: 'insensitive' } },
          { productCode: { contains: normalizedQuery, mode: 'insensitive' } },
          { slug: { contains: normalizedQuery, mode: 'insensitive' } },
          { productDetails: { contains: normalizedQuery, mode: 'insensitive' } },
          { colorName: { contains: normalizedQuery, mode: 'insensitive' } },
          { categoryName: { contains: normalizedQuery, mode: 'insensitive' } },
          { subCategoryName: { contains: normalizedQuery, mode: 'insensitive' } },
        ],
      },
      include: {
        variations: { orderBy: [{ active: 'desc' }, { websiteSizeId: 'asc' }] },
      },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });

    return products.map(toCatalogProduct);
  }

  async recommendProducts(filters: ProductRecommendationFilters, requestedLimit = 5): Promise<CatalogSearchProduct[]> {
    const limit = Math.min(Math.max(requestedLimit, 3), 5);
    const query = filters.query?.trim().slice(0, 100);
    const products = await this.prisma.product.findMany({
      where: {
        presentInFeed: true,
        ...(filters.color ? { colorName: { contains: filters.color, mode: 'insensitive' } } : {}),
        ...(filters.category ? { categoryName: { contains: filters.category, mode: 'insensitive' } } : {}),
        ...(filters.subCategory ? { subCategoryName: { contains: filters.subCategory, mode: 'insensitive' } } : {}),
        ...(filters.includePreOrder === false ? { isPreOrder: false } : {}),
        ...(query ? { OR: [
          { productName: { contains: query, mode: 'insensitive' } }, { productCode: { contains: query, mode: 'insensitive' } },
          { categoryName: { contains: query, mode: 'insensitive' } }, { subCategoryName: { contains: query, mode: 'insensitive' } },
        ] } : {}),
      },
      include: { variations: { orderBy: [{ active: 'desc' }, { stockQuantity: 'desc' }] } },
      orderBy: [{ updatedAt: 'desc' }],
      take: Math.min(limit * 4, 20),
    });
    const effectivePrice = (product: CatalogSearchProduct) => Number(product.flashSellPrice) > 0 ? Number(product.flashSellPrice) : Number(product.discountPrice) > 0 ? Number(product.discountPrice) : Number(product.sellPrice);
    const catalogProducts: CatalogSearchProduct[] = products.map(toCatalogProduct).filter((product: CatalogSearchProduct) =>
      (filters.minPrice == null || effectivePrice(product) >= filters.minPrice) &&
      (filters.maxPrice == null || effectivePrice(product) <= filters.maxPrice),
    );
    return catalogProducts.sort((a, b) => {
      const availability = (product: CatalogSearchProduct) => product.variations.some((item) => item.active && item.stockQuantity > 0) ? 2 : product.isPreOrder ? 1 : 0;
      const exactCode = (product: CatalogSearchProduct) => query && product.productCode.toLowerCase() === query.toLowerCase() ? 1 : 0;
      return exactCode(b) - exactCode(a) || availability(b) - availability(a) || effectivePrice(a) - effectivePrice(b);
    }).slice(0, limit);
  }

  async getProductByWebsiteId(websiteProductId: number): Promise<CatalogSearchProduct | null> {
    const product = await this.prisma.product.findUnique({
      where: { websiteProductId },
      include: {
        variations: { orderBy: [{ active: 'desc' }, { websiteSizeId: 'asc' }] },
      },
    });
    if (!product || !product.presentInFeed) return null;
    return toCatalogProduct(product);
  }

  async getProductsWithAvailability(
    websiteProductIds: number[],
  ): Promise<CatalogProductWithAvailability[]> {
    const ids = [...new Set(websiteProductIds)].slice(0, 20);
    if (ids.length === 0) return [];
    const products = await this.prisma.product.findMany({
      where: { websiteProductId: { in: ids }, presentInFeed: true },
      include: { variations: { orderBy: { websiteSizeId: 'asc' } } },
    });
    const byId = new Map(products.map((product) => [product.websiteProductId, product]));
    return ids.flatMap((id) => {
      const product = byId.get(id);
      return product
        ? [{ product: toCatalogProduct(product), availability: toAvailability(product) }]
        : [];
    });
  }

  async getProductAvailability(websiteProductId: number): Promise<ProductAvailability | null> {
    const product = await this.prisma.product.findUnique({
      where: { websiteProductId },
      include: { variations: { orderBy: { websiteSizeId: 'asc' } } },
    });

    if (!product) return null;
    return toAvailability(product);
  }
}
