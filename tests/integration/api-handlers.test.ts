import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ModelOutput } from "../../src/lib/domain/schema";
import type { MarketService } from "../../src/lib/market-service";
import { MarketStore } from "../../src/lib/db";
import { MarketService as Service } from "../../src/lib/market-service";
import {
  createApproveMarketHandler,
  createConfigHandler,
  createDiscardMarketHandler,
  createGenerateDraftHandler,
  createGetMarketHandler,
  createListMarketsHandler,
  createUpdateMarketHandler,
} from "../../src/lib/api/handlers";
import { fixedClock } from "../../src/lib/clock";
import { FailingProvider, StubProvider } from "../helpers/stub-provider";
import { MarketProviderError } from "../../src/lib/llm/errors";
import {
  FIXED_NOW,
  validMarketFields,
  validResolvableOutput,
  validUnresolvableOutput,
} from "../helpers/fixtures";

/**
 * HTTP surface tests. Handlers are framework-agnostic functions of a Request,
 * so the whole surface is exercised without a running server.
 */

const TOKEN_ENV = { EDITOR_ACCESS_TOKEN: "test-editor-token" };

let store: MarketStore;

beforeEach(() => {
  store = new MarketStore(":memory:");
});

afterEach(() => {
  store.close();
});

function serviceWith(outputs: ModelOutput[]) {
  const provider = new StubProvider(outputs);
  const service = new Service({
    store,
    provider,
    clock: fixedClock(FIXED_NOW.toISOString()),
  });
  return { service, provider };
}

function deps(
  service: MarketService,
  env: Record<string, string | undefined> = {},
): { getService: () => MarketService; env: Record<string, string | undefined> } {
  return { getService: () => service, env };
}

function postDraft(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://app.test/api/draft", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("POST /api/draft", () => {
  test("creates a draft and returns 201 with status draft", async () => {
    const { service } = serviceWith([validResolvableOutput()]);
    const handler = createGenerateDraftHandler(deps(service));
    const response = await handler(
      postDraft({ headline: "Will the RBI cut the repo rate by December 2026?" }),
    );
    expect(response.status).toBe(201);
    const body = await bodyOf(response);
    expect(body.outcome).toBe("resolvable");
    const market = body.market as { status: string; approvedAt: string | null };
    expect(market.status).toBe("draft");
    expect(market.approvedAt).toBeNull();
  });

  test("returns the explicit unresolvable outcome with 200", async () => {
    const { service } = serviceWith([validUnresolvableOutput()]);
    const handler = createGenerateDraftHandler(deps(service));
    const response = await handler(
      postDraft({ headline: "Will Bengaluru traffic improve?" }),
    );
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(body.outcome).toBe("unresolvable");
    expect((body.rejection as { reason: string }).reason.length).toBeGreaterThan(20);
  });

  test("invalid request bodies produce a 400 with structured details, not a 500", async () => {
    const { service } = serviceWith([validResolvableOutput()]);
    const handler = createGenerateDraftHandler(deps(service));
    const response = await handler(postDraft({ headline: "tiny" }));
    expect(response.status).toBe(400);
    const body = await bodyOf(response);
    expect((body.error as { code: string }).code).toBe("invalid_request");
  });

  test("oversized bodies are rejected with 413", async () => {
    const { service } = serviceWith([validResolvableOutput()]);
    const handler = createGenerateDraftHandler(deps(service));
    const response = await handler(postDraft({ headline: "Will it happen?", articleSnippet: "x".repeat(70_000) }));
    expect(response.status).toBe(413);
  });

  test("exhausted model output becomes a controlled 502 with no internals", async () => {
    const provider = new FailingProvider(
      new MarketProviderError("raw provider detail: sk-should-never-leak", "invalid_output", true, 3),
    );
    const service = new Service({
      store,
      provider,
      clock: fixedClock(FIXED_NOW.toISOString()),
    });
    const handler = createGenerateDraftHandler(deps(service));
    const response = await handler(postDraft({ headline: "Will it happen by 2027?" }));
    expect(response.status).toBe(502);
    const body = await bodyOf(response);
    const error = body.error as { code: string; message: string; retryable: boolean };
    expect(error.code).toBe("llm_invalid_response");
    expect(error.retryable).toBe(true);
    expect(JSON.stringify(body)).not.toContain("sk-should-never-leak");
    expect(JSON.stringify(body)).not.toContain("raw provider detail");
  });

  test("timeouts become a controlled, retryable 504", async () => {
    const provider = new FailingProvider(
      new MarketProviderError("The model request exceeded the 30000 ms timeout.", "timeout", true, 3),
    );
    const service = new Service({
      store,
      provider,
      clock: fixedClock(FIXED_NOW.toISOString()),
    });
    const handler = createGenerateDraftHandler(deps(service));
    const response = await handler(postDraft({ headline: "Will it happen by 2027?" }));
    expect(response.status).toBe(504);
    const body = await bodyOf(response);
    const error = body.error as { code: string; retryable: boolean; details?: { attempts?: number } };
    expect(error.code).toBe("llm_timeout");
    expect(error.retryable).toBe(true);
    expect(error.details?.attempts).toBe(3);
  });

  test("unexpected exceptions return a generic 500 without leaking the message", async () => {
    const exploding = {
      generateDraft: async () => {
        throw new Error("unexpected internal detail 12345");
      },
    } as unknown as MarketService;
    const handler = createGenerateDraftHandler(deps(exploding));
    const response = await handler(postDraft({ headline: "Will it happen by 2027?" }));
    expect(response.status).toBe(500);
    const body = await bodyOf(response);
    expect((body.error as { message: string }).message).toBe(
      "An unexpected server error occurred.",
    );
    expect(JSON.stringify(body)).not.toContain("12345");
  });
});

describe("editor token enforcement", () => {
  test("mutating endpoints reject requests without the configured token", async () => {
    const { service } = serviceWith([validResolvableOutput()]);
    const handler = createGenerateDraftHandler(deps(service, TOKEN_ENV));
    const response = await handler(postDraft({ headline: "Will it happen by 2027?" }));
    expect(response.status).toBe(401);
    const body = await bodyOf(response);
    expect((body.error as { code: string }).code).toBe("unauthorized_editor");
  });

  test("mutating endpoints accept the correct token", async () => {
    const { service } = serviceWith([validResolvableOutput()]);
    const handler = createGenerateDraftHandler(deps(service, TOKEN_ENV));
    const response = await handler(
      postDraft({ headline: "Will it happen by 2027?" }, { "x-editor-token": "test-editor-token" }),
    );
    expect(response.status).toBe(201);
  });

  test("read-only endpoints stay open without a token", async () => {
    const { service } = serviceWith([validResolvableOutput()]);
    const list = createListMarketsHandler(deps(service, TOKEN_ENV));
    const response = await list();
    expect(response.status).toBe(200);
  });
});

describe("approval and discard handlers (Check 8)", () => {
  async function createDraft(service: MarketService): Promise<string> {
    const created = await service.generateDraft({
      headline: "Will the RBI cut the repo rate by December 2026?",
      articleSnippet: null,
    });
    if (created.kind !== "resolvable") throw new Error("expected a draft");
    return created.record.id;
  }

  test("approval requires an explicit confirm:true body", async () => {
    const { service } = serviceWith([validResolvableOutput()]);
    const id = await createDraft(service);
    const handler = createApproveMarketHandler(deps(service));
    const response = await handler(
      new Request(`http://app.test/api/markets/${id}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: false }),
      }),
      id,
    );
    expect(response.status).toBe(400);
    expect(service.get(id).status).toBe("draft");
  });

  test("approval with confirm:true transitions the draft to approved", async () => {
    const { service } = serviceWith([validResolvableOutput()]);
    const id = await createDraft(service);
    const handler = createApproveMarketHandler(deps(service));
    const response = await handler(
      new Request(`http://app.test/api/markets/${id}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      }),
      id,
    );
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect((body.market as { status: string }).status).toBe("approved");
  });

  test("approving an unknown id returns 404", async () => {
    const { service } = serviceWith([validResolvableOutput()]);
    const handler = createApproveMarketHandler(deps(service));
    const id = "00000000-0000-4000-8000-000000000000";
    const response = await handler(
      new Request(`http://app.test/api/markets/${id}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      }),
      id,
    );
    expect(response.status).toBe(404);
  });

  test("discard handler marks the draft discarded", async () => {
    const { service } = serviceWith([validResolvableOutput()]);
    const id = await createDraft(service);
    const handler = createDiscardMarketHandler(deps(service));
    const response = await handler(
      new Request(`http://app.test/api/markets/${id}/discard`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      }),
      id,
    );
    expect(response.status).toBe(200);
    expect(service.get(id).status).toBe("discarded");
  });
});

describe("read and update handlers", () => {
  test("GET /api/markets lists persisted records", async () => {
    const { service } = serviceWith([validResolvableOutput()]);
    await service.generateDraft({ headline: "Will it happen by 2027?", articleSnippet: null });
    const handler = createListMarketsHandler(deps(service));
    const response = await handler();
    const body = await bodyOf(response);
    expect((body.markets as unknown[]).length).toBe(1);
  });

  test("GET /api/markets/[id] returns 404 for unknown ids", async () => {
    const { service } = serviceWith([validResolvableOutput()]);
    const handler = createGetMarketHandler(deps(service));
    const response = await handler(
      new Request("http://app.test/api/markets/missing"),
      "00000000-0000-4000-8000-000000000000",
    );
    expect(response.status).toBe(404);
  });

  test("PATCH rejects a body that is not a valid market", async () => {
    const { service } = serviceWith([validResolvableOutput()]);
    const handler = createUpdateMarketHandler(deps(service));
    const response = await handler(
      new Request("http://app.test/api/markets/x", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ market: { question: "no" } }),
      }),
      "00000000-0000-4000-8000-000000000000",
    );
    expect(response.status).toBe(400);
  });

  test("PATCH updates a draft's fields when authorized", async () => {
    const { service } = serviceWith([validResolvableOutput()]);
    const created = await service.generateDraft({
      headline: "Will the RBI cut the repo rate by December 2026?",
      articleSnippet: null,
    });
    if (created.kind !== "resolvable") throw new Error("expected a draft");
    const handler = createUpdateMarketHandler(deps(service));
    const response = await handler(
      new Request(`http://app.test/api/markets/${created.record.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          market: validMarketFields({ question: "Will the RBI cut the repo rate in December 2026?" }),
        }),
      }),
      created.record.id,
    );
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect((body.market as { revision: number }).revision).toBe(2);
  });
});

describe("GET /api/config", () => {
  test("exposes provider info without secrets and reports access control", async () => {
    const { service } = serviceWith([validResolvableOutput()]);
    const handler = createConfigHandler(deps(service, TOKEN_ENV));
    const response = await handler();
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect((body.accessControl as { editorTokenRequired: boolean }).editorTokenRequired).toBe(true);
    const text = JSON.stringify(body);
    expect(text).not.toContain("test-editor-token");
    expect(text).not.toContain("apiKey");
  });
});
