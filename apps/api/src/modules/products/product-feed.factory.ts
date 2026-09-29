import { env } from '../../config/env.js';
import { ProductFeedClient } from './product-feed.client.js';

export function getProductFeedEndpoint(): string {
  const baseUrl = new URL(env.WEBSITE_API_BASE_URL);
  if (baseUrl.pathname.replace(/\/$/, '').endsWith('/products')) return baseUrl.toString();
  baseUrl.pathname = `${baseUrl.pathname.replace(/\/$/, '')}/products`;
  return baseUrl.toString();
}

export function createProductFeedClient(onRetry?: (details: {
  attempt: number;
  delayMs: number;
  error: string;
}) => void): ProductFeedClient {
  return new ProductFeedClient({
    endpoint: getProductFeedEndpoint(),
    timeoutMs: env.PRODUCT_FEED_TIMEOUT_MS,
    retries: env.PRODUCT_FEED_RETRIES,
    maxPages: env.PRODUCT_FEED_MAX_PAGES,
    onRetry,
  });
}
