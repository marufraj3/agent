import { GoogleGenAI } from '@google/genai';
import { getCircuitBreaker } from '../../../infrastructure/circuit-breaker.js';
import type {
  AIAudioProviderRequest,
  AIImageProviderRequest,
  AIProvider,
  AIProviderRequest,
  AIProviderResponse,
} from './ai-provider.js';

export interface GeminiProviderConfig {
  apiKey: string;
  model: string;
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
}

export class GeminiProvider implements AIProvider {
  readonly name = 'gemini';
  readonly model: string;
  private readonly client: GoogleGenAI;
  private readonly breaker = getCircuitBreaker('gemini');

  constructor(private readonly config: GeminiProviderConfig) {
    this.model = config.model;
    this.client = new GoogleGenAI({ apiKey: config.apiKey });
  }

  async generateStructured(request: AIProviderRequest): Promise<AIProviderResponse> {
    const response = await this.reliable(() => this.client.models.generateContent({
      model: this.config.model,
      contents: request.prompt,
      config: {
        systemInstruction: request.systemInstruction,
        responseMimeType: 'application/json',
        responseJsonSchema: request.responseJsonSchema,
        temperature: this.config.temperature,
        maxOutputTokens: this.config.maxOutputTokens,
        httpOptions: { timeout: this.config.timeoutMs },
      },
    }));

    const text = response.text?.trim();
    if (!text) throw new Error('Gemini returned an empty response');
    return { text, model: this.config.model };
  }

  async analyzeImage(request: AIImageProviderRequest): Promise<AIProviderResponse> {
    const response = await this.reliable(() => this.client.models.generateContent({
      model: this.config.model,
      contents: [
        {
          role: 'user',
          parts: [
            { text: request.prompt },
            {
              inlineData: {
                data: request.image.data,
                mimeType: request.image.mimeType,
              },
            },
          ],
        },
      ],
      config: {
        systemInstruction: request.systemInstruction,
        responseMimeType: 'application/json',
        responseJsonSchema: request.responseJsonSchema,
        temperature: 0,
        maxOutputTokens: this.config.maxOutputTokens,
        httpOptions: { timeout: this.config.timeoutMs },
      },
    }));

    const text = response.text?.trim();
    if (!text) throw new Error('Gemini returned an empty image analysis response');
    return { text, model: this.config.model };
  }

  async transcribeAudio(request: AIAudioProviderRequest): Promise<AIProviderResponse> {
    const response = await this.reliable(() => this.client.models.generateContent({
      model: this.config.model,
      contents: [
        {
          role: 'user',
          parts: [
            { text: request.prompt },
            {
              inlineData: {
                data: request.audio.data,
                mimeType: request.audio.mimeType,
              },
            },
          ],
        },
      ],
      config: {
        systemInstruction: request.systemInstruction,
        responseMimeType: 'application/json',
        responseJsonSchema: request.responseJsonSchema,
        temperature: 0,
        maxOutputTokens: this.config.maxOutputTokens,
        httpOptions: { timeout: this.config.timeoutMs },
      },
    }));

    const text = response.text?.trim();
    if (!text) throw new Error('Gemini returned an empty audio transcription response');
    return { text, model: this.config.model };
  }

  private async reliable<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try { return await this.breaker.execute(operation); }
      catch (error) {
        lastError = error;
        if (!this.isTemporary(error) || attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
    throw lastError;
  }

  private isTemporary(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const value = error as Error & { status?: number; code?: number | string };
    const status = Number(value.status ?? value.code);
    return value.name === 'AbortError' || /timeout|temporar|network|fetch/i.test(value.message) || status === 429 || status >= 500;
  }

}
