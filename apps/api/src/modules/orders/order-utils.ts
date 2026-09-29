import { Prisma } from '@alzeena/database';
import { resolveEffectivePrice } from '../products/effective-price.js';
import { OrderEngineError } from './order.types.js';

export function normalizeBangladeshPhone(value: string): string {
  let digits = value.replace(/[^\d+]/g, '');
  if (digits.startsWith('+880')) digits = `0${digits.slice(4)}`;
  else if (digits.startsWith('880')) digits = `0${digits.slice(3)}`;
  digits = digits.replace(/\D/g, '');
  if (!/^01[3-9]\d{8}$/.test(digits)) {
    throw new OrderEngineError('A valid Bangladesh mobile number is required', 'INVALID_PHONE');
  }
  return digits;
}

export function getEffectiveProductPrice(product: {
  sellPrice: Prisma.Decimal;
  discountPrice: Prisma.Decimal | null;
  flashSellPrice: Prisma.Decimal | null;
}): Prisma.Decimal {
  const price = resolveEffectivePrice(product);
  if (price.greaterThanOrEqualTo(0)) return price;
  throw new OrderEngineError('Product price is invalid', 'INVALID_PRODUCT_PRICE');
}

export function money(value: Prisma.Decimal | string | number): Prisma.Decimal {
  return new Prisma.Decimal(value).toDecimalPlaces(2);
}
