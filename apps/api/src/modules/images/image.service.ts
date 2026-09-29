import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import type { ImageInput, PreparedImage } from './image.types.js';
import {
  ImageValidationError,
  ImageValidationService,
  normalizeImageMimeType,
} from './image-validation.service.js';

type FetchLike = typeof fetch;
type ResolveHost = (hostname: string) => Promise<string[]>;

interface CacheEntry {
  expiresAt: number;
  image: PreparedImage;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0] ?? '';
  if (isIP(normalized) === 4) return isPrivateIpv4(normalized);
  if (isIP(normalized) !== 6) return true;
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
  if (normalized.startsWith('::ffff:')) return isPrivateIpv4(normalized.slice(7));
  return false;
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

export class ImageFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageFetchError';
  }
}

export class ImageService {
  private readonly urlCache = new Map<string, CacheEntry>();

  constructor(
    private readonly validation: ImageValidationService,
    private readonly timeoutMs: number,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly resolveHost: ResolveHost = defaultResolveHost,
  ) {}

  async prepare(input: ImageInput): Promise<PreparedImage> {
    this.validation.validateInput(input);
    if (input.data) return this.prepareInline(input);

    const url = input.url!;
    const cacheKey = `${url}|${input.mimeType ?? ''}`;
    const cached = this.urlCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { ...cached.image, source: input.source };
    }

    const image = await this.download(url, input.mimeType, input.source);
    if (this.urlCache.size >= 10) this.urlCache.delete(this.urlCache.keys().next().value ?? '');
    this.urlCache.set(cacheKey, { image, expiresAt: Date.now() + 5 * 60_000 });
    return image;
  }

  private prepareInline(input: ImageInput): PreparedImage {
    if (!input.mimeType) {
      throw new ImageValidationError('mimeType is required for inline image data', 'INVALID_IMAGE');
    }
    const encoded = input.data!.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
      throw new ImageValidationError('Image data is not valid base64', 'INVALID_IMAGE');
    }
    const data = Buffer.from(encoded, 'base64');
    const mimeType = this.validation.validateBuffer(data, input.mimeType);
    return this.toPrepared(data, mimeType, input.source);
  }

  private async download(
    initialUrl: string,
    declaredMimeType: string | undefined,
    source: string,
  ): Promise<PreparedImage> {
    let currentUrl = initialUrl;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      await this.assertSafeUrl(currentUrl);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: { accept: 'image/jpeg,image/png,image/webp' },
        });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location || redirects === 3) {
            throw new ImageFetchError('Image URL redirected too many times');
          }
          await response.body?.cancel();
          currentUrl = new URL(location, currentUrl).toString();
          continue;
        }
        if (!response.ok) throw new ImageFetchError(`Image request failed with HTTP ${response.status}`);

        const contentLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(contentLength) && contentLength > this.validation.maxBytes) {
          throw new ImageValidationError('Image exceeds the configured size limit', 'IMAGE_TOO_LARGE');
        }
        const responseMimeType = normalizeImageMimeType(response.headers.get('content-type'));
        if (!responseMimeType?.startsWith('image/')) {
          throw new ImageValidationError('URL did not return an image', 'UNSUPPORTED_IMAGE_TYPE');
        }
        const data = await this.readLimitedBody(response);
        const mimeType = this.validation.validateBuffer(data, declaredMimeType ?? responseMimeType);
        return this.toPrepared(data, mimeType, source);
      } catch (error) {
        if (error instanceof ImageValidationError || error instanceof ImageFetchError) throw error;
        throw new ImageFetchError(
          error instanceof Error && error.name === 'AbortError'
            ? 'Image request timed out'
            : 'Image could not be downloaded',
        );
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new ImageFetchError('Image could not be downloaded');
  }

  private async readLimitedBody(response: Response): Promise<Buffer> {
    if (!response.body) throw new ImageFetchError('Image response had no body');
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > this.validation.maxBytes) {
          await reader.cancel();
          throw new ImageValidationError('Image exceeds the configured size limit', 'IMAGE_TOO_LARGE');
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, total);
  }

  private async assertSafeUrl(value: string): Promise<void> {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new ImageValidationError('Malformed image URL', 'INVALID_IMAGE_URL');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new ImageValidationError('Image URL must be a public HTTP(S) URL', 'INVALID_IMAGE_URL');
    }
    if (url.port && !['80', '443'].includes(url.port)) {
      throw new ImageValidationError('Image URL uses a blocked port', 'INVALID_IMAGE_URL');
    }
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
      throw new ImageValidationError('Private image URLs are not allowed', 'INVALID_IMAGE_URL');
    }
    let addresses: string[];
    try {
      addresses = isIP(hostname) ? [hostname] : await this.resolveHost(hostname);
    } catch {
      throw new ImageFetchError('Image host could not be resolved');
    }
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
      throw new ImageValidationError('Private image URLs are not allowed', 'INVALID_IMAGE_URL');
    }
  }

  private toPrepared(
    data: Buffer,
    mimeType: PreparedImage['mimeType'],
    source: string,
  ): PreparedImage {
    return {
      data,
      base64: data.toString('base64'),
      mimeType,
      sizeBytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      source,
      temporary: true,
    };
  }
}
