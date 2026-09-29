import type { ImageAnalysis, PreparedImage } from '../image.types.js';

export interface VisionAnalysisResult {
  analysis: ImageAnalysis;
  provider: string;
  model: string;
  durationMs: number;
}

/** Provider boundary for multimodal extraction. Product lookup and commerce facts stay outside it. */
export interface VisionProvider {
  readonly name: string;
  readonly model: string;
  analyzeImage(image: PreparedImage, caption?: string): Promise<VisionAnalysisResult>;
}
