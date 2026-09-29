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

const booleanFromEnv = z.preprocess(
  (value) => typeof value === 'string' ? value.toLowerCase() === 'true' : value,
  z.boolean(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().max(65_535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  FRONTEND_URL: z.url().default('http://localhost:3000'),
  API_BODY_LIMIT_BYTES: z.coerce.number().int().min(64_000).max(25_000_000).default(1_000_000),
  PUBLIC_API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).max(10_000).default(120),
  ADMIN_API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).max(10_000).default(300),
  ADMIN_LOGIN_RATE_LIMIT_PER_15_MINUTES: z.coerce.number().int().min(3).max(100).default(10),
  ADMIN_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  AI_CUSTOMER_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(300).default(30),
  SLOW_QUERY_LOG_MS: z.coerce.number().int().min(50).max(60_000).default(500),
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
  AI_MAX_KNOWLEDGE_CHARS: z.coerce.number().int().min(1_000).max(50_000).default(12_000),
  AI_MAX_SUMMARY_CHARS: z.coerce.number().int().min(500).max(20_000).default(4_000),
  AI_MAX_PRODUCTS: z.coerce.number().int().min(1).max(10).default(5),
  AI_CONFIDENCE_HIGH: z.coerce.number().min(0).max(1).default(0.8),
  AI_CONFIDENCE_LOW: z.coerce.number().min(0).max(1).default(0.45),
  AI_TEST_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(300).default(30),
  AI_MAX_CONSECUTIVE_FAILURES: z.coerce.number().int().min(1).max(10).default(2),
  INBOX_PAGE_SIZE: z.coerce.number().int().min(10).max(100).default(25),
  CONVERSATION_HISTORY_LIMIT: z.coerce.number().int().min(1).max(100).default(20),
  MAX_IMAGE_SIZE_MB: z.coerce.number().positive().max(25).default(10),
  IMAGE_MAX_FILE_SIZE: z.coerce.number().positive().max(25).default(10),
  IMAGE_MAX_DIMENSION: z.coerce.number().int().min(256).max(50_000).default(12_000),
  IMAGE_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
  VISION_PROVIDER: z.enum(['gemini', 'disabled']).default('gemini'),
  VISION_MODEL: z.string().min(1).default('gemini-2.5-flash-lite'),
  VISION_TIMEOUT: z.coerce.number().int().min(1).max(120).default(30),
  IMAGE_MATCH_CANDIDATES: z.coerce.number().int().min(1).max(10).default(5),
  IMAGE_RETENTION_HOURS: z.coerce.number().min(0).max(168).default(0),
  IMAGE_MATCH_HIGH_THRESHOLD: z.coerce.number().min(0.5).max(1).default(0.85),
  IMAGE_MATCH_MEDIUM_THRESHOLD: z.coerce.number().min(0.3).max(1).default(0.65),
  MAX_AUDIO_SIZE_MB: z.coerce.number().positive().max(50).default(15),
  MAX_AUDIO_DURATION_SECONDS: z.coerce.number().int().min(1).max(600).default(120),
  AUDIO_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(20_000),
  VOICE_TRANSCRIPTION_LOW_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6),
  STT_PROVIDER: z.enum(['gemini', 'disabled']).default('gemini'),
  STT_MODEL: z.string().min(1).default('gemini-2.5-flash-lite'),
  STT_TIMEOUT: z.coerce.number().int().min(1).max(120).default(30),
  STT_MAX_FILE_SIZE: z.coerce.number().positive().max(50).default(15),
  STT_MAX_DURATION: z.coerce.number().int().min(1).max(600).default(120),
  AUDIO_RETENTION_HOURS: z.coerce.number().min(0).max(168).default(0),
  AUDIO_DEBOUNCE_MS: z.coerce.number().int().min(0).max(5_000).default(1_500),
  AUDIO_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(100).default(10),
  ORDER_API_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  FACEBOOK_VERIFY_TOKEN: z.preprocess((value) => value === '' ? undefined : value, z.string().min(16).optional()),
  FACEBOOK_APP_ID: z.preprocess((value) => value === '' ? undefined : value, z.string().min(1).optional()),
  FACEBOOK_APP_SECRET: z.preprocess((value) => value === '' ? undefined : value, z.string().min(16).optional()),
  FACEBOOK_PAGE_ID: z.preprocess((value) => value === '' ? undefined : value, z.string().min(1).optional()),
  FACEBOOK_PAGE_ACCESS_TOKEN: z.preprocess((value) => value === '' ? undefined : value, z.string().min(16).optional()),
  META_GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/).optional(),
  FACEBOOK_GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v25.0'),
  FACEBOOK_SEND_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  APP_URL: z.url().default('http://localhost:4000'),
  WEBHOOK_URL: z.url().optional(),
  MESSENGER_PROVIDER: z.enum(['meta', 'mock']).default('meta'),
  MESSENGER_CREDENTIAL_ENCRYPTION_KEY: z.preprocess((value) => value === '' ? undefined : value, z.string().min(32).optional()),
  MESSENGER_DEBOUNCE_MS: z.coerce.number().int().min(0).max(10_000).default(1_200),
  MESSENGER_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
  MESSENGER_SEND_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),
  IMAGE_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(3),
  AUDIO_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(3),
  PRODUCT_SYNC_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(1),
  FOLLOWUP_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(2),
  PRODUCT_CACHE_TTL_SECONDS: z.coerce.number().int().min(5).max(3600).default(60),
  RECOMMENDATION_ENABLED: booleanFromEnv.default(true),
  RECOMMENDATION_MAX_PRODUCTS: z.coerce.number().int().min(1).max(3).default(3),
  RECOMMENDATION_CROSS_SELL_ENABLED: booleanFromEnv.default(true),
  RECOMMENDATION_UPSELL_ENABLED: booleanFromEnv.default(true),
  RECOMMENDATION_CACHE_TTL_SECONDS: z.coerce.number().int().min(5).max(900).default(60),
  SALES_INTELLIGENCE_CACHE_TTL_SECONDS: z.coerce.number().int().min(5).max(900).default(60),
  MESSENGER_TECHNICAL_LOG_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  MESSENGER_WEBHOOK_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).max(10_000).default(1_000),
  WEBSITE_API_BASE_URL: z.url().default('https://sells.alzeena.com.bd/public/api'),
  PRODUCT_FEED_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  PRODUCT_FEED_RETRIES: z.coerce.number().int().min(0).max(5).default(3),
  PRODUCT_FEED_MAX_PAGES: z.coerce.number().int().min(1).max(10_000).default(1_000),
}).refine((values) => values.IMAGE_MATCH_MEDIUM_THRESHOLD < values.IMAGE_MATCH_HIGH_THRESHOLD, {
  message: 'IMAGE_MATCH_MEDIUM_THRESHOLD must be lower than IMAGE_MATCH_HIGH_THRESHOLD',
  path: ['IMAGE_MATCH_MEDIUM_THRESHOLD'],
}).superRefine((values, context) => {
  if (values.NODE_ENV === 'production' && !values.ADMIN_PASSWORD) {
    context.addIssue({ code: 'custom', path: ['ADMIN_PASSWORD'], message: 'ADMIN_PASSWORD is required in production' });
  }
  if (values.NODE_ENV === 'production' && (!values.FRONTEND_URL.startsWith('https://') || !values.APP_URL.startsWith('https://'))) {
    context.addIssue({ code: 'custom', path: ['APP_URL'], message: 'APP_URL and FRONTEND_URL must use HTTPS in production' });
  }
  if (values.NODE_ENV === 'production' && values.MESSENGER_PROVIDER === 'mock') {
    context.addIssue({ code: 'custom', path: ['MESSENGER_PROVIDER'], message: 'Mock Messenger provider is forbidden in production' });
  }
  const facebook = [values.FACEBOOK_APP_SECRET, values.FACEBOOK_PAGE_ID, values.FACEBOOK_PAGE_ACCESS_TOKEN, values.FACEBOOK_VERIFY_TOKEN];
  if (facebook.some(Boolean) && !facebook.every(Boolean)) {
    context.addIssue({ code: 'custom', path: ['FACEBOOK_APP_SECRET'], message: 'All Facebook webhook credentials must be configured together' });
  }
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
