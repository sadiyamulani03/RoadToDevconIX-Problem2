import type {
  GenerationInfo,
  MarketFields,
  MarketRecord,
  UnresolvableOutcome,
} from "../domain/schema";

/**
 * Client-side API types. These are type-only imports: the Zod schemas are
 * never shipped to the browser, the server remains the validation authority.
 */

export interface ProviderInfo {
  name: string;
  mode: "llm" | "heuristic";
  model: string | null;
  fallbackReason: "no_api_key" | "forced_heuristic" | null;
}

export interface RuntimeConfig {
  provider: ProviderInfo;
  sourceVerification: "syntactic-only";
  accessControl: { editorTokenRequired: boolean };
}

export interface DraftResolvableResponse {
  outcome: "resolvable";
  market: MarketRecord;
  generation: GenerationInfo;
}

export interface DraftUnresolvableResponse {
  outcome: "unresolvable";
  rejection: UnresolvableOutcome;
  generation: GenerationInfo;
}

export type DraftResponse = DraftResolvableResponse | DraftUnresolvableResponse;

export interface MarketResponse {
  market: MarketRecord;
}

export interface MarketsResponse {
  markets: MarketRecord[];
}

export interface ApiErrorInfo {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: ApiErrorInfo };

export type EditableMarket = MarketFields;
