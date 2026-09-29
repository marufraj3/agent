import { extname } from 'node:path';
import {
  supportedAudioMimeTypes,
  type AudioInput,
  type SupportedAudioMimeType,
} from './audio.types.js';

export class AudioValidationError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'UNSUPPORTED_AUDIO_TYPE'
      | 'AUDIO_TOO_LARGE'
      | 'AUDIO_TOO_LONG'
      | 'INVALID_AUDIO'
      | 'INVALID_AUDIO_URL',
  ) {
    super(message);
    this.name = 'AudioValidationError';
  }
}

const extensionMimeTypes: Record<string, SupportedAudioMimeType> = {
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.mp4': 'audio/mp4',
  '.m4a': 'audio/m4a',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.amr': 'audio/amr',
};
const knownUnsupportedAudioExtensions = new Set(['.wma', '.aiff']);
const compatibleMimeFamilies = [
  new Set(['audio/ogg', 'audio/opus']),
  new Set(['audio/mpeg', 'audio/mp3']),
  new Set(['audio/mp4', 'audio/m4a']),
];

export function normalizeAudioMimeType(value: string | null | undefined): string | null {
  const normalized = value?.split(';', 1)[0]?.trim().toLowerCase();
  if (normalized === 'audio/x-wav' || normalized === 'audio/wave') return 'audio/wav';
  if (normalized === 'audio/x-m4a') return 'audio/m4a';
  return normalized || null;
}

function mimeTypesCompatible(left: string, right: string): boolean {
  return left === right || compatibleMimeFamilies.some((family) => family.has(left) && family.has(right));
}

export class AudioValidationService {
  readonly maxBytes: number;

  constructor(
    maxSizeMb: number,
    readonly maxDurationSeconds: number,
  ) {
    this.maxBytes = Math.floor(maxSizeMb * 1024 * 1024);
  }

  validateInput(input: AudioInput): void {
    if (input.mimeType && !supportedAudioMimeTypes.includes(input.mimeType)) {
      throw new AudioValidationError('Unsupported audio MIME type', 'UNSUPPORTED_AUDIO_TYPE');
    }
    if (input.duration && input.duration > this.maxDurationSeconds) {
      throw new AudioValidationError('Audio exceeds the configured duration limit', 'AUDIO_TOO_LONG');
    }
    if (input.url) {
      let parsed: URL;
      try {
        parsed = new URL(input.url);
      } catch {
        throw new AudioValidationError('Malformed audio URL', 'INVALID_AUDIO_URL');
      }
      const extension = extname(parsed.pathname).toLowerCase();
      if (knownUnsupportedAudioExtensions.has(extension)) {
        throw new AudioValidationError('Unsupported audio file extension', 'UNSUPPORTED_AUDIO_TYPE');
      }
      const extensionMime = extensionMimeTypes[extension];
      if (
        extensionMime &&
        input.mimeType &&
        !mimeTypesCompatible(extensionMime, input.mimeType)
      ) {
        throw new AudioValidationError('Audio extension and MIME type do not match', 'INVALID_AUDIO');
      }
    }
    if (input.data) {
      const encoded = input.data.replace(/\s+/g, '');
      const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
      const estimatedBytes = Math.floor((encoded.length * 3) / 4) - padding;
      if (estimatedBytes > this.maxBytes) {
        throw new AudioValidationError('Audio exceeds the configured size limit', 'AUDIO_TOO_LARGE');
      }
    }
  }

  validateBuffer(data: Buffer, declaredMimeType?: string | null): SupportedAudioMimeType {
    if (data.length === 0) throw new AudioValidationError('Audio is empty', 'INVALID_AUDIO');
    if (data.length > this.maxBytes) {
      throw new AudioValidationError('Audio exceeds the configured size limit', 'AUDIO_TOO_LARGE');
    }
    const detected = this.detectMimeType(data);
    if (!detected) {
      throw new AudioValidationError('Unsupported or malformed audio content', 'UNSUPPORTED_AUDIO_TYPE');
    }
    const declared = normalizeAudioMimeType(declaredMimeType);
    if (declared && !supportedAudioMimeTypes.includes(declared as SupportedAudioMimeType)) {
      throw new AudioValidationError('Unsupported audio MIME type', 'UNSUPPORTED_AUDIO_TYPE');
    }
    if (declared && !mimeTypesCompatible(declared, detected)) {
      throw new AudioValidationError('Declared MIME type does not match audio content', 'INVALID_AUDIO');
    }
    return declared && mimeTypesCompatible(declared, detected)
      ? (declared as SupportedAudioMimeType)
      : detected;
  }

  validateDuration(duration: number | null): void {
    if (duration !== null && duration > this.maxDurationSeconds) {
      throw new AudioValidationError('Audio exceeds the configured duration limit', 'AUDIO_TOO_LONG');
    }
  }

  private detectMimeType(data: Buffer): SupportedAudioMimeType | null {
    if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WAVE') return 'audio/wav';
    if (
      data.length >= 27 &&
      data.subarray(0, 4).toString('ascii') === 'OggS' &&
      data[4] === 0
    ) {
      return data.subarray(0, Math.min(data.length, 256)).includes(Buffer.from('OpusHead'))
        ? 'audio/opus'
        : 'audio/ogg';
    }
    if (data.length >= 2 && data[0] === 0xff && (data[1]! & 0xf6) === 0xf0) return 'audio/aac';
    const mp3Start = data.subarray(0, 3).toString('ascii') === 'ID3' && data.length >= 10
      ? Math.min(
          data.length,
          10 + ((data[6]! & 0x7f) << 21) + ((data[7]! & 0x7f) << 14) + ((data[8]! & 0x7f) << 7) + (data[9]! & 0x7f),
        )
      : 0;
    for (let index = mp3Start; index + 1 < Math.min(data.length, mp3Start + 4_096); index += 1) {
      if (data[index] === 0xff && (data[index + 1]! & 0xe0) === 0xe0) return 'audio/mpeg';
    }
    if (data.length >= 4 && data.subarray(0, 4).toString('ascii') === 'fLaC') return 'audio/flac';
    if (data.length >= 6 && data.subarray(0, 6).toString('ascii') === '#!AMR\n') return 'audio/amr';
    if (data.length >= 8 && data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'audio/webm';
    if (data.length >= 12 && data.subarray(4, 8).toString('ascii') === 'ftyp') {
      const brand = data.subarray(8, 12).toString('ascii').toLowerCase();
      return brand.includes('m4a') ? 'audio/m4a' : 'audio/mp4';
    }
    return null;
  }
}
