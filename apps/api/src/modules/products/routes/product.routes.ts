import type { FastifyInstance } from "fastify";
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

  app.get<{ Querystring: SearchQuery }>(
    "/api/products/search",
    async (request) => {
      const query = request.query.q?.trim() ?? "";
      if (!query)
        throw new AppError(
          "Query parameter q is required",
          400,
          "INVALID_SEARCH_QUERY",
        );

      const requestedLimit = request.query.limit
        ? Number(request.query.limit)
        : 10;
      if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
        throw new AppError(
          "Query parameter limit must be a positive integer",
          400,
          "INVALID_SEARCH_LIMIT",
        );
      }

      const products = await catalog.searchProducts(query, requestedLimit);
      return { success: true, count: products.length, products };
    },
  );

  app.get(
    "/api/admin/products",
    { preHandler: requireAdmin },
    async (request) => {
      const query = request.query as Record<string, string | undefined>;
      const page = Math.max(1, Number(query.page) || 1);
      const limit = Math.min(100, Math.max(1, Number(query.limit) || 25));
      const search = query.search?.trim();
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

      const availability =
        await catalog.getProductAvailability(websiteProductId);
      if (!availability)
        throw new AppError("Product not found", 404, "PRODUCT_NOT_FOUND");
      return { success: true, product: availability };
    },
  );
}
