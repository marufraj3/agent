export interface AIProviderRequest {
  systemInstruction: string;
  prompt: string;
  responseJsonSchema: Record<string, unknown>;
}

export interface AIProviderResponse {
  text: string;
  model: string;
}

export interface AIProviderImage {
  data: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
}

export interface AIImageProviderRequest extends AIProviderRequest {
  image: AIProviderImage;
}

export interface AIProvider {
  readonly name: string;
  readonly model: string;
  generateStructured(request: AIProviderRequest): Promise<AIProviderResponse>;
  analyzeImage?(request: AIImageProviderRequest): Promise<AIProviderResponse>;
}
