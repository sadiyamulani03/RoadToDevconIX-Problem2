import type { MarketGenerationProvider } from "./types";
import { createHeuristicProvider } from "./heuristic-provider";
import { OpenAiCompatibleProvider } from "./openai-provider";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 120_000;
export const MIN_ATTEMPTS = 1;
export const MAX_ATTEMPTS = 5;

export type StructuredOutputMode = "json_schema" | "json_object" | "none";

export interface LlmRuntimeConfig {
  mode: "llm" | "heuristic";
  apiKey: string | null;
  baseUrl: string;
  model: string;
  structuredOutput: StructuredOutputMode;
  /** Hard timeout for every single HTTP request, in milliseconds. */
  timeoutMs: number;
  /** Total attempts per request: 1 initial call + (n - 1) retries. */
  maxAttempts: number;
  fallbackReason: "no_api_key" | "forced_heuristic" | null;
}

function readBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function readStructuredOutputMode(raw: string | undefined): StructuredOutputMode {
  const value = (raw ?? "json_schema").trim().toLowerCase();
  if (value === "json_object" || value === "none") return value;
  return "json_schema";
}

/** Env values are only ever read, so a plain string map is the widest safe type. */
export type EnvLike = Record<string, string | undefined>;

export function loadLlmConfig(env: EnvLike = process.env): LlmRuntimeConfig {
  const requestedProvider = (env.LLM_PROVIDER ?? "auto").trim().toLowerCase();
  const apiKey = env.LLM_API_KEY?.trim() ? env.LLM_API_KEY.trim() : null;

  let mode: "llm" | "heuristic";
  let fallbackReason: LlmRuntimeConfig["fallbackReason"] = null;
  if (requestedProvider === "heuristic") {
    mode = "heuristic";
    fallbackReason = apiKey ? "forced_heuristic" : "no_api_key";
  } else if (requestedProvider === "auto" || requestedProvider === "llm" || requestedProvider === "") {
    if (apiKey) {
      mode = "llm";
    } else {
      mode = "heuristic";
      fallbackReason = "no_api_key";
    }
  } else {
    // Unknown value: fall back to auto semantics rather than crashing the UI.
    mode = apiKey ? "llm" : "heuristic";
    fallbackReason = apiKey ? null : "no_api_key";
  }

  const baseUrl = (env.LLM_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = env.LLM_MODEL?.trim() || "gpt-4o-mini";

  return {
    mode,
    apiKey,
    baseUrl,
    model,
    structuredOutput: readStructuredOutputMode(env.LLM_STRUCTURED_OUTPUT),
    timeoutMs: readBoundedInt(env.LLM_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    maxAttempts: readBoundedInt(env.LLM_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS, MIN_ATTEMPTS, MAX_ATTEMPTS),
    fallbackReason,
  };
}

export interface ProviderFactoryOverrides {
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export function createProviderFromConfig(
  config: LlmRuntimeConfig,
  overrides: ProviderFactoryOverrides = {},
): MarketGenerationProvider {
  if (config.mode === "heuristic" || !config.apiKey) {
    return createHeuristicProvider({
      fallbackReason: config.fallbackReason,
      now: overrides.now,
    });
  }
  return new OpenAiCompatibleProvider({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    structuredOutput: config.structuredOutput,
    timeoutMs: config.timeoutMs,
    maxAttempts: config.maxAttempts,
    fetchImpl: overrides.fetchImpl,
    sleepImpl: overrides.sleepImpl,
    now: overrides.now,
  });
}
