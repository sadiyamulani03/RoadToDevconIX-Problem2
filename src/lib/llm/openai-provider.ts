import { ModelOutputSchema } from "../domain/schema";
import { MarketProviderError, type MarketProviderErrorCode } from "./errors";
import { buildProviderJsonSchema } from "./json-schema";
import { buildMessages } from "./prompt";
import type {
  GenerationInput,
  MarketGenerationProvider,
  ProviderGenerationOptions,
  ProviderResult,
} from "./types";
import type { GenerationFallbackReason } from "../domain/schema";

export interface OpenAiCompatibleProviderOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  structuredOutput: "json_schema" | "json_object" | "none";
  /** Hard timeout for every single HTTP request. Enforced via AbortSignal.timeout. */
  timeoutMs: number;
  /** Total attempts: 1 initial call + (maxAttempts - 1) retries. */
  maxAttempts: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => Date;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

interface RetryableDecision {
  code: MarketProviderErrorCode;
  retryable: boolean;
  message: string;
}

const RETRYABLE_STATUS: Record<number, MarketProviderErrorCode> = {
  408: "timeout",
  409: "server_error",
  425: "server_error",
  429: "rate_limited",
};

function classifyStatus(status: number): RetryableDecision {
  if (status === 401 || status === 403) {
    return {
      code: "auth_error",
      retryable: false,
      message: "The model provider rejected the configured credentials.",
    };
  }
  if (RETRYABLE_STATUS[status]) {
    const code = RETRYABLE_STATUS[status];
    return {
      code,
      retryable: true,
      message: `The model provider returned a transient error (HTTP ${status}).`,
    };
  }
  if (status >= 500) {
    return {
      code: "server_error",
      retryable: true,
      message: `The model provider returned a server error (HTTP ${status}).`,
    };
  }
  return {
    code: "invalid_request",
    retryable: false,
    message: `The model request was rejected by the provider (HTTP ${status}).`,
  };
}

function extractJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const body = fenced ? fenced[1] : trimmed;
  return JSON.parse(body) as unknown;
}

function summarizeIssues(issues: Array<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .slice(0, 3)
    .map((issue) => {
      const path = issue.path.map(String).join(".") || "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

export class OpenAiCompatibleProvider implements MarketGenerationProvider {
  readonly name: string;
  readonly mode = "llm" as const;
  readonly model: string;
  readonly fallbackReason: GenerationFallbackReason | null = null;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly structuredOutput: OpenAiCompatibleProviderOptions["structuredOutput"];
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;

  constructor(options: OpenAiCompatibleProviderOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.model = options.model;
    this.name = `openai-compatible:${options.model}`;
    this.structuredOutput = options.structuredOutput;
    this.timeoutMs = options.timeoutMs;
    this.maxAttempts = options.maxAttempts;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl =
      options.sleepImpl ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => new Date());
    this.backoffBaseMs = options.backoffBaseMs ?? 500;
    this.backoffMaxMs = options.backoffMaxMs ?? 4_000;
  }

  async generate(
    input: GenerationInput,
    options: ProviderGenerationOptions = {},
  ): Promise<ProviderResult> {
    let lastError: MarketProviderError | null = null;
    let previousRawOutput: string | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const rawContent = await this.performRequest(input, options, previousRawOutput);
        const output = this.parseAndValidate(rawContent, attempt);
        return { output, provider: this.name, requests: attempt };
      } catch (error) {
        const providerError = this.toProviderError(error, attempt);
        lastError = providerError;
        if (!providerError.retryable || attempt >= this.maxAttempts) {
          throw providerError;
        }
        await this.sleepImpl(this.backoffDelay(attempt));
      }
    }

    // Unreachable: the loop either returns or throws. Kept as a hard bound.
    throw (
      lastError ??
      new MarketProviderError("The model request failed.", "server_error", false, this.maxAttempts)
    );
  }

  private backoffDelay(attempt: number): number {
    return Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** (attempt - 1));
  }

  private async performRequest(
    input: GenerationInput,
    options: ProviderGenerationOptions,
    previousRawOutput: string | undefined,
  ): Promise<string> {
    const messages = buildMessages(input, {
      now: this.now(),
      previousOutput: previousRawOutput,
      correction: options.correction,
    });

    const body: Record<string, unknown> = {
      model: this.model,
      temperature: 0.2,
      messages,
    };

    if (this.structuredOutput === "json_schema") {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: "headline_to_market_output",
          strict: true,
          schema: buildProviderJsonSchema(),
        },
      };
    } else if (this.structuredOutput === "json_object") {
      body.response_format = { type: "json_object" };
    }

    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const decision = classifyStatus(response.status);
      throw new MarketProviderError(decision.message, decision.code, decision.retryable, 1);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new MarketProviderError(
        "The model provider returned a response that was not valid JSON.",
        "invalid_output",
        true,
        1,
        { cause: error },
      );
    }

    const content = this.extractContent(payload);
    if (typeof content !== "string" || content.trim() === "") {
      throw new MarketProviderError(
        "The model provider returned an empty response.",
        "invalid_output",
        true,
        1,
      );
    }
    return content;
  }

  private extractContent(payload: unknown): string | null {
    if (payload === null || typeof payload !== "object") return null;
    const choices = (payload as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) return null;
    const first = choices[0] as { message?: { content?: unknown } } | undefined;
    const content = first?.message?.content;
    return typeof content === "string" ? content : null;
  }

  private parseAndValidate(rawContent: string, attempt: number) {
    let json: unknown;
    try {
      json = extractJson(rawContent);
    } catch (error) {
      throw new MarketProviderError(
        "The model response could not be parsed as JSON.",
        "invalid_output",
        true,
        attempt,
        { cause: error },
      );
    }

    const parsed = ModelOutputSchema.safeParse(json);
    if (!parsed.success) {
      throw new MarketProviderError(
        `The model response did not match the required market schema (${summarizeIssues(parsed.error.issues)}).`,
        "invalid_output",
        true,
        attempt,
      );
    }
    return parsed.data;
  }

  private toProviderError(error: unknown, attempt: number): MarketProviderError {
    if (error instanceof MarketProviderError) {
      return new MarketProviderError(error.message, error.code, error.retryable, attempt, {
        cause: error,
      });
    }

    const name = error instanceof Error ? error.name : "";
    if (name === "AbortError" || name === "TimeoutError") {
      return new MarketProviderError(
        `The model request exceeded the ${this.timeoutMs} ms timeout.`,
        "timeout",
        true,
        attempt,
        { cause: error },
      );
    }

    if (error instanceof TypeError) {
      return new MarketProviderError(
        "The model provider could not be reached over the network.",
        "network",
        true,
        attempt,
        { cause: error },
      );
    }

    return new MarketProviderError("The model request failed unexpectedly.", "server_error", false, attempt, {
      cause: error,
    });
  }
}
