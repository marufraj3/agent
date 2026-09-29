import { extname } from 'node:path';
import {
  supportedImageMimeTypes,
  type ImageInput,
  type SupportedImageMimeType,
} from './image.types.js';

export class ImageValidationError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'UNSUPPORTED_IMAGE_TYPE'
      | 'IMAGE_TOO_LARGE'
      | 'INVALID_IMAGE'
      | 'INVALID_IMAGE_URL',
  ) {
    super(message);
    this.name = 'ImageValidationError';
  }
}

const extensionMimeTypes: Record<string, SupportedImageMimeType> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};
const knownUnsupportedImageExtensions = new Set([
  '.gif',
  '.svg',
  '.bmp',
  '.tif',
  '.tiff',
  '.avif',
  '.heic',
]);

export function normalizeImageMimeType(value: string | null | undefined): string | null {
  return value?.split(';', 1)[0]?.trim().toLowerCase() || null;
}

export class ImageValidationService {
  readonly maxBytes: number;

  constructor(maxSizeMb: number) {
    this.maxBytes = Math.floor(maxSizeMb * 1024 * 1024);
  }

  validateInput(input: ImageInput): void {
    if (input.mimeType && !supportedImageMimeTypes.includes(input.mimeType)) {
      throw new ImageValidationError('Unsupported image MIME type', 'UNSUPPORTED_IMAGE_TYPE');
    }
    if (input.url) {
      let parsed: URL;
      try {
        parsed = new URL(input.url);
      } catch {
        throw new ImageValidationError('Malformed image URL', 'INVALID_IMAGE_URL');
      }
      const extension = extname(parsed.pathname).toLowerCase();
      if (knownUnsupportedImageExtensions.has(extension)) {
        throw new ImageValidationError('Unsupported image file extension', 'UNSUPPORTED_IMAGE_TYPE');
      }
      const extensionMime = extensionMimeTypes[extension];
      if (extensionMime && input.mimeType && extensionMime !== input.mimeType) {
        throw new ImageValidationError('Image extension and MIME type do not match', 'INVALID_IMAGE');
      }
    }
    if (input.data) {
      const encoded = input.data.replace(/\s+/g, '');
      const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
      const estimatedBytes = Math.floor((encoded.length * 3) / 4) - padding;
      if (estimatedBytes > this.maxBytes) {
        throw new ImageValidationError('Image exceeds the configured size limit', 'IMAGE_TOO_LARGE');
      }
    }
  }

  validateBuffer(
    data: Buffer,
    declaredMimeType?: string | null,
  ): SupportedImageMimeType {
    if (data.length === 0) throw new ImageValidationError('Image is empty', 'INVALID_IMAGE');
    if (data.length > this.maxBytes) {
      throw new ImageValidationError('Image exceeds the configured size limit', 'IMAGE_TOO_LARGE');
    }

    const detected = this.detectMimeType(data);
    if (!detected) {
      throw new ImageValidationError('Unsupported or malformed image content', 'UNSUPPORTED_IMAGE_TYPE');
    }
    const declared = normalizeImageMimeType(declaredMimeType);
    if (declared && !supportedImageMimeTypes.includes(declared as SupportedImageMimeType)) {
      throw new ImageValidationError('Unsupported image MIME type', 'UNSUPPORTED_IMAGE_TYPE');
    }
    if (declared && declared !== detected) {
      throw new ImageValidationError('Declared MIME type does not match image content', 'INVALID_IMAGE');
    }
    return detected;
  }

  private detectMimeType(data: Buffer): SupportedImageMimeType | null {
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
      return 'image/jpeg';
    }
    if (
      data.length >= 8 &&
      data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ) {
      return 'image/png';
    }
    if (
      data.length >= 12 &&
      data.subarray(0, 4).toString('ascii') === 'RIFF' &&
      data.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
      return 'image/webp';
    }
    return null;
  }
}
