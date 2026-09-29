import { z } from 'zod';
import { imageInputSchema } from '../images/image.types.js';

export const chatRequestSchema = z
  .object({
    customer: z
      .object({
        externalId: z.string().trim().max(255).nullable().optional(),
        name: z.string().trim().max(255).nullable().optional(),
        phone: z.string().trim().max(50).nullable().optional(),
        email: z.email().max(320).nullable().optional(),
        platform: z.string().trim().min(1).max(50),
        platformUserId: z.string().trim().min(1).max(255),
        language: z.string().trim().max(20).nullable().optional(),
      })
      .strict(),
    message: z.string().trim().min(1).max(4_000).optional(),
    image: imageInputSchema.optional(),
    channel: z.enum(['web', 'messenger', 'admin', 'test']).optional(),
    conversationId: z.uuid().optional(),
    newConversation: z.boolean().default(false),
  })
  .strict()
  .refine((input) => Boolean(input.message || input.image), {
    message: 'A message or image is required',
  });

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(['active', 'closed', 'human']).optional(),
  channel: z.enum(['web', 'messenger', 'admin', 'test']).optional(),
});
