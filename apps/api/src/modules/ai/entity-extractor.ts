import { z } from 'zod';
import { normalizeCustomerText, normalizeDigits } from './language-normalizer.js';

export const extractedEntitiesSchema = z.object({
  productCode: z.string().max(100).nullable().default(null),
  productName: z.string().max(255).nullable().default(null),
  size: z.enum(['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL']).nullable().default(null),
  color: z.string().trim().min(1).max(50).nullable().default(null),
  quantity: z.number().int().min(1).max(100).nullable().default(null),
  minPrice: z.number().nonnegative().nullable().default(null),
  maxPrice: z.number().nonnegative().nullable().default(null),
  customerName: z.string().max(255).nullable().default(null),
  phone: z.string().max(20).nullable().default(null),
  address: z.string().max(2_000).nullable().default(null),
  deliveryLocation: z.enum(['DHAKA', 'OUTSIDE_DHAKA']).nullable().default(null),
  ordinalReference: z.number().int().min(1).max(10).nullable().default(null),
  correction: z.boolean().default(false),
  requestedFollowUp: z.boolean().default(false),
}).strict();
export type ExtractedEntities = z.infer<typeof extractedEntitiesSchema>;

const numberWords: Record<string, number> = { one: 1, ekta: 1, ek: 1, 'একটা': 1, 'এক': 1, duita: 2, dui: 2, 'দুইটা': 2, 'দুই': 2, tin: 3, tinta: 3, 'তিন': 3, 'তিনটা': 3 };
const sizeMap: Record<string, ExtractedEntities['size']> = { medium: 'M', large: 'L', 'extra large': 'XL', 'xx-large': 'XXL', '2xl': 'XXL', '3xl': 'XXXL' };
const colorMap: Record<string, ExtractedEntities['color']> = { 'কালো': 'black', kalo: 'black', black: 'black', 'সাদা': 'white', sada: 'white', white: 'white', 'লাল': 'red', lal: 'red', red: 'red', 'নীল': 'blue', nil: 'blue', blue: 'blue', 'সবুজ': 'green', sobuj: 'green', green: 'green', navy: 'navy', gray: 'gray', grey: 'gray', yellow: 'yellow' };

export function extractEntities(message: string): ExtractedEntities {
  const original = normalizeDigits(message);
  const normalized = normalizeCustomerText(original);
  const code = original.match(/\b[A-Za-z]{2,}\s*-?\s*\d+[A-Za-z0-9-]*\b/)?.[0]?.replace(/\s|-/g, '').toUpperCase() ?? null;
  let size: ExtractedEntities['size'] = null;
  for (const [phrase, value] of Object.entries(sizeMap)) if (normalized.includes(phrase)) size = value;
  const directSize = [...normalized.matchAll(/(?:size\s*)?\b(xxxl|xxl|xl|xs|s|m|l)\b(?:\s*size)?/gi)].at(-1)?.[1];
  if (directSize) size = directSize.toUpperCase() as ExtractedEntities['size'];
  let color: ExtractedEntities['color'] = null;
  for (const [word, value] of Object.entries(colorMap)) if (new RegExp(`(^|\\s)${word}(\\s|$)`, 'iu').test(normalized)) { color = value; break; }
  color ??= normalized.match(/(?:color|colour)\s*[:\-]?\s*([\p{L}-]{2,30})/iu)?.[1] ?? null;
  const explicitQuantity = normalized.match(/(?:^|\s)(\d{1,3})\s*(?:ta|টা|টি|pcs?|pieces?|jor|জোড়া)(?:\s|[,;]|$)/i)?.[1];
  let quantity = explicitQuantity ? Number(explicitQuantity) : null;
  if (!quantity) for (const [word, value] of Object.entries(numberWords)) if (new RegExp(`(^|\\s)${word}(?:\\s*(?:ta|টা|টি|pcs?|pieces?|জোড়া))?(\\s|$)`, 'iu').test(normalized)) { quantity = value; break; }
  const range = normalized.match(/(?<!\d)(?:৳|tk|taka)?\s*([1-9]\d{1,5})\s*(?:-|to|থেকে)\s*(?:৳|tk|taka)?\s*([1-9]\d{1,5})(?!\d)/i);
  const maxOnly = normalized.match(/(?:৳|tk|taka)?\s*(\d+(?:\.\d+)?)\s*(k)?\s*(?:er moddhe|max|budget|এর মধ্যে)/i)
    ?? normalized.match(/(?:under|within|budget|সর্বোচ্চ|মধ্যে)\s*(?:৳|tk|taka)?\s*(\d+(?:\.\d+)?)\s*(k)?/i);
  let minPrice = range ? Number(range[1]) : null; let maxPrice = range ? Number(range[2]) : null;
  if (!maxPrice && maxOnly) maxPrice = Number(maxOnly[1]) * (maxOnly[2] ? 1_000 : 1);
  const phone = original.replace(/[\s-]/g, '').match(/(?:\+?880|0)?1[3-9]\d{8}/)?.[0] ?? null;
  const customerName = original.match(/(?:name|naam|নাম)\s*[:\-]?\s*([^,\n;]{2,80})/i)?.[1]?.trim() ?? null;
  const address = original.match(/(?:address|ঠিকানা)\s*[:\-]?\s*(.+?)(?=\s*;|\s*[,\n]\s*(?:phone|mobile|ফোন|name|নাম|location|লোকেশন)\s*[:\-]|$)/i)?.[1]?.trim() ?? null;
  const namedProduct = original.match(/(?:product|item|পণ্য)\s*(?:name)?\s*[:#\-]?\s*([\p{L}][\p{L}\p{N} ._-]{2,80})/iu)?.[1]?.trim() ?? null;
  const ordinal = normalized.match(/\b(1st|first|প্রথম)\b/i) ? 1 : normalized.match(/\b(2nd|second|দ্বিতীয়)\b/i) ? 2 : normalized.match(/\b(3rd|third|তৃতীয়)\b/i) ? 3 : null;
  const deliveryLocation = /outside\s*dhaka|ঢাকার বাইরে/i.test(normalized) ? 'OUTSIDE_DHAKA' : /dhaka|ঢাকা|mohammadpur|মোহাম্মদপুর/i.test(normalized) ? 'DHAKA' : null;
  const correction = /bodole|instead|change|পরিবর্তন|বদলে|হবে/i.test(normalized);
  const requestedFollowUp = /(?:মনে করিয়ে|জানাবেন|follow.?up|remind|পরে order|পরে অর্ডার)/iu.test(original);
  return extractedEntitiesSchema.parse({ productCode: code, productName: namedProduct, size, color, quantity, minPrice, maxPrice, customerName, phone, address, deliveryLocation, ordinalReference: ordinal, correction, requestedFollowUp });
}
