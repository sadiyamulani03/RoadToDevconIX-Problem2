import { describe, expect, test } from "vitest";
import {
  DraftRequestSchema,
  MarketRecordSchema,
  ModelOutputSchema,
  UpdateDraftRequestSchema,
} from "../../src/lib/domain/schema";
import {
  FIXED_NOW,
  validMarketFields,
  validResolvableOutput,
  validUnresolvableOutput,
} from "../helpers/fixtures";

/**
 * Check 1 — the raw model response must pass runtime (Zod) validation before
 * any generated field is used. Type assertions and bare JSON.parse are not
 * substitutes; these tests prove malformed payloads are rejected.
 */

describe("ModelOutputSchema runtime validation", () => {
  test("accepts a complete resolvable market draft", () => {
    const parsed = ModelOutputSchema.safeParse(validResolvableOutput());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.outcome).toBe("resolvable");
    }
  });

  test("accepts an explicit unresolvable outcome with a reason", () => {
    const parsed = ModelOutputSchema.safeParse(validUnresolvableOutput());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.outcome).toBe("unresolvable");
    }
  });

  test("rejects JSON that is not an object", () => {
    expect(ModelOutputSchema.safeParse(JSON.parse('"just a string"')).success).toBe(false);
    expect(ModelOutputSchema.safeParse(JSON.parse("null")).success).toBe(false);
    expect(ModelOutputSchema.safeParse(JSON.parse("42")).success).toBe(false);
  });

  test("rejects an empty object / incomplete market draft", () => {
    expect(ModelOutputSchema.safeParse({}).success).toBe(false);
    const missingQuestion: Record<string, unknown> = { ...validResolvableOutput() };
    delete missingQuestion.question;
    expect(ModelOutputSchema.safeParse(missingQuestion).success).toBe(false);
    const missingRules: Record<string, unknown> = { ...validResolvableOutput() };
    delete missingRules.resolutionRules;
    expect(ModelOutputSchema.safeParse(missingRules).success).toBe(false);
  });

  test("rejects wrong types even when the shape looks right", () => {
    expect(
      ModelOutputSchema.safeParse({ ...validResolvableOutput(), question: 123 }).success,
    ).toBe(false);
    expect(
      ModelOutputSchema.safeParse({ ...validResolvableOutput(), closeAt: ["soon"] }).success,
    ).toBe(false);
    expect(
      ModelOutputSchema.safeParse({ ...validResolvableOutput(), resolutionRules: "a rule" }).success,
    ).toBe(false);
    expect(
      ModelOutputSchema.safeParse({ ...validResolvableOutput(), resolutionSourceUrl: 7 }).success,
    ).toBe(false);
  });

  test("rejects an invalid outcome discriminator", () => {
    expect(
      ModelOutputSchema.safeParse({ ...validResolvableOutput(), outcome: "maybe" }).success,
    ).toBe(false);
    expect(ModelOutputSchema.safeParse({ outcome: "approved" }).success).toBe(false);
  });

  test("rejects a model that tries to approve its own output", () => {
    const attemptedApproval = { ...validResolvableOutput(), status: "approved" };
    expect(ModelOutputSchema.safeParse(attemptedApproval).success).toBe(false);
    const parsed = ModelOutputSchema.safeParse(attemptedApproval);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("status");
    }
  });

  test("rejects semantically incomplete drafts: too few rules, empty URL, short reason", () => {
    expect(
      ModelOutputSchema.safeParse({
        ...validResolvableOutput(),
        resolutionRules: ["only one rule"],
      }).success,
    ).toBe(false);
    expect(
      ModelOutputSchema.safeParse({
        ...validResolvableOutput(),
        resolutionSourceUrl: "not-a-url",
      }).success,
    ).toBe(false);
    expect(
      ModelOutputSchema.safeParse({
        ...validUnresolvableOutput(),
        reason: "too short",
      }).success,
    ).toBe(false);
  });

  test("closeAt must carry an explicit timezone offset", () => {
    expect(
      ModelOutputSchema.safeParse({
        ...validResolvableOutput(),
        closeAt: "2027-01-31T23:59:00",
      }).success,
    ).toBe(false);
    expect(
      ModelOutputSchema.safeParse({
        ...validResolvableOutput(),
        closeAt: "2027-01-31T23:59:00+05:30",
      }).success,
    ).toBe(true);
  });

  test("bare JSON.parse alone is not the final validation step", () => {
    const raw = JSON.stringify({ outcome: "resolvable", question: "Will it?" });
    const parsedJson = JSON.parse(raw) as unknown;
    expect(parsedJson).toBeTruthy();
    expect(ModelOutputSchema.safeParse(parsedJson).success).toBe(false);
  });
});

describe("request and record schemas", () => {
  test("DraftRequestSchema bounds headline and snippet sizes", () => {
    expect(DraftRequestSchema.safeParse({ headline: "short" }).success).toBe(false);
    expect(DraftRequestSchema.safeParse({ headline: "x".repeat(501) }).success).toBe(false);
    expect(DraftRequestSchema.safeParse({ headline: "A valid headline?" }).success).toBe(true);
    const withLongSnippet = DraftRequestSchema.safeParse({
      headline: "A valid headline?",
      articleSnippet: "x".repeat(4001),
    });
    expect(withLongSnippet.success).toBe(false);
    const emptySnippet = DraftRequestSchema.safeParse({
      headline: "A valid headline?",
      articleSnippet: "   ",
    });
    expect(emptySnippet.success).toBe(true);
    if (emptySnippet.success) {
      expect(emptySnippet.data.articleSnippet).toBeNull();
    }
  });

  test("MarketRecordSchema enforces that market.status mirrors record.status", () => {
    const record = {
      id: crypto.randomUUID(),
      status: "draft",
      createdAt: FIXED_NOW.toISOString(),
      updatedAt: FIXED_NOW.toISOString(),
      approvedAt: null,
      discardedAt: null,
      generationMode: "heuristic",
      generationProvider: "test",
      sourceVerification: "syntactic-only",
      revision: 1,
      market: { ...validMarketFields(), outcome: "resolvable", status: "approved" },
      semanticIssues: [],
    };
    expect(MarketRecordSchema.safeParse(record).success).toBe(false);
    const aligned = {
      ...record,
      market: { ...validMarketFields(), outcome: "resolvable", status: "draft" },
    };
    expect(MarketRecordSchema.safeParse(aligned).success).toBe(true);
  });

  test("UpdateDraftRequestSchema cannot smuggle a lifecycle status", () => {
    const withStatus = { market: { ...validMarketFields(), status: "approved" } };
    expect(UpdateDraftRequestSchema.safeParse(withStatus).success).toBe(true);
    const parsed = UpdateDraftRequestSchema.parse(withStatus);
    // The status key is stripped by the strict object schema shape.
    expect("status" in parsed.market).toBe(false);
  });
});
