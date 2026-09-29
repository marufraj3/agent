import { GoogleGenAI } from '@google/genai';
import type { AIProvider, AIProviderRequest, AIProviderResponse } from './ai-provider.js';

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

  constructor(private readonly config: GeminiProviderConfig) {
    this.model = config.model;
    this.client = new GoogleGenAI({ apiKey: config.apiKey });
  }

  async generateStructured(request: AIProviderRequest): Promise<AIProviderResponse> {
    const response = await this.client.models.generateContent({
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
    });

    const text = response.text?.trim();
    if (!text) throw new Error('Gemini returned an empty response');
    return { text, model: this.config.model };
  }
}
