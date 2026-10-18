import { describe, expect, test, vi } from "vitest";
import { OpenAiCompatibleProvider } from "../../src/lib/llm/openai-provider";
import { MarketProviderError } from "../../src/lib/llm/errors";
import { buildProviderJsonSchema } from "../../src/lib/llm/json-schema";
import { validResolvableOutput } from "../helpers/fixtures";

/**
 * Checks 5 and 6 — explicit timeout and a numeric cap on retries. Both are
 * exercised against the real provider class with an injected fetch so no
 * network call is made.
 */

function chatResponse(content: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const noSleep = async () => {};

function makeProvider(
  fetchImpl: typeof fetch,
  overrides: Partial<ConstructorParameters<typeof OpenAiCompatibleProvider>[0]> = {},
) {
  return new OpenAiCompatibleProvider({
    apiKey: "test-key-not-real",
    baseUrl: "https://provider.test/v1",
    model: "test-model",
    structuredOutput: "json_schema",
    timeoutMs: 5_000,
    maxAttempts: 3,
    fetchImpl,
    sleepImpl: noSleep,
    ...overrides,
  });
}

const INPUT = { headline: "Will the RBI cut the repo rate by 31 December 2027?", articleSnippet: null };

describe("explicit timeout (Check 5)", () => {
  test("every request carries an AbortSignal and a configured timeout", async () => {
    let seenSignal: AbortSignal | null | undefined;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenSignal = init?.signal;
      return chatResponse(JSON.stringify(validResolvableOutput()));
    }) as unknown as typeof fetch;

    const provider = makeProvider(fetchImpl, { timeoutMs: 12_345 });
    await provider.generate(INPUT);
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal?.aborted).toBe(false);
  });

  test("a hanging request is aborted and surfaces a controlled timeout error", async () => {
    const hangingFetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("The operation was aborted.");
          error.name = "TimeoutError";
          reject(error);
        });
      })) as unknown as typeof fetch;

    const provider = makeProvider(hangingFetch, { timeoutMs: 40, maxAttempts: 1 });
    const startedAt = Date.now();
    const error = await provider.generate(INPUT).catch((caught: unknown) => caught);
    const elapsed = Date.now() - startedAt;

    expect(error).toBeInstanceOf(MarketProviderError);
    expect((error as MarketProviderError).code).toBe("timeout");
    expect((error as MarketProviderError).retryable).toBe(true);
    expect(elapsed).toBeLessThan(2_000);
  });

  test("timeout errors are retried up to the cap, never forever", async () => {
    let calls = 0;
    const hangingFetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "TimeoutError";
          reject(error);
        });
      });
    }) as unknown as typeof fetch;

    const provider = makeProvider(hangingFetch, { timeoutMs: 20, maxAttempts: 3 });
    const error = await provider.generate(INPUT).catch((caught: unknown) => caught);
    expect((error as MarketProviderError).code).toBe("timeout");
    expect(calls).toBe(3);
  });
});

describe("capped retries (Check 6)", () => {
  test("permanent client errors are not retried", async () => {
    const fetchImpl = vi.fn(async () => chatResponse("{}", 401)) as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl);
    const error = await provider.generate(INPUT).catch((caught: unknown) => caught);
    expect((error as MarketProviderError).code).toBe("auth_error");
    expect((error as MarketProviderError).retryable).toBe(false);
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  test("a 400 invalid request is not retried", async () => {
    const fetchImpl = vi.fn(async () => chatResponse("{}", 400)) as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl);
    const error = await provider.generate(INPUT).catch((caught: unknown) => caught);
    expect((error as MarketProviderError).code).toBe("invalid_request");
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  test("retryable server errors stop exactly at maxAttempts", async () => {
    const fetchImpl = vi.fn(async () => chatResponse("boom", 500)) as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl, { maxAttempts: 3 });
    const error = await provider.generate(INPUT).catch((caught: unknown) => caught);
    expect((error as MarketProviderError).code).toBe("server_error");
    expect((error as MarketProviderError).retryable).toBe(true);
    expect((error as MarketProviderError).attempts).toBe(3);
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });

  test("rate limits are retried within the cap", async () => {
    const fetchImpl = vi.fn(async () => chatResponse("slow down", 429)) as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl, { maxAttempts: 2 });
    const error = await provider.generate(INPUT).catch((caught: unknown) => caught);
    expect((error as MarketProviderError).code).toBe("rate_limited");
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  test("invalid model output is retried but bounded, then reported as invalid_output", async () => {
    const fetchImpl = vi.fn(async () => chatResponse("this is not json")) as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl, { maxAttempts: 4 });
    const error = await provider.generate(INPUT).catch((caught: unknown) => caught);
    expect((error as MarketProviderError).code).toBe("invalid_output");
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls.length).toBe(4);
  });

  test("succeeds after a transient malformed response and reports the attempt count", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(chatResponse("not json at all"))
      .mockResolvedValueOnce(chatResponse(JSON.stringify(validResolvableOutput()))) as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl, { maxAttempts: 3 });
    const result = await provider.generate(INPUT);
    expect(result.requests).toBe(2);
    expect(result.output.outcome).toBe("resolvable");
  });

  test("network failures are classified as retryable and bounded", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl, { maxAttempts: 2 });
    const error = await provider.generate(INPUT).catch((caught: unknown) => caught);
    expect((error as MarketProviderError).code).toBe("network");
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });
});

describe("provider request shape and output validation", () => {
  test("sends the headline in a user message and never in the system instruction", async () => {
    let body: Record<string, unknown> | null = null;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return chatResponse(JSON.stringify(validResolvableOutput()));
    }) as unknown as typeof fetch;

    const headline = "Will the RBI cut the repo rate by 31 December 2027?";
    await makeProvider(fetchImpl).generate({ headline, articleSnippet: null });

    const messages = (body as unknown as { messages: Array<{ role: string; content: string }> }).messages;
    const system = messages.filter((message) => message.role === "system");
    const user = messages.filter((message) => message.role === "user");
    expect(system.some((message) => message.content.includes(headline))).toBe(false);
    expect(user.some((message) => message.content.includes(headline))).toBe(true);
    expect(body).not.toBeNull();
    const sent = body as unknown as { response_format: { type: string; json_schema?: unknown } };
    expect(sent.response_format.type).toBe("json_schema");
  });

  test("accepts fenced JSON but still validates it against the schema", async () => {
    const fenced = "```json\n" + JSON.stringify(validResolvableOutput()) + "\n```";
    const fetchImpl = vi.fn(async () => chatResponse(fenced)) as unknown as typeof fetch;
    const result = await makeProvider(fetchImpl).generate(INPUT);
    expect(result.output.outcome).toBe("resolvable");
  });

  test("rejects a model response that tries to approve itself", async () => {
    const attempted = JSON.stringify({ ...validResolvableOutput(), status: "approved" });
    const fetchImpl = vi.fn(async () => chatResponse(attempted)) as unknown as typeof fetch;
    const error = await makeProvider(fetchImpl, { maxAttempts: 1 })
      .generate(INPUT)
      .catch((caught: unknown) => caught);
    expect((error as MarketProviderError).code).toBe("invalid_output");
  });

  test("rejects an empty completion", async () => {
    const fetchImpl = vi.fn(async () => chatResponse("")) as unknown as typeof fetch;
    const error = await makeProvider(fetchImpl, { maxAttempts: 1 })
      .generate(INPUT)
      .catch((caught: unknown) => caught);
    expect((error as MarketProviderError).code).toBe("invalid_output");
  });

  test("derived provider JSON schema uses anyOf with both outcome constants", () => {
    const schema = buildProviderJsonSchema();
    const text = JSON.stringify(schema);
    expect(text).toContain("unresolvable");
    expect(text).toContain("resolvable");
    expect(schema).not.toHaveProperty("oneOf");
    expect(text).not.toContain('"format"');
  });
});
