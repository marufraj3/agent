import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotEnv } from 'dotenv';
import type { NextConfig } from 'next';

const rootEnv = resolve(process.cwd(), '../../.env');
if (existsSync(rootEnv)) {
  loadDotEnv({ path: rootEnv, quiet: true });
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
