import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProductCatalogService } from '../../products/product-catalog.service.js';
import { AudioService, detectAudioDuration } from '../audio.service.js';
import type { PreparedAudio, Transcription } from '../audio.types.js';
import { AudioValidationError, AudioValidationService } from '../audio-validation.service.js';
import { parseTranscription } from '../providers/gemini-speech-to-text.provider.js';
import type { SpeechToTextProvider } from '../providers/speech-to-text.provider.js';
import { SpeechToTextError, SpeechToTextService } from '../speech-to-text.service.js';
import { VoiceProductCodeService } from '../voice-product-code.service.js';

function wav(seconds = 1): Buffer {
  const byteRate = 8_000;
  const dataSize = byteRate * seconds;
  const data = Buffer.alloc(44 + dataSize);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + dataSize, 4);
  data.write('WAVE', 8);
  data.write('fmt ', 12);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(8_000, 24);
  data.writeUInt32LE(byteRate, 28);
  data.writeUInt16LE(1, 32);
  data.writeUInt16LE(8, 34);
  data.write('data', 36);
  data.writeUInt32LE(dataSize, 40);
  return data;
}

function ogg(): Buffer {
  const data = Buffer.alloc(96);
  data.write('OggS', 0);
  data.writeBigUInt64LE(48_000n, 6);
  data.write('OpusHead', 28);
  return data;
}

const mp3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64]);
const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x86, 0x81, 0x01]);
const validation = new AudioValidationService(15, 120);

test('validates OGG/Opus, MP3, WAV and WebM signatures', () => {
  assert.equal(validation.validateBuffer(ogg(), 'audio/ogg'), 'audio/ogg');
  assert.equal(validation.validateBuffer(mp3, 'audio/mp3'), 'audio/mp3');
  assert.equal(validation.validateBuffer(wav(), 'audio/wav'), 'audio/wav');
  assert.equal(validation.validateBuffer(webm, 'audio/webm'), 'audio/webm');
});

test('rejects unsupported and malformed audio', () => {
  assert.throws(
    () => validation.validateBuffer(Buffer.from('fLaC'), 'audio/flac'),
    (error: unknown) => error instanceof AudioValidationError && error.code === 'UNSUPPORTED_AUDIO_TYPE',
  );
});

test('rejects oversized audio', () => {
  const tiny = new AudioValidationService(0.000005, 120);
  assert.throws(
    () => tiny.validateBuffer(wav(), 'audio/wav'),
    (error: unknown) => error instanceof AudioValidationError && error.code === 'AUDIO_TOO_LARGE',
  );
});

test('detects WAV duration and rejects excessive duration', async () => {
  assert.equal(detectAudioDuration(wav(2), 'audio/wav'), 2);
  const shortDuration = new AudioValidationService(15, 1);
  const service = new AudioService(shortDuration, 1_000);
  await assert.rejects(
    service.prepare({
      type: 'audio',
      data: wav(2).toString('base64'),
      mimeType: 'audio/wav',
      source: 'test',
    }),
    (error: unknown) => error instanceof AudioValidationError && error.code === 'AUDIO_TOO_LONG',
  );
});

test('downloads a public audio URL once and reuses the bounded cache', async () => {
  let fetches = 0;
  const service = new AudioService(
    validation,
    1_000,
    (async () => {
      fetches += 1;
      return new Response(new Uint8Array(ogg()), { headers: { 'content-type': 'audio/ogg' } });
    }) as typeof fetch,
    async () => ['93.184.216.34'],
  );
  const input = { type: 'audio' as const, url: 'https://example.com/voice.ogg', source: 'test' };
  const first = await service.prepare(input);
  const second = await service.prepare(input);
  assert.equal(first.sha256, second.sha256);
  assert.equal(fetches, 1);
});

test('rejects invalid and private audio URLs before fetching', async () => {
  const service = new AudioService(validation, 1_000, fetch, async () => ['127.0.0.1']);
  await assert.rejects(
    service.prepare({ type: 'audio', url: 'not-a-url', source: 'test' }),
    (error: unknown) => error instanceof AudioValidationError && error.code === 'INVALID_AUDIO_URL',
  );
  await assert.rejects(
    service.prepare({ type: 'audio', url: 'https://example.com/voice.ogg', source: 'test' }),
    (error: unknown) => error instanceof AudioValidationError && error.code === 'INVALID_AUDIO_URL',
  );
});

const prepared: PreparedAudio = {
  data: ogg(),
  base64: ogg().toString('base64'),
  mimeType: 'audio/opus',
  sizeBytes: ogg().length,
  duration: 1,
  sha256: 'voice-hash',
  source: 'test',
  temporary: true,
};

function providerFor(transcription: Transcription): SpeechToTextProvider {
  return { name: 'test', transcribeAudio: async () => transcription };
}

test('preserves successful Bangla transcription', async () => {
  const result = await new SpeechToTextService(
    providerFor({ text: 'ভাই Messi polo টা কত?', language: 'bn', confidence: 0.94, duration: 1 }),
    0.6,
    100,
  ).transcribe(prepared);
  assert.equal(result.text, 'ভাই Messi polo টা কত?');
  assert.equal(result.language, 'bn');
});

test('preserves mixed Bangla-English transcription without translation', async () => {
  const text = 'ভাই XL লাগবে, price কত?';
  const result = await new SpeechToTextService(
    providerFor({ text, language: 'mixed', confidence: 0.9, duration: 1 }),
    0.6,
    100,
  ).transcribe({ ...prepared, sha256: 'mixed-hash' });
  assert.equal(result.text, text);
  assert.equal(result.language, 'mixed');
});

test('preserves English transcription', async () => {
  const result = await new SpeechToTextService(
    providerFor({ text: 'How much is this polo?', language: 'en', confidence: 0.92, duration: 1 }),
    0.6,
    100,
  ).transcribe({ ...prepared, sha256: 'english-hash' });
  assert.equal(result.language, 'en');
});

test('recognizes low-confidence transcription', () => {
  const service = new SpeechToTextService(undefined, 0.6, 100);
  assert.equal(
    service.isLowConfidence({ text: 'unclear', language: 'unknown', confidence: 0.59, duration: null }),
    true,
  );
});

test('prevents duplicate transcription calls for the same audio hash', async () => {
  let calls = 0;
  const provider: SpeechToTextProvider = {
    name: 'test',
    transcribeAudio: async () => {
      calls += 1;
      return { text: 'একই ভয়েস', language: 'bn', confidence: 0.9, duration: 1 };
    },
  };
  const service = new SpeechToTextService(provider, 0.6, 100);
  await service.transcribe(prepared);
  await service.transcribe(prepared);
  assert.equal(calls, 1);
});

test('handles provider timeout and provider failure safely', async () => {
  const timeoutProvider: SpeechToTextProvider = {
    name: 'timeout',
    transcribeAudio: async () => new Promise<Transcription>(() => undefined),
  };
  await assert.rejects(
    new SpeechToTextService(timeoutProvider, 0.6, 5).transcribe({ ...prepared, sha256: 'timeout' }),
    (error: unknown) => error instanceof SpeechToTextError,
  );
  const failedProvider: SpeechToTextProvider = {
    name: 'failed',
    transcribeAudio: async () => {
      throw new Error('secret provider detail');
    },
  };
  await assert.rejects(
    new SpeechToTextService(failedProvider, 0.6, 100).transcribe({ ...prepared, sha256: 'failed' }),
    (error: unknown) => error instanceof SpeechToTextError && !error.message.includes('secret'),
  );
});

test('parses strict provider transcription JSON and rejects invalid output', () => {
  const value = { text: 'এইটার M size আছে?', language: 'mixed', confidence: 0.91, duration: 4 };
  assert.deepEqual(parseTranscription(JSON.stringify(value)), value);
  assert.equal(parseTranscription('{"text":"guessed"}'), null);
});

test('normalizes a spoken product code only after local DB validation', async () => {
  const catalog = {
    searchProducts: async (query: string) =>
      query === 'TX170'
        ? [{ id: 6238, productCode: 'TX170 Argentina', productName: 'TX170 Messi Polo' }]
        : query === 'APL26'
          ? [{ id: 6024, productCode: 'APL26 Messi White', productName: 'APL26 Polo' }]
          : [],
  } as unknown as ProductCatalogService;
  const service = new VoiceProductCodeService(catalog);
  const result = await service.normalize('ভাই TX one seventy polo টা কত?');
  const second = await service.normalize('APL twenty six price কত?');
  assert.equal(result.normalizedText, 'ভাই TX170 polo টা কত?');
  assert.deepEqual(result.productIds, [6238]);
  assert.deepEqual(result.verifiedCodes, ['TX170']);
  assert.equal(second.normalizedText, 'APL26 price কত?');
  assert.deepEqual(second.productIds, [6024]);
});

test('does not normalize an unverified spoken product code', async () => {
  const catalog = { searchProducts: async () => [] } as unknown as ProductCatalogService;
  const text = 'ZZ one twenty four আছে?';
  const result = await new VoiceProductCodeService(catalog).normalize(text);
  assert.equal(result.normalizedText, text);
  assert.deepEqual(result.productIds, []);
});
