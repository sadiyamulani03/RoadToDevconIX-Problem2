import { describe, expect, test } from "vitest";
import {
  HEURISTIC_PROVIDER_NAME,
  createHeuristicProvider,
  generateHeuristicOutput,
} from "../../src/lib/llm/heuristic-provider";
import { FIXED_NOW } from "../helpers/fixtures";

/**
 * The offline heuristic is the deterministic fallback used when no API key is
 * configured. It must refuse headlines it cannot ground and must never invent
 * dates, sources or URLs. These tests run with a fixed clock.
 */

describe("heuristic provider — explicit rejection (Check 3)", () => {
  const rejections = [
    "Will Bengaluru traffic improve?",
    "Is this the best phone ever?",
    "Will people become happier next year?",
    "Will the company release its annual report?",
    "Will India win the 2019 Cricket World Cup?",
    "Will the government publish the unemployment report on 15 March 2027?",
    "Government cancels new highway project",
  ];

  for (const headline of rejections) {
    test(`rejects: ${headline}`, () => {
      const output = generateHeuristicOutput({ headline, articleSnippet: null }, FIXED_NOW);
      expect(output.outcome).toBe("unresolvable");
      if (output.outcome === "unresolvable") {
        expect(output.reason.length).toBeGreaterThanOrEqual(20);
        expect(Array.isArray(output.missingInformation)).toBe(true);
      }
    });
  }

  test("rejects a bundled multi-question headline", () => {
    const output = generateHeuristicOutput(
      {
        headline:
          "Will the company report record revenue? Will it announce a new CEO by 31 December 2027?",
        articleSnippet: null,
      },
      FIXED_NOW,
    );
    expect(output.outcome).toBe("unresolvable");
    if (output.outcome === "unresolvable") {
      expect(output.reason.toLowerCase()).toContain("more than one question");
    }
  });

  test("rejection reasons are specific and actionable", () => {
    const vague = generateHeuristicOutput(
      { headline: "Will Bengaluru traffic improve?", articleSnippet: null },
      FIXED_NOW,
    );
    expect(vague.outcome).toBe("unresolvable");
    if (vague.outcome === "unresolvable") {
      expect(vague.missingInformation.length).toBeGreaterThan(0);
      expect(vague.suggestedRevision).toBeTruthy();
    }
  });
});

describe("heuristic provider — resolvable drafts", () => {
  const INPUT = {
    headline: "Will the RBI cut the repo rate at its December 2026 monetary policy meeting?",
    articleSnippet:
      "The Reserve Bank of India's Monetary Policy Committee will announce its next policy decision on 5 December 2026. The official press release will be published at https://www.rbi.org.in.",
  };

  test("produces a draft when a future date and a named source are present", () => {
    const output = generateHeuristicOutput(INPUT, FIXED_NOW);
    expect(output.outcome).toBe("resolvable");
    if (output.outcome === "resolvable") {
      expect(output.status).toBe("draft");
      expect(output.question.endsWith("?")).toBe(true);
      expect(new Date(output.closeAt).getTime()).toBeGreaterThan(FIXED_NOW.getTime());
      expect(output.resolutionSource.length).toBeGreaterThan(3);
      expect(output.resolutionSourceUrl).toBe("https://www.rbi.org.in");
      expect(output.resolutionRules.length).toBeGreaterThanOrEqual(3);
    }
  });

  test("never invents a URL when none is supplied", () => {
    const output = generateHeuristicOutput(
      {
        headline: "Will the RBI cut the repo rate by 31 December 2027?",
        articleSnippet:
          "According to the Reserve Bank of India, the decision will be announced on 5 December 2026.",
      },
      FIXED_NOW,
    );
    expect(output.outcome).toBe("resolvable");
    if (output.outcome === "resolvable") {
      expect(output.resolutionSourceUrl).toBeNull();
      expect(output.resolutionSource).toContain("Reserve Bank of India");
    }
  });

  test("is deterministic for the same input and clock", () => {
    const first = generateHeuristicOutput(INPUT, FIXED_NOW);
    const second = generateHeuristicOutput(INPUT, FIXED_NOW);
    expect(first).toEqual(second);
  });

  test("provider factory labels itself as the heuristic fallback", async () => {
    const provider = createHeuristicProvider({ now: () => FIXED_NOW });
    expect(provider.mode).toBe("heuristic");
    expect(provider.name).toBe(HEURISTIC_PROVIDER_NAME);
    expect(provider.model).toBeNull();
    const result = await provider.generate(INPUT);
    expect(result.requests).toBe(1);
    expect(result.output.outcome).toBe("resolvable");
  });
});
