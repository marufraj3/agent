import { z } from 'zod';

const integerSchema = z.union([
  z.number().int(),
  z.string().regex(/^\d+$/).transform(Number),
]);

const nullableIntegerSchema = z.preprocess(
  (value) => (value === '' || value === undefined ? null : value),
  integerSchema.nullable(),
);

const moneySchema = z
  .union([z.string(), z.number().finite()])
  .transform((value) => String(value))
  .pipe(z.string().regex(/^\d+(?:\.\d+)?$/, 'Expected a non-negative decimal value'));

const nullableMoneySchema = z.preprocess(
  (value) => (value === '' || value === undefined ? null : value),
  moneySchema.nullable(),
);

const booleanSchema = z
  .union([z.boolean(), z.literal(0), z.literal(1), z.literal('0'), z.literal('1')])
  .transform((value) => value === true || value === 1 || value === '1');

const statusSchema = z.union([z.string(), z.number()]).transform(String);

const optionalTextSchema = z.preprocess(
  (value) => (value === '' || value === undefined ? null : value),
  z.string().nullable(),
);

const variationSchema = z
  .object({
    id: integerSchema,
    product_id: integerSchema,
    active: booleanSchema,
    product_size_id: integerSchema,
    pro_qty: integerSchema.refine((quantity) => quantity >= 0, 'Stock cannot be negative'),
    size: z
      .object({
        id: integerSchema,
        size_name: z.string().trim().min(1),
      })
      .passthrough(),
  })
  .passthrough();

const productSchema = z
  .object({
    id: integerSchema,
    product_name: z.string().trim().min(1),
    product_code: z.string().trim().min(1),
    slug: z.string().trim().min(1),
    product_details: optionalTextSchema.optional(),
    product_image: optionalTextSchema.optional(),
    product_category_id: nullableIntegerSchema,
    product_sub_category_id: nullableIntegerSchema,
    product_category_name: optionalTextSchema.optional(),
    product_sub_category_name: optionalTextSchema.optional(),
    color_name: optionalTextSchema.optional(),
    product_status: statusSchema,
    sell_price: moneySchema,
    discount_price: nullableMoneySchema,
    flash_sell_price: nullableMoneySchema,
    is_pre_order: booleanSchema,
    details: z.array(z.unknown()).optional(),
  })
  .passthrough();

export interface ProductFeedVariation {
  websiteVariationId: number;
  websiteSizeId: number;
  sizeName: string;
  stockQuantity: number;
  active: boolean;
}

export interface ProductFeedProduct {
  websiteProductId: number;
  productName: string;
  productCode: string;
  slug: string;
  productDetails?: string | null;
  productImage?: string | null;
  categoryId: number | null;
  categoryName?: string | null;
  subCategoryId: number | null;
  subCategoryName?: string | null;
  colorName?: string | null;
  productStatus: string;
  sellPrice: string;
  discountPrice: string | null;
  flashSellPrice: string | null;
  isPreOrder: boolean;
  variations: ProductFeedVariation[];
  variationsComplete: boolean;
  validationErrors: string[];
}

export type ProductParseResult =
  | { success: true; product: ProductFeedProduct }
  | { success: false; error: string; websiteProductId?: number };

function summarizeZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || 'product'}: ${issue.message}`)
    .join('; ');
}

export function parseProductFeedItem(input: unknown): ProductParseResult {
  const parsedProduct = productSchema.safeParse(input);
  const possibleId =
    typeof input === 'object' && input !== null && 'id' in input && typeof input.id === 'number'
      ? input.id
      : undefined;

  if (!parsedProduct.success) {
    return {
      success: false,
      error: summarizeZodError(parsedProduct.error),
      websiteProductId: possibleId,
    };
  }

  const source = parsedProduct.data;
  const variations: ProductFeedVariation[] = [];
  const validationErrors: string[] = [];
  let variationsComplete = Array.isArray(source.details);

  for (const [index, detail] of (source.details ?? []).entries()) {
    const parsedVariation = variationSchema.safeParse(detail);

    if (!parsedVariation.success) {
      variationsComplete = false;
      validationErrors.push(`details.${index}: ${summarizeZodError(parsedVariation.error)}`);
      continue;
    }

    if (parsedVariation.data.product_id !== source.id) {
      variationsComplete = false;
      validationErrors.push(
        `details.${index}.product_id: expected ${source.id}, received ${parsedVariation.data.product_id}`,
      );
      continue;
    }

    if (parsedVariation.data.size.id !== parsedVariation.data.product_size_id) {
      variationsComplete = false;
      validationErrors.push(
        `details.${index}.size.id: does not match product_size_id ${parsedVariation.data.product_size_id}`,
      );
      continue;
    }

    variations.push({
      websiteVariationId: parsedVariation.data.id,
      websiteSizeId: parsedVariation.data.product_size_id,
      sizeName: parsedVariation.data.size.size_name,
      stockQuantity: parsedVariation.data.pro_qty,
      active: parsedVariation.data.active,
    });
  }

  return {
    success: true,
    product: {
      websiteProductId: source.id,
      productName: source.product_name,
      productCode: source.product_code,
      slug: source.slug,
      productDetails: source.product_details,
      productImage: source.product_image,
      categoryId: source.product_category_id,
      categoryName: source.product_category_name,
      subCategoryId: source.product_sub_category_id,
      subCategoryName: source.product_sub_category_name,
      colorName: source.color_name,
      productStatus: source.product_status,
      sellPrice: source.sell_price,
      discountPrice: source.discount_price,
      flashSellPrice: source.flash_sell_price,
      isPreOrder: source.is_pre_order,
      variations,
      variationsComplete,
      validationErrors,
    },
  };
}
