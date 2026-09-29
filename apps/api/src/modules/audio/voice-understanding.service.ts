import type { AudioInput, PreparedAudio, Transcription } from './audio.types.js';
import type { AudioService } from './audio.service.js';
import type { SpeechToTextService } from './speech-to-text.service.js';
import type { VoiceCodeNormalization, VoiceProductCodeService } from './voice-product-code.service.js';

export class VoiceUnderstandingService {
  constructor(
    private readonly audio: AudioService,
    private readonly speechToText: SpeechToTextService,
    private readonly productCodes: VoiceProductCodeService,
  ) {}

  prepare(input: AudioInput): Promise<PreparedAudio> {
    return this.audio.prepare(input);
  }

  transcribe(audio: PreparedAudio): Promise<Transcription> {
    return this.speechToText.transcribe(audio);
  }

  isLowConfidence(transcription: Transcription): boolean {
    return this.speechToText.isLowConfidence(transcription);
  }

  normalizeProductCodes(text: string): Promise<VoiceCodeNormalization> {
    return this.productCodes.normalize(text);
  }
}
