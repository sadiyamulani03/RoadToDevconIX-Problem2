import { describe, expect, test } from "vitest";
import { loadGoldenSet, runGoldenSet, GOLDEN_CATEGORIES } from "./golden-runner";

/**
 * Check 9 — the committed golden set must contain labelled cases with
 * expected outcomes, including explicit expected-rejection cases, and the
 * cases must actually be executed and checked for market-quality properties.
 */

const FIXTURE_PATH = new URL("../fixtures/golden-set.json", import.meta.url).pathname;

const goldenSet = loadGoldenSet(FIXTURE_PATH);

describe("golden set fixture", () => {
  test("is present, valid and complete", () => {
    expect(goldenSet.version).toBe(1);
    expect(goldenSet.cases.length).toBeGreaterThanOrEqual(12);
    const ids = goldenSet.cases.map((goldenCase) => goldenCase.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("includes explicit expected-rejection cases", () => {
    const rejections = goldenSet.cases.filter(
      (goldenCase) => goldenCase.expectedOutcome === "unresolvable",
    );
    expect(rejections.length).toBeGreaterThanOrEqual(5);
    for (const rejection of rejections) {
      expect(rejection.notes.length).toBeGreaterThan(10);
    }
  });

  test("includes valid resolvable cases", () => {
    const resolvable = goldenSet.cases.filter(
      (goldenCase) => goldenCase.expectedOutcome === "resolvable",
    );
    expect(resolvable.length).toBeGreaterThanOrEqual(4);
  });

  test("covers every required evaluation category", () => {
    const covered = new Set(goldenSet.cases.map((goldenCase) => goldenCase.category));
    for (const category of GOLDEN_CATEGORIES) {
      expect(covered.has(category), `missing golden category: ${category}`).toBe(true);
    }
  });
});

describe("deterministic golden-set execution", () => {
  const summary = runGoldenSet(goldenSet);

  test("every case meets its labelled expectation", () => {
    const failures = summary.results.filter((result) => !result.passed);
    expect(
      failures.map((failure) => `${failure.id}: ${failure.failures.join("; ")}`).join("\n"),
    ).toBe("");
    expect(summary.failed).toBe(0);
  });

  test("reports the actual pass counts (deterministic heuristic run)", () => {
    expect(summary.passed).toBe(summary.total);
    expect(summary.resolvableCases).toBeGreaterThanOrEqual(4);
    expect(summary.unresolvableCases).toBeGreaterThanOrEqual(5);
  });
});
