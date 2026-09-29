import { Prisma, type PrismaClient } from '@alzeena/database';
import { parseProductFeedItem, type ProductFeedProduct } from './product-feed.schemas.js';
import {
  ProductFeedResponseError,
  type ProductFeedClient,
} from './product-feed.client.js';

export interface ProductSyncProgress {
  pagesProcessed: number;
  productsProcessed: number;
  productsCreated: number;
  productsUpdated: number;
  variationsProcessed: number;
  errors: number;
}

export interface ProductSyncResult extends ProductSyncProgress {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  markedMissing: number;
  paginated: boolean;
}

interface SyncLogger {
  info(bindings: object, message?: string): void;
  warn(bindings: object, message?: string): void;
  error(bindings: object, message?: string): void;
}

interface ProductSyncServiceOptions {
  prisma: PrismaClient;
  feedClient: ProductFeedClient;
  logger: SyncLogger;
  jobId?: string;
  onProgress?: (progress: ProductSyncProgress) => Promise<void> | void;
}

interface SyncError {
  websiteProductId?: number;
  message: string;
}

function optionalUpdate<T>(value: T | undefined, key: string): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

function serializeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown synchronization error';
}

export class ProductSyncService {
  constructor(private readonly options: ProductSyncServiceOptions) {}

  async synchronize(): Promise<ProductSyncResult> {
    const startedAt = new Date();
    const progress: ProductSyncProgress = {
      pagesProcessed: 0,
      productsProcessed: 0,
      productsCreated: 0,
      productsUpdated: 0,
      variationsProcessed: 0,
      errors: 0,
    };
    const errors: SyncError[] = [];
    let paginated = false;

    await this.options.prisma.systemLog.create({
      data: {
        level: 'INFO',
        type: 'PRODUCT_SYNC_STARTED',
        message: 'Product feed synchronization started',
        metadata: {
          status: 'started',
          startedAt: startedAt.toISOString(),
          ...(this.options.jobId ? { jobId: this.options.jobId } : {}),
        },
      },
    });

    this.options.logger.info({ jobId: this.options.jobId }, 'Product synchronization started');

    try {
      for await (const page of this.options.feedClient.pages()) {
        paginated ||= page.isPaginated;
        const parsedProducts: ProductFeedProduct[] = [];

        for (const item of page.items) {
          const parsed = parseProductFeedItem(item);
          if (!parsed.success) {
            progress.errors += 1;
            this.rememberError(errors, {
              websiteProductId: parsed.websiteProductId,
              message: parsed.error,
            });
            continue;
          }

          if (parsed.product.validationErrors.length > 0) {
            progress.errors += parsed.product.validationErrors.length;
            for (const message of parsed.product.validationErrors) {
              this.rememberError(errors, {
                websiteProductId: parsed.product.websiteProductId,
                message,
              });
            }
          }

          parsedProducts.push(parsed.product);
        }

        const existingProducts = await this.options.prisma.product.findMany({
          where: { websiteProductId: { in: parsedProducts.map((product) => product.websiteProductId) } },
          select: { websiteProductId: true },
        });
        const existingIds = new Set(existingProducts.map((product) => product.websiteProductId));

        for (const product of parsedProducts) {
          try {
            await this.synchronizeProduct(product, startedAt);
            progress.productsProcessed += 1;
            progress.variationsProcessed += product.variations.length;
            if (existingIds.has(product.websiteProductId)) {
              progress.productsUpdated += 1;
            } else {
              progress.productsCreated += 1;
            }
          } catch (error) {
            progress.errors += 1;
            const message = serializeError(error);
            this.rememberError(errors, { websiteProductId: product.websiteProductId, message });
            this.options.logger.warn(
              { err: error, websiteProductId: product.websiteProductId },
              'Product synchronization item failed',
            );
          }
        }

        progress.pagesProcessed += 1;
        await this.options.onProgress?.({ ...progress });
      }

      if (progress.pagesProcessed === 0 || progress.productsProcessed === 0) {
        throw new ProductFeedResponseError(
          'Product feed contained no valid products; refusing to mark the catalogue missing',
        );
      }

      // Mark missing products only after a complete, validation-clean snapshot. A partial or
      // malformed feed must never make otherwise valid catalogue records unavailable.
      const markedMissing =
        progress.errors === 0
          ? (
              await this.options.prisma.product.updateMany({
                where: {
                  OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: startedAt } }],
                  presentInFeed: true,
                },
                data: { presentInFeed: false, missingFromFeedAt: new Date() },
              })
            ).count
          : 0;

      const completedAt = new Date();
      const result: ProductSyncResult = {
        ...progress,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
        markedMissing,
        paginated,
      };

      const completionMetadata: Prisma.InputJsonObject = {
        status: 'completed',
        ...result,
        errorDetails: errors.map(({ websiteProductId, message }) =>
          websiteProductId === undefined ? { message } : { websiteProductId, message },
        ),
        ...(this.options.jobId ? { jobId: this.options.jobId } : {}),
      };

      await this.options.prisma.systemLog.create({
        data: {
          level: progress.errors > 0 ? 'WARN' : 'INFO',
          type: 'PRODUCT_SYNC_COMPLETED',
          message:
            progress.errors > 0
              ? 'Product feed synchronization completed with item errors'
              : 'Product feed synchronization completed',
          metadata: completionMetadata,
        },
      });

      this.options.logger.info({ ...result, jobId: this.options.jobId }, 'Product synchronization completed');
      return result;
    } catch (error) {
      const completedAt = new Date();
      const durationMs = completedAt.getTime() - startedAt.getTime();
      const message = serializeError(error);

      await this.options.prisma.systemLog
        .create({
          data: {
            level: 'ERROR',
            type: 'PRODUCT_SYNC_FAILED',
            message: 'Product feed synchronization failed',
            metadata: {
              status: 'failed',
              startedAt: startedAt.toISOString(),
              completedAt: completedAt.toISOString(),
              durationMs,
              ...progress,
              error: message,
              ...(this.options.jobId ? { jobId: this.options.jobId } : {}),
            },
          },
        })
        .catch((logError: unknown) => {
          this.options.logger.error({ err: logError }, 'Could not persist product sync failure log');
        });

      this.options.logger.error({ err: error, jobId: this.options.jobId }, 'Product synchronization failed');
      throw error;
    }
  }

  private async synchronizeProduct(product: ProductFeedProduct, synchronizedAt: Date): Promise<void> {
    await this.options.prisma.$transaction(async (transaction) => {
      if (product.categoryId !== null) {
        await transaction.category.upsert({
          where: { websiteCategoryId: product.categoryId },
          create: { websiteCategoryId: product.categoryId, name: product.categoryName ?? null },
          update: optionalUpdate(product.categoryName, 'name'),
        });
      }

      const canReferenceSubCategory = product.subCategoryId !== null && product.categoryId !== null;
      if (canReferenceSubCategory) {
        const category = await transaction.category.findUniqueOrThrow({
          where: { websiteCategoryId: product.categoryId! },
          select: { id: true },
        });
        await transaction.subCategory.upsert({
          where: { websiteSubCategoryId: product.subCategoryId! },
          create: {
            websiteSubCategoryId: product.subCategoryId!,
            name: product.subCategoryName ?? null,
            categoryRecordId: category.id,
          },
          update: {
            categoryRecordId: category.id,
            ...optionalUpdate(product.subCategoryName, 'name'),
          },
        });
      }

      const categoryId = product.categoryId;
      const subCategoryId = canReferenceSubCategory ? product.subCategoryId : null;
      const commonData = {
        productName: product.productName,
        productCode: product.productCode,
        slug: product.slug,
        categoryId,
        subCategoryId,
        productStatus: product.productStatus,
        sellPrice: product.sellPrice,
        discountPrice: product.discountPrice,
        flashSellPrice: product.flashSellPrice,
        isPreOrder: product.isPreOrder,
        lastSyncedAt: synchronizedAt,
        presentInFeed: true,
        missingFromFeedAt: null,
      };

      const savedProduct = await transaction.product.upsert({
        where: { websiteProductId: product.websiteProductId },
        create: {
          websiteProductId: product.websiteProductId,
          ...commonData,
          productDetails: product.productDetails ?? null,
          productImage: product.productImage ?? null,
          categoryName: product.categoryName ?? null,
          subCategoryName: product.subCategoryName ?? null,
          colorName: product.colorName ?? null,
        },
        update: {
          ...commonData,
          ...optionalUpdate(product.productDetails, 'productDetails'),
          ...optionalUpdate(product.productImage, 'productImage'),
          ...optionalUpdate(product.categoryName, 'categoryName'),
          ...optionalUpdate(product.subCategoryName, 'subCategoryName'),
          ...optionalUpdate(product.colorName, 'colorName'),
        },
        select: { id: true },
      });

      for (const variation of product.variations) {
        await transaction.productVariation.upsert({
          where: { websiteVariationId: variation.websiteVariationId },
          create: {
            ...variation,
            productId: savedProduct.id,
            lastSyncedAt: synchronizedAt,
          },
          update: {
            ...variation,
            productId: savedProduct.id,
            lastSyncedAt: synchronizedAt,
          },
        });
      }

      if (product.variationsComplete) {
        const currentVariationIds = product.variations.map((variation) => variation.websiteVariationId);
        await transaction.productVariation.updateMany({
          where: {
            productId: savedProduct.id,
            ...(currentVariationIds.length > 0
              ? { websiteVariationId: { notIn: currentVariationIds } }
              : {}),
          },
          data: { active: false, stockQuantity: 0, lastSyncedAt: synchronizedAt },
        });
      }
    });
  }

  private rememberError(errors: SyncError[], error: SyncError): void {
    if (errors.length < 100) errors.push(error);
  }
}
