import { Prisma } from '@alzeena/database';

export type PriceValue = string | Prisma.Decimal;

function isPositive(value: PriceValue | null): value is PriceValue {
  if (value === null) return false;
  return new Prisma.Decimal(value).greaterThan(0);
}

/** The single pricing rule used by customer responses and persisted orders. */
export function resolveEffectivePrice<T extends PriceValue>(product: {
  sellPrice: T;
  discountPrice: T | null;
  flashSellPrice: T | null;
}): T {
  if (isPositive(product.flashSellPrice)) return product.flashSellPrice as T;
  if (isPositive(product.discountPrice)) return product.discountPrice as T;
  return product.sellPrice;
}
