import { z } from 'zod';

export const supportedAudioMimeTypes = [
  'audio/ogg',
  'audio/opus',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/webm',
  'audio/mp4',
  'audio/m4a',
  'audio/aac',
  'audio/flac',
  'audio/amr',
] as const;
export type SupportedAudioMimeType = (typeof supportedAudioMimeTypes)[number];

export const audioInputSchema = z
  .object({
    type: z.literal('audio').default('audio'),
    url: z.url().max(2_048).optional(),
    data: z.string().min(1).optional(),
    mimeType: z.enum(supportedAudioMimeTypes).optional(),
    duration: z.number().positive().max(86_400).optional(),
    source: z.string().trim().min(1).max(50).default('web'),
  })
  .strict()
  .refine((audio) => Boolean(audio.url) !== Boolean(audio.data), {
    message: 'Provide exactly one of audio.url or audio.data',
  });
export type AudioInput = z.infer<typeof audioInputSchema>;

export interface PreparedAudio {
  data: Buffer;
  base64: string;
  mimeType: SupportedAudioMimeType;
  sizeBytes: number;
  duration: number | null;
  sha256: string;
  source: string;
  temporary: true;
}

export const transcriptionSchema = z
  .object({
    text: z.string().trim().min(1).max(10_000),
    language: z.enum(['bn', 'en', 'mixed', 'unknown']),
    // Some providers do not return calibrated confidence. Preserve that fact;
    // never synthesize a score merely to satisfy the transport schema.
    confidence: z.number().min(0).max(1).nullable(),
    duration: z.number().nonnegative().max(86_400).nullable(),
  })
  .strict();
export type Transcription = z.infer<typeof transcriptionSchema>;
