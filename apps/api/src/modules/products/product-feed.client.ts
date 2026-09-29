export class ProductFeedResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductFeedResponseError';
  }
}

export interface FeedPage {
  items: unknown[];
  pageNumber: number;
  isPaginated: boolean;
}

interface ParsedFeedEnvelope {
  items: unknown[];
  nextUrl: string | null;
  isPaginated: boolean;
}

export interface ProductFeedClientOptions {
  endpoint: string;
  timeoutMs: number;
  retries: number;
  maxPages: number;
  fetchImplementation?: typeof fetch;
  onRetry?: (details: { attempt: number; delayMs: number; error: string }) => void;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numericValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

export function parseFeedEnvelope(payload: unknown, currentUrl: string): ParsedFeedEnvelope {
  if (Array.isArray(payload)) {
    return { items: payload, nextUrl: null, isPaginated: false };
  }

  const envelope = objectValue(payload);
  if (!envelope || !Array.isArray(envelope.data)) {
    throw new ProductFeedResponseError(
      'Product feed must be an array or an object containing a data array',
    );
  }

  const links = objectValue(envelope.links);
  const meta = objectValue(envelope.meta);
  const directNext = envelope.next_page_url ?? links?.next;

  if (typeof directNext === 'string' && directNext.length > 0) {
    return { items: envelope.data, nextUrl: directNext, isPaginated: true };
  }

  const currentPage =
    numericValue(envelope.current_page) ?? numericValue(meta?.current_page) ?? numericValue(meta?.currentPage);
  const lastPage =
    numericValue(envelope.last_page) ?? numericValue(meta?.last_page) ?? numericValue(meta?.lastPage);

  if (currentPage !== null && lastPage !== null && currentPage < lastPage) {
    const nextUrl = new URL(currentUrl);
    nextUrl.searchParams.set('page', String(currentPage + 1));
    return { items: envelope.data, nextUrl: nextUrl.toString(), isPaginated: true };
  }

  return {
    items: envelope.data,
    nextUrl: null,
    isPaginated:
      currentPage !== null || lastPage !== null || envelope.next_page_url !== undefined || links !== null,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown product feed error';
}

export class ProductFeedClient {
  private readonly fetchImplementation: typeof fetch;

  constructor(private readonly options: ProductFeedClientOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async *pages(): AsyncGenerator<FeedPage> {
    const initialUrl = new URL(this.options.endpoint);
    const allowedOrigin = initialUrl.origin;
    const visited = new Set<string>();
    let nextUrl: string | null = initialUrl.toString();
    let pageNumber = 0;

    while (nextUrl) {
      if (pageNumber >= this.options.maxPages) {
        throw new ProductFeedResponseError(
          `Product feed exceeded the ${this.options.maxPages} page safety limit`,
        );
      }
      if (visited.has(nextUrl)) {
        throw new ProductFeedResponseError('Product feed pagination loop detected');
      }

      const pageUrl = new URL(nextUrl);
      if (pageUrl.origin !== allowedOrigin || !['http:', 'https:'].includes(pageUrl.protocol)) {
        throw new ProductFeedResponseError('Product feed returned an unsafe pagination URL');
      }

      visited.add(nextUrl);
      pageNumber += 1;
      const payload = await this.fetchJsonWithRetry(nextUrl);
      const parsed = parseFeedEnvelope(payload, nextUrl);

      yield { items: parsed.items, pageNumber, isPaginated: parsed.isPaginated };
      nextUrl = parsed.nextUrl ? new URL(parsed.nextUrl, nextUrl).toString() : null;
    }
  }

  private async fetchJsonWithRetry(url: string): Promise<unknown> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.options.retries + 1; attempt += 1) {
      try {
        const response = await this.fetchImplementation(url, {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });

        if (!response.ok) {
          const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
          const message = `Product feed responded with HTTP ${response.status}`;
          if (!retryable) throw new ProductFeedResponseError(message);
          const statusError = new Error(message);
          if (attempt > this.options.retries) throw statusError;
          lastError = statusError;
        } else {
          const contentType = response.headers.get('content-type') ?? '';
          if (!contentType.toLowerCase().includes('json')) {
            throw new ProductFeedResponseError(
              `Product feed returned unsupported content type: ${contentType || 'unknown'}`,
            );
          }
          try {
            return await response.json();
          } catch {
            throw new ProductFeedResponseError('Product feed returned invalid JSON');
          }
        }
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof TypeError ||
          (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name));
        if (!retryable || attempt > this.options.retries) throw error;
      }

      const delayMs = Math.min(500 * 2 ** (attempt - 1), 5_000);
      this.options.onRetry?.({ attempt, delayMs, error: errorMessage(lastError) });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    throw lastError instanceof Error ? lastError : new Error('Product feed request failed');
  }
}
