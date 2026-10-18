import { describe, expect, test } from "vitest";
import { ZodError, z } from "zod";
import { HttpError, errorResponse, handleRouteError, readJsonBody } from "../../src/lib/http";
import { MarketProviderError } from "../../src/lib/llm/errors";
import { MarketServiceError } from "../../src/lib/market-service";

async function jsonBody(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("readJsonBody", () => {
  test("parses a valid JSON body", async () => {
    const request = new Request("http://app.test/api/draft", {
      method: "POST",
      body: JSON.stringify({ headline: "Will it happen by 2027?" }),
    });
    const body = (await readJsonBody(request)) as { headline: string };
    expect(body.headline).toBe("Will it happen by 2027?");
  });

  test("rejects malformed JSON with a 400, not a 500", async () => {
    const request = new Request("http://app.test/api/draft", { method: "POST", body: "{{{" });
    const error = await readJsonBody(request).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(400);
    expect((error as HttpError).code).toBe("invalid_json");
  });

  test("rejects an empty body", async () => {
    const request = new Request("http://app.test/api/draft", { method: "POST", body: "" });
    const error = await readJsonBody(request).catch((caught: unknown) => caught);
    expect((error as HttpError).code).toBe("empty_request_body");
  });

  test("rejects an oversized body", async () => {
    const request = new Request("http://app.test/api/draft", {
      method: "POST",
      body: JSON.stringify({ headline: "x".repeat(70_000) }),
    });
    const error = await readJsonBody(request).catch((caught: unknown) => caught);
    expect((error as HttpError).status).toBe(413);
    expect((error as HttpError).code).toBe("request_too_large");
  });
});

describe("controlled error responses (Check 7)", () => {
  test("maps provider timeouts to a 504 with retry guidance and no internals", async () => {
    const response = handleRouteError(
      new MarketProviderError(
        "The model request exceeded the 30000 ms timeout.",
        "timeout",
        true,
        3,
      ),
    );
    expect(response.status).toBe(504);
    const body = await jsonBody(response);
    const error = body.error as { code: string; message: string; retryable: boolean };
    expect(error.code).toBe("llm_timeout");
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("No draft was created");
    expect(JSON.stringify(body)).not.toContain("stack");
  });

  test("maps invalid model output to a controlled 502", async () => {
    const response = handleRouteError(
      new MarketProviderError("schema mismatch details", "invalid_output", true, 3),
    );
    expect(response.status).toBe(502);
    const body = await jsonBody(response);
    expect((body.error as { code: string }).code).toBe("llm_invalid_response");
    expect(JSON.stringify(body)).not.toContain("schema mismatch details");
  });

  test("maps a Zod request error to a structured 400", async () => {
    const schema = z.object({ headline: z.string().min(5) });
    const parsed = schema.safeParse({ headline: "x" });
    expect(parsed.success).toBe(false);
    const response = handleRouteError(parsed.error as ZodError);
    expect(response.status).toBe(400);
    const body = await jsonBody(response);
    const error = body.error as { code: string; details: Array<{ path: string }> };
    expect(error.code).toBe("invalid_request");
    expect(error.details[0].path).toBe("headline");
  });

  test("maps service errors to their status codes", async () => {
    const response = handleRouteError(new MarketServiceError("not_found", "No market with id x."));
    expect(response.status).toBe(404);
    const body = await jsonBody(response);
    expect((body.error as { code: string }).code).toBe("not_found");
  });

  test("unexpected errors never leak messages, stacks or secrets", async () => {
    const response = handleRouteError(new Error("boom secret-token-value-xyz at line 42"));
    expect(response.status).toBe(500);
    const body = await jsonBody(response);
    const error = body.error as { code: string; message: string };
    expect(error.code).toBe("internal_error");
    expect(error.message).toBe("An unexpected server error occurred.");
    const text = JSON.stringify(body);
    expect(text).not.toContain("secret-token-value-xyz");
    expect(text).not.toContain("at line");
  });

  test("errorResponse always sets retryable explicitly", async () => {
    const body = await jsonBody(errorResponse(400, "x", "y"));
    expect((body.error as { retryable: boolean }).retryable).toBe(false);
  });
});
