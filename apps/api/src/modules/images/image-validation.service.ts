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

  constructor(maxSizeMb: number, readonly maxDimension = 12_000) {
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
    const dimensions = this.detectDimensions(data, detected);
    if (dimensions && (dimensions.width > this.maxDimension || dimensions.height > this.maxDimension)) {
      throw new ImageValidationError('Image dimensions exceed the configured limit', 'INVALID_IMAGE');
    }
    return detected;
  }

  dimensions(data: Buffer, mimeType: SupportedImageMimeType): { width: number; height: number } | null {
    return this.detectDimensions(data, mimeType);
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

  private detectDimensions(data: Buffer, mimeType: SupportedImageMimeType): { width: number; height: number } | null {
    if (mimeType === 'image/png' && data.length >= 24) {
      const width = data.readUInt32BE(16); const height = data.readUInt32BE(20);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (mimeType === 'image/webp' && data.length >= 30 && data.subarray(12, 16).toString('ascii') === 'VP8X') {
      const width = 1 + data.readUIntLE(24, 3); const height = 1 + data.readUIntLE(27, 3);
      return { width, height };
    }
    if (mimeType === 'image/jpeg') {
      let offset = 2;
      while (offset + 9 < data.length) {
        if (data[offset] !== 0xff) { offset += 1; continue; }
        const marker = data[offset + 1]!; const length = data.readUInt16BE(offset + 2);
        if (length < 2 || offset + 2 + length > data.length) break;
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
          const height = data.readUInt16BE(offset + 5); const width = data.readUInt16BE(offset + 7);
          return width > 0 && height > 0 ? { width, height } : null;
        }
        offset += 2 + length;
      }
    }
    return null;
  }
}
