import { describe, expect, test } from "vitest";
import {
  createProviderFromConfig,
  loadLlmConfig,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_TIMEOUT_MS,
  MAX_ATTEMPTS,
  MAX_TIMEOUT_MS,
  MIN_ATTEMPTS,
  MIN_TIMEOUT_MS,
} from "../../src/lib/llm/config";

describe("LLM runtime configuration", () => {
  test("defaults to the clearly-labelled heuristic mode without an API key", () => {
    const config = loadLlmConfig({});
    expect(config.mode).toBe("heuristic");
    expect(config.fallbackReason).toBe("no_api_key");
    expect(config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(config.maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(config.apiKey).toBeNull();
  });

  test("uses the LLM mode when an API key is configured", () => {
    const config = loadLlmConfig({ LLM_API_KEY: "test-key-not-real" });
    expect(config.mode).toBe("llm");
    expect(config.fallbackReason).toBeNull();
  });

  test("LLM_PROVIDER=heuristic forces the fallback even with a key", () => {
    const config = loadLlmConfig({ LLM_API_KEY: "test-key-not-real", LLM_PROVIDER: "heuristic" });
    expect(config.mode).toBe("heuristic");
    expect(config.fallbackReason).toBe("forced_heuristic");
  });

  test("unknown provider values degrade safely", () => {
    expect(loadLlmConfig({ LLM_PROVIDER: "banana" }).mode).toBe("heuristic");
    expect(loadLlmConfig({ LLM_PROVIDER: "banana", LLM_API_KEY: "k" }).mode).toBe("llm");
  });

  test("timeout is clamped into a finite, sane range", () => {
    expect(loadLlmConfig({ LLM_TIMEOUT_MS: "10" }).timeoutMs).toBe(MIN_TIMEOUT_MS);
    expect(loadLlmConfig({ LLM_TIMEOUT_MS: "999999999" }).timeoutMs).toBe(MAX_TIMEOUT_MS);
    expect(loadLlmConfig({ LLM_TIMEOUT_MS: "not-a-number" }).timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(loadLlmConfig({ LLM_TIMEOUT_MS: "45000" }).timeoutMs).toBe(45_000);
  });

  test("max attempts are clamped and can never be unbounded", () => {
    expect(loadLlmConfig({ LLM_MAX_ATTEMPTS: "0" }).maxAttempts).toBe(MIN_ATTEMPTS);
    expect(loadLlmConfig({ LLM_MAX_ATTEMPTS: "999" }).maxAttempts).toBe(MAX_ATTEMPTS);
    expect(loadLlmConfig({ LLM_MAX_ATTEMPTS: "abc" }).maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(loadLlmConfig({ LLM_MAX_ATTEMPTS: "4" }).maxAttempts).toBe(4);
  });

  test("structured output mode only accepts known values", () => {
    expect(loadLlmConfig({ LLM_STRUCTURED_OUTPUT: "json_object" }).structuredOutput).toBe(
      "json_object",
    );
    expect(loadLlmConfig({ LLM_STRUCTURED_OUTPUT: "none" }).structuredOutput).toBe("none");
    expect(loadLlmConfig({ LLM_STRUCTURED_OUTPUT: "weird" }).structuredOutput).toBe("json_schema");
  });

  test("base URL trailing slashes are trimmed", () => {
    const config = loadLlmConfig({ LLM_BASE_URL: "https://api.example.com/v1///" });
    expect(config.baseUrl).toBe("https://api.example.com/v1");
  });

  test("createProviderFromConfig returns the offline provider in heuristic mode", () => {
    const provider = createProviderFromConfig(loadLlmConfig({}));
    expect(provider.mode).toBe("heuristic");
    expect(provider.model).toBeNull();
  });
});
