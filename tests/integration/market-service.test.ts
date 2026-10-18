import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ModelOutput } from "../../src/lib/domain/schema";
import { MarketStore } from "../../src/lib/db";
import { MarketService, MarketServiceError } from "../../src/lib/market-service";
import { fixedClock, offsetClock } from "../../src/lib/clock";
import { FailingProvider, StubProvider } from "../helpers/stub-provider";
import { MarketProviderError } from "../../src/lib/llm/errors";
import {
  FIXED_NOW,
  validMarketFields,
  validResolvableOutput,
  validUnresolvableOutput,
} from "../helpers/fixtures";

/**
 * Integration tests for the full draft → approval lifecycle, including the
 * mechanisms that satisfy Checks 2, 3, 7 and 8.
 */

const INPUT = {
  headline: "Will the RBI cut the repo rate at its December 2026 meeting?",
  articleSnippet: "The decision will be announced on 5 December 2026. See https://www.rbi.org.in.",
};

let store: MarketStore;

beforeEach(() => {
  store = new MarketStore(":memory:");
});

afterEach(() => {
  store.close();
});

function makeService(outputs: ModelOutput[], options: { maxCorrectionPasses?: number } = {}) {
  const provider = new StubProvider(outputs);
  const service = new MarketService({
    store,
    provider,
    clock: fixedClock(FIXED_NOW.toISOString()),
    ...options,
  });
  return { service, provider };
}

describe("draft generation", () => {
  test("a resolvable model output is persisted only as a draft", async () => {
    const { service } = makeService([validResolvableOutput()]);
    const result = await service.generateDraft(INPUT);
    expect(result.kind).toBe("resolvable");
    if (result.kind === "resolvable") {
      expect(result.record.status).toBe("draft");
      expect(result.record.approvedAt).toBeNull();
      expect(result.generation.mode).toBe("heuristic");
      expect(result.generation.requests).toBe(1);
      expect(store.get(result.record.id)?.status).toBe("draft");
    }
  });

  test("a model cannot persist an approved status even if the provider returns one", async () => {
    const forged = { ...validResolvableOutput(), status: "approved" } as unknown as ModelOutput;
    const { service } = makeService([forged]);
    const result = await service.generateDraft(INPUT);
    expect(result.kind).toBe("resolvable");
    if (result.kind === "resolvable") {
      expect(result.record.status).toBe("draft");
      expect(result.record.market.status).toBe("draft");
    }
  });

  test("an unresolvable outcome stores nothing and returns the rejection", async () => {
    const { service } = makeService([validUnresolvableOutput()]);
    const result = await service.generateDraft(INPUT);
    expect(result.kind).toBe("unresolvable");
    if (result.kind === "unresolvable") {
      expect(result.rejection.reason.length).toBeGreaterThan(20);
      expect(result.generation.requests).toBe(1);
    }
    expect(service.list()).toHaveLength(0);
  });

  test("recovers from a past deadline with one bounded correction pass", async () => {
    const past = validResolvableOutput({ closeAt: "2020-01-01T00:00:00.000Z" });
    const { service, provider } = makeService([past, validResolvableOutput()]);
    const result = await service.generateDraft(INPUT);
    expect(result.kind).toBe("resolvable");
    if (result.kind === "resolvable") {
      expect(result.record.market.closeAt).toBe("2026-12-05T18:30:00.000Z");
      expect(result.record.semanticIssues.some((issue) => issue.code === "deadline_in_past")).toBe(
        false,
      );
    }
    expect(provider.calls).toHaveLength(2);
    expect(provider.options[1]?.correction?.issues[0]?.code).toBe("deadline_in_past");
  });

  test("the correction loop is capped and never runs forever", async () => {
    const past = validResolvableOutput({ closeAt: "2020-01-01T00:00:00.000Z" });
    const { service, provider } = makeService([past, past, past, past]);
    const result = await service.generateDraft(INPUT);
    expect(result.kind).toBe("resolvable");
    // 1 initial call + 1 bounded correction pass (default maxCorrectionPasses).
    expect(provider.calls).toHaveLength(2);
    if (result.kind === "resolvable") {
      expect(result.record.semanticIssues.some((issue) => issue.code === "deadline_in_past")).toBe(
        true,
      );
    }
  });

  test("a correction pass can itself return unresolvable and stores nothing", async () => {
    const past = validResolvableOutput({ closeAt: "2020-01-01T00:00:00.000Z" });
    const { service } = makeService([past, validUnresolvableOutput()]);
    const result = await service.generateDraft(INPUT);
    expect(result.kind).toBe("unresolvable");
    expect(service.list()).toHaveLength(0);
  });

  test("provider failure propagates as a controlled provider error", async () => {
    const provider = new FailingProvider(
      new MarketProviderError("The model did not return valid JSON.", "invalid_output", true, 3),
    );
    const service = new MarketService({
      store,
      provider,
      clock: fixedClock(FIXED_NOW.toISOString()),
    });
    const error = await service.generateDraft(INPUT).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MarketProviderError);
    expect((error as MarketProviderError).code).toBe("invalid_output");
    expect(service.list()).toHaveLength(0);
  });
});

describe("draft editing", () => {
  test("updates an editable draft and bumps the revision", async () => {
    const { service } = makeService([validResolvableOutput()]);
    const created = await service.generateDraft(INPUT);
    if (created.kind !== "resolvable") throw new Error("expected a draft");
    const updated = service.updateDraft(
      created.record.id,
      validMarketFields({ question: "Will the RBI cut the repo rate in December 2026?" }),
    );
    expect(updated.revision).toBe(2);
    expect(updated.status).toBe("draft");
  });

  test("rejects schema-invalid edits without changing the stored draft", async () => {
    const { service } = makeService([validResolvableOutput()]);
    const created = await service.generateDraft(INPUT);
    if (created.kind !== "resolvable") throw new Error("expected a draft");
    const error = (() => {
      try {
        service.updateDraft(created.record.id, validMarketFields({ question: "No?" }));
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(MarketServiceError);
    expect((error as MarketServiceError).code).toBe("draft_failed_validation");
    expect(service.get(created.record.id).revision).toBe(1);
  });

  test("approved markets are locked and discarded drafts are not editable", async () => {
    const { service } = makeService([validResolvableOutput()]);
    const created = await service.generateDraft(INPUT);
    if (created.kind !== "resolvable") throw new Error("expected a draft");
    service.approve(created.record.id);
    expect(() => service.updateDraft(created.record.id, validMarketFields())).toThrow(
      /rules are locked/i,
    );

    const second = makeService([validResolvableOutput()]);
    const draft2 = await second.service.generateDraft(INPUT);
    if (draft2.kind !== "resolvable") throw new Error("expected a draft");
    second.service.discard(draft2.record.id);
    expect(() => second.service.updateDraft(draft2.record.id, validMarketFields())).toThrow(
      /Discarded drafts cannot be edited/i,
    );
  });
});

describe("explicit editor approval (Check 8)", () => {
  test("approval requires an explicit call and sets approvedAt", async () => {
    const { service } = makeService([validResolvableOutput()]);
    const created = await service.generateDraft(INPUT);
    if (created.kind !== "resolvable") throw new Error("expected a draft");
    expect(created.record.status).toBe("draft");

    const approved = service.approve(created.record.id);
    expect(approved.status).toBe("approved");
    expect(approved.market.status).toBe("approved");
    expect(approved.approvedAt).toBe(FIXED_NOW.toISOString());
  });

  test("double approval and approving a discarded draft are refused", async () => {
    const { service } = makeService([validResolvableOutput()]);
    const created = await service.generateDraft(INPUT);
    if (created.kind !== "resolvable") throw new Error("expected a draft");
    service.approve(created.record.id);
    expect(() => service.approve(created.record.id)).toThrow(/already approved/i);

    const { service: second, } = makeService([validResolvableOutput()]);
    const draft2 = await second.generateDraft(INPUT);
    if (draft2.kind !== "resolvable") throw new Error("expected a draft");
    second.discard(draft2.record.id);
    expect(() => second.approve(draft2.record.id)).toThrow(/discarded draft cannot be approved/i);
  });

  test("a draft that expires between generation and approval cannot be approved", async () => {
    let current = FIXED_NOW.getTime();
    const clock = { now: () => new Date(current) };
    const provider = new StubProvider([
      validResolvableOutput({ closeAt: "2026-10-18T00:00:00.000Z" }),
    ]);
    const service = new MarketService({ store, provider, clock });

    const created = await service.generateDraft(INPUT);
    if (created.kind !== "resolvable") throw new Error("expected a draft");
    expect(created.record.status).toBe("draft");

    // Advance beyond the close time before the editor approves.
    current = new Date("2026-10-19T00:00:00.000Z").getTime();
    const error = (() => {
      try {
        service.approve(created.record.id);
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(MarketServiceError);
    expect((error as MarketServiceError).code).toBe("draft_failed_validation");
    expect(service.get(created.record.id).status).toBe("draft");
  });

  test("approval re-runs semantic validation and blocks invalid drafts", async () => {
    const provider = new StubProvider([
      validResolvableOutput({ closeAt: "2020-01-01T00:00:00.000Z" }),
    ]);
    const service = new MarketService({
      store,
      provider,
      clock: fixedClock(FIXED_NOW.toISOString()),
      maxCorrectionPasses: 0,
    });
    const created = await service.generateDraft(INPUT);
    if (created.kind !== "resolvable") throw new Error("expected a draft");
    const error = (() => {
      try {
        service.approve(created.record.id);
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(MarketServiceError);
    expect((error as MarketServiceError).code).toBe("draft_failed_validation");
    const details = (error as MarketServiceError).details as Array<{ code: string }>;
    expect(details.some((issue) => issue.code === "deadline_in_past")).toBe(true);
  });

  test("approved markets cannot be discarded", async () => {
    const { service } = makeService([validResolvableOutput()]);
    const created = await service.generateDraft(INPUT);
    if (created.kind !== "resolvable") throw new Error("expected a draft");
    service.approve(created.record.id);
    expect(() => service.discard(created.record.id)).toThrow(/cannot be discarded/i);
  });

  test("discard is explicit and idempotent", async () => {
    const { service } = makeService([validResolvableOutput()]);
    const created = await service.generateDraft(INPUT);
    if (created.kind !== "resolvable") throw new Error("expected a draft");
    const discarded = service.discard(created.record.id);
    expect(discarded.status).toBe("discarded");
    expect(discarded.discardedAt).toBe(FIXED_NOW.toISOString());
    expect(service.discard(created.record.id).status).toBe("discarded");
  });
});

describe("lookups", () => {
  test("unknown ids produce a not_found service error", () => {
    const { service } = makeService([validResolvableOutput()]);
    const error = (() => {
      try {
        service.get("00000000-0000-4000-8000-000000000000");
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(MarketServiceError);
    expect((error as MarketServiceError).code).toBe("not_found");
    expect((error as MarketServiceError).status).toBe(404);
  });

  test("offset clock keeps generation deterministic", async () => {
    const provider = new StubProvider([validResolvableOutput()]);
    const service = new MarketService({
      store,
      provider,
      clock: offsetClock(FIXED_NOW.toISOString(), [0]),
    });
    const result = await service.generateDraft(INPUT);
    expect(result.kind).toBe("resolvable");
  });
});
