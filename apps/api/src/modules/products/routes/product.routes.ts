import type { FastifyInstance } from 'fastify';
import { AppError } from '../../../errors/app-error.js';
import { ProductCatalogService } from '../product-catalog.service.js';

interface SearchQuery {
  q?: string;
  limit?: string;
}

interface AvailabilityParams {
  websiteProductId: string;
}

export async function productRoutes(app: FastifyInstance): Promise<void> {
  const catalog = new ProductCatalogService(app.prisma);

  app.get<{ Querystring: SearchQuery }>('/api/products/search', async (request) => {
    const query = request.query.q?.trim() ?? '';
    if (!query) throw new AppError('Query parameter q is required', 400, 'INVALID_SEARCH_QUERY');

    const requestedLimit = request.query.limit ? Number(request.query.limit) : 10;
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
      throw new AppError('Query parameter limit must be a positive integer', 400, 'INVALID_SEARCH_LIMIT');
    }

    const products = await catalog.searchProducts(query, requestedLimit);
    return { success: true, count: products.length, products };
  });

  app.get<{ Params: AvailabilityParams }>(
    '/api/products/:websiteProductId/availability',
    async (request) => {
      const websiteProductId = Number(request.params.websiteProductId);
      if (!Number.isInteger(websiteProductId) || websiteProductId <= 0) {
        throw new AppError('Product ID must be a positive integer', 400, 'INVALID_PRODUCT_ID');
      }

      const availability = await catalog.getProductAvailability(websiteProductId);
      if (!availability) throw new AppError('Product not found', 404, 'PRODUCT_NOT_FOUND');
      return { success: true, product: availability };
    },
  );
}
