export interface AIProviderRequest {
  systemInstruction: string;
  prompt: string;
  responseJsonSchema: Record<string, unknown>;
}

export interface AIProviderResponse {
  text: string;
  model: string;
}

export interface AIProvider {
  readonly name: string;
  readonly model: string;
  generateStructured(request: AIProviderRequest): Promise<AIProviderResponse>;
}
