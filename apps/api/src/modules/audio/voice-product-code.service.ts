import type { ProductCatalogService } from '../products/product-catalog.service.js';

export interface VoiceCodeNormalization {
  normalizedText: string;
  verifiedCodes: string[];
  productIds: number[];
}

const numberValues: Record<string, number> = {
  zero: 0,
  oh: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const numberPattern = Object.keys(numberValues).join('|');
const spokenCodePattern = new RegExp(
  `\\b((?:[A-Za-z]\\s+){1,4}|[A-Za-z]{2,5})\\s*((?:${numberPattern}|hundred|\\d+)(?:[\\s-]+(?:${numberPattern}|hundred|\\d+)){0,4})\\b`,
  'gi',
);

function numberFromWords(value: string): string | null {
  const parts = value.toLowerCase().split(/[\s-]+/).filter(Boolean);
  if (parts.length === 1 && /^\d+$/.test(parts[0]!)) return parts[0]!;
  if (parts.includes('hundred')) {
    let total = 0;
    let current = 0;
    for (const part of parts) {
      if (/^\d+$/.test(part)) current += Number(part);
      else if (part === 'hundred') current = Math.max(current, 1) * 100;
      else if (numberValues[part] !== undefined) current += numberValues[part];
      else return null;
    }
    total += current;
    return total > 0 ? String(total) : null;
  }
  const values = parts.map((part) =>
    /^\d+$/.test(part) ? Number(part) : numberValues[part],
  );
  if (values.some((value) => value === undefined)) return null;
  let output = '';
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    const next = values[index + 1];
    if (value >= 20 && value <= 90 && value % 10 === 0 && next !== undefined && next < 10) {
      output += String(value + next);
      index += 1;
    } else {
      output += String(value);
    }
  }
  return output || null;
}

function codeTokens(value: string): string[] {
  return (
    value
      .match(/\b[A-Za-z]{2,5}\s*-?\s*\d+[A-Za-z0-9-]*\b/g)
      ?.map((code) => code.toUpperCase().replace(/[\s-]+/g, '')) ?? []
  );
}

export class VoiceProductCodeService {
  constructor(private readonly catalog: ProductCatalogService) {}

  async normalize(transcription: string): Promise<VoiceCodeNormalization> {
    const spoken: Array<{ raw: string; candidate: string }> = [];
    for (const match of transcription.matchAll(spokenCodePattern)) {
      const prefix = match[1]?.replace(/\s+/g, '').toUpperCase();
      const number = numberFromWords(match[2] ?? '');
      if (prefix && prefix.length >= 2 && number) spoken.push({ raw: match[0], candidate: `${prefix}${number}` });
    }
    const literal = codeTokens(transcription);
    const requested = [...new Set([...literal, ...spoken.map((item) => item.candidate)])].slice(0, 10);
    const verifiedCodes: string[] = [];
    const productIds: number[] = [];

    for (const candidate of requested) {
      const products = await this.catalog.searchProducts(candidate, 5);
      const exact = products.find((product) =>
        codeTokens(`${product.productCode} ${product.productName}`).includes(candidate),
      );
      if (!exact) continue;
      verifiedCodes.push(candidate);
      productIds.push(exact.id);
    }

    let normalizedText = transcription;
    for (const item of spoken) {
      if (verifiedCodes.includes(item.candidate)) {
        normalizedText = normalizedText.replace(item.raw, item.candidate);
      }
    }
    return {
      normalizedText,
      verifiedCodes: [...new Set(verifiedCodes)],
      productIds: [...new Set(productIds)],
    };
  }
}
