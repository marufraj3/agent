import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PublicUrlService, UnsafePublicUrlError, type ResolveHost } from '../media/public-url.service.js';
import type { AudioInput, PreparedAudio, SupportedAudioMimeType } from './audio.types.js';
import {
  AudioValidationError,
  AudioValidationService,
  normalizeAudioMimeType,
} from './audio-validation.service.js';

type FetchLike = typeof fetch;
const execFileAsync = promisify(execFile);
interface CacheEntry {
  expiresAt: number;
  audio: PreparedAudio;
}

export class AudioFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioFetchError';
  }
}

export class AudioService {
  private readonly urlCache = new Map<string, CacheEntry>();
  private readonly publicUrls: PublicUrlService;

  constructor(
    private readonly validation: AudioValidationService,
    private readonly timeoutMs: number,
    private readonly fetchImpl: FetchLike = fetch,
    resolveHost?: ResolveHost,
  ) {
    this.publicUrls = new PublicUrlService(resolveHost);
  }

  async prepare(input: AudioInput): Promise<PreparedAudio> {
    this.validation.validateInput(input);
    if (input.data) return this.prepareInline(input);

    const url = input.url!;
    const cacheKey = `${url}|${input.mimeType ?? ''}`;
    const cacheable = input.source !== 'messenger';
    const cached = cacheable ? this.urlCache.get(cacheKey) : undefined;
    if (cached && cached.expiresAt > Date.now()) {
      return {
        ...cached.audio,
        source: input.source,
        duration: cached.audio.duration ?? input.duration ?? null,
      };
    }

    const audio = await this.download(url, input.mimeType, input.source, input.duration);
    if (cacheable) {
      if (this.urlCache.size >= 10) this.urlCache.delete(this.urlCache.keys().next().value ?? '');
      this.urlCache.set(cacheKey, { audio, expiresAt: Date.now() + 5 * 60_000 });
    }
    return audio;
  }

  private async prepareInline(input: AudioInput): Promise<PreparedAudio> {
    if (!input.mimeType) {
      throw new AudioValidationError('mimeType is required for inline audio data', 'INVALID_AUDIO');
    }
    const encoded = input.data!.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
      throw new AudioValidationError('Audio data is not valid base64', 'INVALID_AUDIO');
    }
    const data = Buffer.from(encoded, 'base64');
    const mimeType = this.validation.validateBuffer(data, input.mimeType);
    return this.toPrepared(data, mimeType, input.source, input.duration);
  }

  private async download(
    initialUrl: string,
    declaredMimeType: string | undefined,
    source: string,
    declaredDuration: number | undefined,
  ): Promise<PreparedAudio> {
    let currentUrl = initialUrl;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      try {
        await this.publicUrls.validate(currentUrl);
      } catch (error) {
        if (error instanceof UnsafePublicUrlError) {
          throw new AudioValidationError(error.message, 'INVALID_AUDIO_URL');
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
          headers: { accept: 'audio/ogg,audio/mpeg,audio/wav,audio/webm,audio/mp4,audio/aac,audio/flac,audio/amr' },
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location || redirects === 3) {
            throw new AudioFetchError('Audio URL redirected too many times');
          }
          await response.body?.cancel();
          currentUrl = new URL(location, currentUrl).toString();
          continue;
        }
        if (!response.ok) throw new AudioFetchError(`Audio request failed with HTTP ${response.status}`);

        const contentLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(contentLength) && contentLength > this.validation.maxBytes) {
          throw new AudioValidationError('Audio exceeds the configured size limit', 'AUDIO_TOO_LARGE');
        }
        const responseMimeType = normalizeAudioMimeType(response.headers.get('content-type'));
        if (!responseMimeType?.startsWith('audio/')) {
          throw new AudioValidationError('URL did not return audio', 'UNSUPPORTED_AUDIO_TYPE');
        }
        const data = await this.readLimitedBody(response);
        const mimeType = this.validation.validateBuffer(data, declaredMimeType ?? responseMimeType);
        return this.toPrepared(data, mimeType, source, declaredDuration);
      } catch (error) {
        if (error instanceof AudioValidationError || error instanceof AudioFetchError) throw error;
        throw new AudioFetchError(
          error instanceof Error && error.name === 'AbortError'
            ? 'Audio request timed out'
            : 'Audio could not be downloaded',
        );
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new AudioFetchError('Audio could not be downloaded');
  }

  private async readLimitedBody(response: Response): Promise<Buffer> {
    if (!response.body) throw new AudioFetchError('Audio response had no body');
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
          throw new AudioValidationError('Audio exceeds the configured size limit', 'AUDIO_TOO_LARGE');
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, total);
  }

  private async toPrepared(
    data: Buffer,
    mimeType: SupportedAudioMimeType,
    source: string,
    declaredDuration?: number,
  ): Promise<PreparedAudio> {
    const detectedDuration = detectAudioDuration(data, mimeType) ?? await this.probeDuration(data);
    const duration = detectedDuration ?? declaredDuration ?? null;
    this.validation.validateDuration(duration);
    return {
      data,
      base64: data.toString('base64'),
      mimeType,
      sizeBytes: data.length,
      duration,
      sha256: createHash('sha256').update(data).digest('hex'),
      source,
      temporary: true,
    };
  }

  /**
   * Probe containers whose duration cannot be read safely from their first frames.
   * The random server-owned path is deleted in finally and is never returned or logged.
   * If ffprobe is unavailable, provider-supported originals continue without conversion.
   */
  private async probeDuration(data: Buffer): Promise<number | null> {
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), 'alzeena-audio-'));
      const file = join(directory, 'input.audio');
      await writeFile(file, data, { mode: 0o600 });
      const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', file,
      ], { timeout: Math.min(this.timeoutMs, 10_000), maxBuffer: 16 * 1024 });
      const duration = Number(stdout.trim());
      return Number.isFinite(duration) && duration > 0 ? Number(duration.toFixed(3)) : null;
    } catch {
      return null;
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export function detectAudioDuration(
  data: Buffer,
  mimeType: SupportedAudioMimeType,
): number | null {
  if (mimeType === 'audio/wav' && data.length >= 44) {
    const byteRate = data.readUInt32LE(28);
    const dataMarker = data.indexOf(Buffer.from('data'), 12);
    if (byteRate > 0 && dataMarker >= 0 && dataMarker + 8 <= data.length) {
      return Number((data.readUInt32LE(dataMarker + 4) / byteRate).toFixed(3));
    }
  }
  if ((mimeType === 'audio/opus' || mimeType === 'audio/ogg') && data.includes(Buffer.from('OpusHead'))) {
    const lastPage = data.lastIndexOf(Buffer.from('OggS'));
    if (lastPage >= 0 && lastPage + 14 <= data.length) {
      const granule = data.readBigUInt64LE(lastPage + 6);
      if (granule > 0n) return Number((Number(granule) / 48_000).toFixed(3));
    }
  }
  if (mimeType === 'audio/mpeg' || mimeType === 'audio/mp3') {
    let offset = data.subarray(0, 3).toString('ascii') === 'ID3' && data.length >= 10
      ? 10 + ((data[6]! & 0x7f) << 21) + ((data[7]! & 0x7f) << 14) + ((data[8]! & 0x7f) << 7) + (data[9]! & 0x7f)
      : 0;
    while (offset + 4 <= data.length && !(data[offset] === 0xff && (data[offset + 1]! & 0xe0) === 0xe0)) offset += 1;
    if (offset + 4 <= data.length) {
      const versionBits = (data[offset + 1]! >> 3) & 0x03;
      const bitrateIndex = (data[offset + 2]! >> 4) & 0x0f;
      const mpeg1Layer3Rates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
      const mpeg2Layer3Rates = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
      const rate = (versionBits === 3 ? mpeg1Layer3Rates : mpeg2Layer3Rates)[bitrateIndex] ?? 0;
      if (rate > 0) return Number((((data.length - offset) * 8) / (rate * 1_000)).toFixed(3));
    }
  }
  return null;
}
