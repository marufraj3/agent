import { createHash } from 'node:crypto';
import type { FastifyInstance } from "fastify";
import { env } from '../../../config/env.js';
import { AppError } from "../../../errors/app-error.js";
import { requireAdmin } from "../../admin/auth/require-admin.js";
import { ProductCatalogService } from "../product-catalog.service.js";

interface SearchQuery {
  q?: string;
  limit?: string;
}

interface AvailabilityParams {
  websiteProductId: string;
}

export async function productRoutes(app: FastifyInstance): Promise<void> {
  const catalog = new ProductCatalogService(app.prisma);
  async function cached<T>(scope: string, identity: string, loader: () => Promise<T>): Promise<T> {
    const version = (await app.redis.get('product:cache:version').catch(() => null)) ?? '0';
    const digest = createHash('sha256').update(identity).digest('hex');
    const key = `cache:product:${version}:${scope}:${digest}`;
    const hit = await app.redis.get(key).catch(() => null);
    if (hit) {
      try {
        return JSON.parse(hit) as T;
      } catch {
        await app.redis.del(key).catch(() => undefined);
      }
    }
    const value = await loader();
    await app.redis
      .set(key, JSON.stringify(value), 'EX', env.PRODUCT_CACHE_TTL_SECONDS)
      .catch(() => undefined);
    return value;
  }

  app.get<{ Querystring: SearchQuery }>(
    "/api/products/search",
    async (request) => {
      const query = request.query.q?.trim() ?? "";
      if (!query || query.length > 200)
        throw new AppError(
          "Query parameter q is required",
          400,
          "INVALID_SEARCH_QUERY",
        );

      const requestedLimit = request.query.limit
        ? Number(request.query.limit)
        : 10;
      if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 50) {
        throw new AppError(
          "Query parameter limit must be a positive integer",
          400,
          "INVALID_SEARCH_LIMIT",
        );
      }

      const products = await cached('search', `${query.toLowerCase()}:${requestedLimit}`, () => catalog.searchProducts(query, requestedLimit));
      return { success: true, count: products.length, products };
    },
  );

  app.get(
    "/api/admin/products",
    { preHandler: requireAdmin },
    async (request) => {
      const query = request.query as Record<string, string | undefined>;
      const page = Number(query.page ?? 1);
      const limit = Number(query.limit ?? 25);
      const search = query.search?.trim();
      if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new AppError('Invalid product pagination', 400, 'VALIDATION_ERROR');
      }
      if (search && search.length > 200) {
        throw new AppError('Product search is too long', 400, 'VALIDATION_ERROR');
      }
      const filter = query.filter ?? "all";
      if (
        ![
          "all",
          "active",
          "inactive",
          "preorder",
          "out_of_stock",
          "low_stock",
        ].includes(filter)
      )
        throw new AppError("Invalid product filter", 400, "VALIDATION_ERROR");
      const conditions: any[] = [];
      if (search)
        conditions.push({
          OR: [
            { productName: { contains: search, mode: "insensitive" } },
            { productCode: { contains: search, mode: "insensitive" } },
            { categoryName: { contains: search, mode: "insensitive" } },
          ],
        });
      if (filter === "active")
        conditions.push({
          presentInFeed: true,
          productStatus: { in: ["1", "active"] },
        });
      if (filter === "inactive")
        conditions.push({
          OR: [
            { presentInFeed: false },
            { productStatus: { notIn: ["1", "active"] } },
          ],
        });
      if (filter === "preorder") conditions.push({ isPreOrder: true });
      if (filter === "out_of_stock")
        conditions.push({
          isPreOrder: false,
          variations: { none: { active: true, stockQuantity: { gt: 0 } } },
        });
      if (filter === "low_stock")
        conditions.push({
          variations: {
            some: { active: true, stockQuantity: { gt: 0, lte: 5 } },
          },
        });
      const base: any = conditions.length ? { AND: conditions } : {};
      const db = app.prisma as any;
      const [items, total] = await Promise.all([
        db.product.findMany({
          where: base,
          include: {
            variations: {
              where: { active: true },
              select: { stockQuantity: true },
            },
          },
          orderBy: { lastSyncedAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        db.product.count({ where: base }),
      ]);
      return {
        success: true,
        data: {
          items: items.map((item: any) => ({
            ...item,
            totalStock: item.variations.reduce(
              (sum: number, variation: any) => sum + variation.stockQuantity,
              0,
            ),
          })),
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/admin/products/:id",
    { preHandler: requireAdmin },
    async (request) => {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.params.id)) {
        throw new AppError('Invalid product ID', 400, 'VALIDATION_ERROR');
      }
      const db = app.prisma as any;
      const product = await db.product.findUnique({
        where: { id: request.params.id },
        include: {
          variations: { orderBy: { sizeName: "asc" } },
          category: true,
          subCategory: true,
        },
      });
      if (!product)
        throw new AppError("Product not found", 404, "PRODUCT_NOT_FOUND");
      return { success: true, data: product };
    },
  );

  app.get<{ Params: AvailabilityParams }>(
    "/api/products/:websiteProductId/availability",
    async (request) => {
      const websiteProductId = Number(request.params.websiteProductId);
      if (!Number.isInteger(websiteProductId) || websiteProductId <= 0) {
        throw new AppError(
          "Product ID must be a positive integer",
          400,
          "INVALID_PRODUCT_ID",
        );
      }

      const availability = await cached('availability', String(websiteProductId), () => catalog.getProductAvailability(websiteProductId));
      if (!availability)
        throw new AppError("Product not found", 404, "PRODUCT_NOT_FOUND");
      return { success: true, product: availability };
    },
  );
}
