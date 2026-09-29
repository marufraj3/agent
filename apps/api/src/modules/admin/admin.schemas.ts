import { z } from 'zod';

export const MAX_KNOWLEDGE_BASE_LENGTH = 100_000;

export const knowledgeBaseUpdateSchema = z
  .object({
    content: z
      .string()
      .max(
        MAX_KNOWLEDGE_BASE_LENGTH,
        `Knowledge Base cannot exceed ${MAX_KNOWLEDGE_BASE_LENGTH} characters`,
      )
      .refine((content) => content.trim().length > 0, 'Knowledge Base content cannot be empty'),
  })
  .strict();

const deliveryChargeSchema = z
  .union([z.string(), z.number().nonnegative().finite()])
  .transform(String)
  .pipe(
    z
      .string()
      .trim()
      .regex(/^\d{1,7}(?:\.\d{1,2})?$/, 'Expected a non-negative BDT amount with up to 2 decimals'),
  )
  .transform((value) => {
    const [whole, decimal] = value.split('.');
    const normalizedWhole = BigInt(whole!).toString();
    const normalizedDecimal = decimal?.replace(/0+$/, '');
    return normalizedDecimal ? `${normalizedWhole}.${normalizedDecimal}` : normalizedWhole;
  });

const numericIdSchema = z
  .union([z.string(), z.number().int().nonnegative()])
  .transform(String)
  .pipe(z.string().trim().regex(/^\d+$/, 'Expected a numeric ID'));

const httpUrlSchema = z
  .url()
  .max(2_048)
  .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), 'Expected an HTTP(S) URL');

export const settingsUpdateSchema = z
  .object({
    deliveryChargeDhaka: deliveryChargeSchema.optional(),
    deliveryChargeOutsideDhaka: deliveryChargeSchema.optional(),
    returnDeliveryCharge: deliveryChargeSchema.optional(),
    websiteApiBaseUrl: httpUrlSchema.optional(),
    pageId: numericIdSchema.optional(),
    deliveryCompanyId: numericIdSchema.optional(),
    utmSource: z.string().trim().min(1).max(100).optional(),
    utmCampaign: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .refine((settings) => Object.keys(settings).length > 0, 'At least one setting is required');

export type SettingsUpdateInput = z.infer<typeof settingsUpdateSchema>;
