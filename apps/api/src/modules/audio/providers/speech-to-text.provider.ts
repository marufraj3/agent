import type { PreparedAudio, Transcription } from '../audio.types.js';

export interface SpeechToTextProvider {
  readonly name: string;
  transcribeAudio(audio: PreparedAudio): Promise<Transcription>;
}
