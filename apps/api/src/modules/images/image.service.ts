import { createHash } from 'node:crypto';
import { PublicUrlService, UnsafePublicUrlError, type ResolveHost } from '../media/public-url.service.js';
import type { ImageInput, PreparedImage } from './image.types.js';
import {
  ImageValidationError,
  ImageValidationService,
  normalizeImageMimeType,
} from './image-validation.service.js';

type FetchLike = typeof fetch;

interface CacheEntry {
  expiresAt: number;
  image: PreparedImage;
}

export class ImageFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageFetchError';
  }
}

export class ImageService {
  private readonly urlCache = new Map<string, CacheEntry>();
  private readonly publicUrls: PublicUrlService;

  constructor(
    private readonly validation: ImageValidationService,
    private readonly timeoutMs: number,
    private readonly fetchImpl: FetchLike = fetch,
    resolveHost?: ResolveHost,
  ) {
    this.publicUrls = new PublicUrlService(resolveHost);
  }

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
      try {
        await this.publicUrls.validate(currentUrl);
      } catch (error) {
        if (error instanceof UnsafePublicUrlError) {
          throw new ImageValidationError(error.message, 'INVALID_IMAGE_URL');
        }
        throw error;
      }
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
