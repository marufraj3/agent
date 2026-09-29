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
