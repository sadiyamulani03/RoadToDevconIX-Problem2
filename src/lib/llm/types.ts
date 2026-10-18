import type { GenerationFallbackReason, ModelOutput, SemanticIssue } from "../domain/schema";

export interface GenerationInput {
  headline: string;
  articleSnippet: string | null;
}

export interface GenerationCorrection {
  issues: Array<Pick<SemanticIssue, "code" | "severity" | "field" | "message">>;
}

export interface ProviderGenerationOptions {
  correction?: GenerationCorrection;
}

export interface ProviderResult {
  /** Runtime-validated model output. Never a raw JSON.parse result. */
  output: ModelOutput;
  provider: string;
  /** Number of HTTP attempts performed for this result (>= 1). */
  requests: number;
}

export type ProviderMode = "llm" | "heuristic";

export interface MarketGenerationProvider {
  readonly name: string;
  readonly mode: ProviderMode;
  readonly model: string | null;
  readonly fallbackReason: GenerationFallbackReason | null;
  generate(
    input: GenerationInput,
    options?: ProviderGenerationOptions,
  ): Promise<ProviderResult>;
}
