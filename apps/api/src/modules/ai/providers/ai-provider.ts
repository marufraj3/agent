export interface AIProviderRequest {
  systemInstruction: string;
  prompt: string;
  responseJsonSchema: Record<string, unknown>;
}

export interface AIProviderResponse {
  text: string;
  model: string;
}

export interface AIProviderMedia {
  data: string;
  mimeType: string;
}

export interface AIImageProviderRequest extends AIProviderRequest {
  image: AIProviderMedia;
}

export interface AIAudioProviderRequest extends AIProviderRequest {
  audio: AIProviderMedia;
}

export interface AIProvider {
  readonly name: string;
  readonly model: string;
  generateStructured(request: AIProviderRequest): Promise<AIProviderResponse>;
  analyzeImage?(request: AIImageProviderRequest): Promise<AIProviderResponse>;
  transcribeAudio?(request: AIAudioProviderRequest): Promise<AIProviderResponse>;
}
