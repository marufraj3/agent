import type { PreparedAudio, Transcription } from './audio.types.js';
import type { SpeechToTextProvider } from './providers/speech-to-text.provider.js';

export class SpeechToTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpeechToTextError';
  }
}

export class SpeechToTextDurationError extends SpeechToTextError {
  constructor() {
    super('Transcribed audio exceeds the configured duration limit');
    this.name = 'SpeechToTextDurationError';
  }
}

export class SpeechToTextService {
  private readonly cache = new Map<string, Transcription>();

  constructor(
    private readonly provider: SpeechToTextProvider | undefined,
    readonly lowConfidenceThreshold: number,
    private readonly timeoutMs: number,
    private readonly maxDurationSeconds = Number.POSITIVE_INFINITY,
  ) {}

  async transcribe(audio: PreparedAudio): Promise<Transcription> {
    const cached = this.cache.get(audio.sha256);
    if (cached) return cached;
    if (!this.provider) throw new SpeechToTextError('Speech-to-text provider is not configured');

    let timeout: NodeJS.Timeout | undefined;
    try {
      const transcription = await Promise.race([
        this.provider.transcribeAudio(audio),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new SpeechToTextError('Speech-to-text provider timed out')),
            this.timeoutMs,
          );
        }),
      ]);
      if (
        transcription.duration !== null &&
        transcription.duration > this.maxDurationSeconds
      ) {
        throw new SpeechToTextDurationError();
      }
      if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value ?? '');
      this.cache.set(audio.sha256, transcription);
      return transcription;
    } catch (error) {
      if (error instanceof SpeechToTextError) throw error;
      throw new SpeechToTextError('Speech-to-text provider failed');
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  isLowConfidence(transcription: Transcription): boolean {
    return transcription.language === 'unknown' || (
      transcription.confidence !== null && transcription.confidence < this.lowConfidenceThreshold
    );
  }
}
