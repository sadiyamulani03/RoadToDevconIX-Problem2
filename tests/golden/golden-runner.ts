import { readFileSync } from "node:fs";
import { z } from "zod";
import { generateHeuristicOutput } from "../../src/lib/llm/heuristic-provider";
import { validateMarketSemantics } from "../../src/lib/domain/semantic-validation";
import type { ModelOutput } from "../../src/lib/domain/schema";

/**
 * Golden-set runner shared by `tests/golden/golden-set.test.ts` (vitest) and
 * `scripts/eval-golden.ts` (CLI). The fixture itself is validated with Zod so
 * a malformed evaluation set fails loudly instead of silently passing.
 */

export const GOLDEN_CATEGORIES = [
  "valid",
  "ambiguous",
  "missing_details",
  "deadline",
  "subjective",
  "weak_source",
  "contradictory_context",
  "bundled",
  "prompt_injection",
  "quality_warning",
] as const;

export const GoldenCaseSchema = z.object({
  id: z.string().min(3),
  category: z.enum(GOLDEN_CATEGORIES),
  headline: z.string().min(8),
  articleSnippet: z.string().nullable(),
  expectedOutcome: z.enum(["resolvable", "unresolvable"]),
  notes: z.string().min(10),
  expectNoBlockingErrors: z.boolean().optional(),
  expectedIssueCodes: z.array(z.string().min(3)).optional(),
  expectQuestionExcludes: z.array(z.string().min(3)).optional(),
  expectReasonIncludes: z.string().min(3).optional(),
  expectSuggestedRevision: z.boolean().nullable().optional(),
});
export type GoldenCase = z.infer<typeof GoldenCaseSchema>;

export const GoldenSetSchema = z.object({
  version: z.literal(1),
  now: z.iso.datetime(),
  description: z.string().min(10),
  cases: z.array(GoldenCaseSchema).min(10),
});
export type GoldenSet = z.infer<typeof GoldenSetSchema>;

export interface GoldenCaseResult {
  id: string;
  category: GoldenCase["category"];
  expectedOutcome: GoldenCase["expectedOutcome"];
  actualOutcome: ModelOutput["outcome"];
  passed: boolean;
  failures: string[];
}

/** Runs a single case deterministically through the offline heuristic. */
export function runGoldenCase(goldenCase: GoldenCase, now: Date): GoldenCaseResult {
  const output = generateHeuristicOutput(
    { headline: goldenCase.headline, articleSnippet: goldenCase.articleSnippet },
    now,
  );
  const failures: string[] = [];

  if (output.outcome !== goldenCase.expectedOutcome) {
    failures.push(`expected ${goldenCase.expectedOutcome}, got ${output.outcome}`);
  }

  if (output.outcome === "resolvable") {
    if (output.status !== "draft") {
      failures.push(`model output status must be draft, got ${output.status}`);
    }
    const terms = goldenCase.expectQuestionExcludes ?? [];
    for (const term of terms) {
      if (output.question.toLowerCase().includes(term.toLowerCase())) {
        failures.push(`question contains forbidden injected text: "${term}"`);
      }
    }
    if (goldenCase.expectNoBlockingErrors !== false) {
      const issues = validateMarketSemantics(output, now);
      const blocking = issues.filter((issue) => issue.severity === "error");
      if (blocking.length > 0) {
        failures.push(
          `blocking semantic issues: ${blocking.map((issue) => issue.code).join(", ")}`,
        );
      }
      for (const code of goldenCase.expectedIssueCodes ?? []) {
        if (!issues.some((issue) => issue.code === code)) {
          failures.push(`missing expected issue code: ${code}`);
        }
      }
    }
  } else {
    if (output.reason.trim().length < 20) {
      failures.push("unresolvable reason is too short to be meaningful");
    }
    if (!Array.isArray(output.missingInformation)) {
      failures.push("unresolvable outcome is missing the missingInformation list");
    }
    if (
      goldenCase.expectReasonIncludes &&
      !output.reason.toLowerCase().includes(goldenCase.expectReasonIncludes.toLowerCase())
    ) {
      failures.push(`reason does not mention "${goldenCase.expectReasonIncludes}"`);
    }
    if (goldenCase.expectSuggestedRevision === true && !output.suggestedRevision) {
      failures.push("expected a suggested revision but none was provided");
    }
    if (goldenCase.expectSuggestedRevision === false && output.suggestedRevision) {
      failures.push("expected no suggested revision but one was provided");
    }
  }

  return {
    id: goldenCase.id,
    category: goldenCase.category,
    expectedOutcome: goldenCase.expectedOutcome,
    actualOutcome: output.outcome,
    passed: failures.length === 0,
    failures,
  };
}

export interface GoldenRunSummary {
  total: number;
  passed: number;
  failed: number;
  resolvableCases: number;
  unresolvableCases: number;
  categories: Record<string, number>;
  results: GoldenCaseResult[];
}

export function runGoldenSet(set: GoldenSet, options: { now?: Date } = {}): GoldenRunSummary {
  const now = options.now ?? new Date(set.now);
  const results = set.cases.map((goldenCase) => runGoldenCase(goldenCase, now));
  const categories: Record<string, number> = {};
  for (const goldenCase of set.cases) {
    categories[goldenCase.category] = (categories[goldenCase.category] ?? 0) + 1;
  }
  return {
    total: results.length,
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length,
    resolvableCases: set.cases.filter((goldenCase) => goldenCase.expectedOutcome === "resolvable")
      .length,
    unresolvableCases: set.cases.filter(
      (goldenCase) => goldenCase.expectedOutcome === "unresolvable",
    ).length,
    categories,
    results,
  };
}

export function parseGoldenSet(raw: unknown): GoldenSet {
  const parsed = GoldenSetSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`golden set fixture failed validation: ${details}`);
  }
  return parsed.data;
}

export function loadGoldenSet(path: string): GoldenSet {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return parseGoldenSet(raw);
}
