import type { AIProvider } from '../../ai/providers/ai-provider.js';
import { transcriptionSchema, type PreparedAudio, type Transcription } from '../audio.types.js';
import type { SpeechToTextProvider } from './speech-to-text.provider.js';

export const TRANSCRIPTION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string' },
    language: { type: 'string', enum: ['bn', 'en', 'mixed', 'unknown'] },
    confidence: { anyOf: [{ type: 'number', minimum: 0, maximum: 1 }, { type: 'null' }] },
    duration: { anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }] },
  },
  required: ['text', 'language', 'confidence', 'duration'],
};

export class SpeechToTextProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpeechToTextProviderError';
  }
}

function parseTranscription(text: string): Transcription | null {
  const trimmed = text.trim();
  const candidates = [
    trimmed,
    trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''),
  ];
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(text.slice(firstBrace, lastBrace + 1));
  for (const candidate of [...new Set(candidates)]) {
    try {
      const parsed = transcriptionSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      // Try the next safe JSON candidate.
    }
  }
  return null;
}

export class GeminiSpeechToTextProvider implements SpeechToTextProvider {
  readonly name = 'gemini';

  constructor(private readonly gemini: AIProvider) {}

  async transcribeAudio(audio: PreparedAudio): Promise<Transcription> {
    if (!this.gemini.transcribeAudio) {
      throw new SpeechToTextProviderError('Configured Gemini provider does not support audio');
    }
    const response = await this.gemini.transcribeAudio({
      systemInstruction: `You are a speech-to-text engine for Alzeena Fashion customer messages.
Transcribe faithfully without translating. Support Bangla, English, Banglish, and mixed speech. Preserve product names, sizes, and spoken product-code letters/numbers as heard. Never answer the customer and never invent inaudible words. Return only structured JSON. Set confidence to null unless the speech model itself provides a calibrated confidence score; never invent one.`,
      prompt: `Transcribe this audio exactly as spoken.
Use language="bn" for primarily Bangla script, "en" for English, "mixed" for Bangla/Banglish plus English, and "unknown" when unclear.
Return duration=${audio.duration ?? 'null'} when supplied; otherwise provide a best estimate or null.`,
      responseJsonSchema: TRANSCRIPTION_JSON_SCHEMA,
      audio: { data: audio.base64, mimeType: audio.mimeType },
    });
    const transcription = parseTranscription(response.text);
    if (!transcription) throw new SpeechToTextProviderError('Provider returned invalid transcription JSON');
    return {
      ...transcription,
      duration: audio.duration ?? transcription.duration,
    };
  }
}

export { parseTranscription };
