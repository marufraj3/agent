import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotEnv } from 'dotenv';
import { z } from 'zod';

const envCandidates = [
  process.env.ENV_FILE,
  resolve(process.cwd(), '.env'),
  resolve(process.cwd(), '../../.env'),
].filter((path): path is string => Boolean(path));

const envFile = envCandidates.find(existsSync);
if (envFile) {
  loadDotEnv({ path: envFile, quiet: true });
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().max(65_535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  FRONTEND_URL: z.url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.url().refine((url) => url.startsWith('redis://') || url.startsWith('rediss://'), {
    message: 'REDIS_URL must use redis:// or rediss://',
  }),
  ADMIN_PASSWORD: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(12, 'ADMIN_PASSWORD must contain at least 12 characters').optional(),
  ),
  GEMINI_API_KEY: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(1).optional(),
  ),
  GEMINI_MODEL: z.string().min(1).default('gemini-2.5-flash-lite'),
  GEMINI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.3),
  GEMINI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(128).max(4_096).default(800),
  GEMINI_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  AI_MAX_HISTORY_MESSAGES: z.coerce.number().int().min(0).max(20).default(8),
  AI_MAX_PRODUCTS: z.coerce.number().int().min(1).max(10).default(5),
  AI_TEST_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(300).default(30),
  CONVERSATION_HISTORY_LIMIT: z.coerce.number().int().min(1).max(100).default(20),
  MAX_IMAGE_SIZE_MB: z.coerce.number().positive().max(25).default(10),
  IMAGE_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
  IMAGE_MATCH_HIGH_THRESHOLD: z.coerce.number().min(0.5).max(1).default(0.85),
  IMAGE_MATCH_MEDIUM_THRESHOLD: z.coerce.number().min(0.3).max(1).default(0.65),
  MAX_AUDIO_SIZE_MB: z.coerce.number().positive().max(50).default(15),
  MAX_AUDIO_DURATION_SECONDS: z.coerce.number().int().min(1).max(600).default(120),
  AUDIO_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(20_000),
  VOICE_TRANSCRIPTION_LOW_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6),
  ORDER_API_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  WEBSITE_API_BASE_URL: z.url().default('https://sells.alzeena.com.bd/public/api'),
  PRODUCT_FEED_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  PRODUCT_FEED_RETRIES: z.coerce.number().int().min(0).max(5).default(3),
  PRODUCT_FEED_MAX_PAGES: z.coerce.number().int().min(1).max(10_000).default(1_000),
}).refine((values) => values.IMAGE_MATCH_MEDIUM_THRESHOLD < values.IMAGE_MATCH_HIGH_THRESHOLD, {
  message: 'IMAGE_MATCH_MEDIUM_THRESHOLD must be lower than IMAGE_MATCH_HIGH_THRESHOLD',
  path: ['IMAGE_MATCH_MEDIUM_THRESHOLD'],
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  const details = result.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join(', ');
  throw new Error(`Invalid environment configuration: ${details}`);
}

export const env = result.data;
export type Env = typeof env;
