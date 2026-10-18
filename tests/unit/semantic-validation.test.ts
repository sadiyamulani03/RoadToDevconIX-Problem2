import { describe, expect, test } from "vitest";
import {
  checkSourceUrlSafety,
  findSubjectiveTerms,
  hasBlockingErrors,
  isGenericSource,
  issueSummary,
  validateMarketSemantics,
  validateQuestion,
  validateResolutionSource,
  validateSettlement,
} from "../../src/lib/domain/semantic-validation";
import { FIXED_NOW, validMarketFields } from "../helpers/fixtures";

describe("subjective-term detection", () => {
  test("flags subjective terms without numeric anchors as blocking", () => {
    const issues = validateQuestion("Will Bengaluru traffic improve?", "2027-01-01T00:00:00.000Z");
    expect(issues.some((issue) => issue.code === "subjective_term")).toBe(true);
    expect(issues.some((issue) => issue.severity === "error")).toBe(true);
  });

  test("treats a subjective term with a numeric anchor as a warning", () => {
    const issues = validateQuestion(
      "Will the popularity score exceed 75 by 2027?",
      "2027-06-01T00:00:00.000Z",
    );
    expect(issues.some((issue) => issue.code === "subjective_term_needs_metric")).toBe(true);
    expect(issues.every((issue) => issue.severity === "warning")).toBe(true);
  });

  test("detects multiple subjective terms and records their sentences", () => {
    const matches = findSubjectiveTerms("Is this the best phone ever? It will improve.");
    expect(matches.map((match) => match.term)).toContain("best");
    expect(matches.map((match) => match.term)).toContain("improve");
  });
});

describe("question quality", () => {
  test("requires a question mark and a YES/NO phrasing", () => {
    const statement = validateQuestion("Company reports earnings", null);
    expect(statement.map((issue) => issue.code)).toContain("question_not_a_question");
    expect(statement.map((issue) => issue.code)).toContain("question_not_yes_no_phrased");
  });

  test("rejects bundled multiple-question headlines", () => {
    const issues = validateQuestion("Will it rain? Will it snow?", "2027-01-01T00:00:00.000Z");
    expect(issues.some((issue) => issue.code === "bundled_question")).toBe(true);
  });

  test("warns about a possible second condition after 'and'", () => {
    const issues = validateQuestion(
      "Will the company report revenue and will it announce a new CEO?",
      "2027-01-01T00:00:00.000Z",
    );
    expect(issues.some((issue) => issue.code === "possible_bundled_question")).toBe(true);
    expect(issues.every((issue) => issue.severity !== "error")).toBe(true);
  });
});

describe("resolution-source quality", () => {
  test("rejects generic sources", () => {
    for (const source of ["The internet", "the media", "official sources", "social media", "abc"]) {
      expect(isGenericSource(source)).toBe(true);
    }
  });

  test("accepts a named authority", () => {
    expect(isGenericSource("Reserve Bank of India")).toBe(false);
    expect(isGenericSource("Election Commission of India")).toBe(false);
  });

  test("validateResolutionSource reports generic sources as blocking", () => {
    const issues = validateResolutionSource("the internet", null);
    expect(issues.some((issue) => issue.code === "generic_resolution_source")).toBe(true);
    expect(hasBlockingErrors(issues)).toBe(true);
  });

  test("URL safety rejects credentials, private hosts and non-http protocols", () => {
    expect(checkSourceUrlSafety("https://user:pass@example.com").code).toBe(
      "url_credentials_not_allowed",
    );
    expect(checkSourceUrlSafety("http://localhost:3000/source").code).toBe("unsafe_source_url");
    expect(checkSourceUrlSafety("http://127.0.0.1/source").code).toBe("unsafe_source_url");
    expect(checkSourceUrlSafety("http://192.168.1.10/source").code).toBe("unsafe_source_url");
    expect(checkSourceUrlSafety("http://[::1]/source").code).toBe("unsafe_source_url");
    expect(checkSourceUrlSafety("ftp://example.com/file").code).toBe("non_http_source_url");
    expect(checkSourceUrlSafety("definitely not a url").code).toBe("invalid_source_url");
    expect(checkSourceUrlSafety("https://www.rbi.org.in").ok).toBe(true);
  });
});

describe("settlement fairness", () => {
  test("a well-formed market produces no semantic issues", () => {
    expect(validateSettlement(validMarketFields())).toEqual([]);
  });

  test("rejects identical YES/NO criteria", () => {
    const issues = validateSettlement(
      validMarketFields({ noCriteria: validMarketFields().yesCriteria }),
    );
    expect(issues.some((issue) => issue.code === "identical_yes_no_criteria")).toBe(true);
  });

  test("rejects duplicated resolution rules", () => {
    const rule = "The market resolves NO if the named source does not publish the result.";
    const issues = validateSettlement(
      validMarketFields({
        resolutionRules: [
          rule,
          rule,
          "The market resolves NO if the event is cancelled.",
        ],
      }),
    );
    expect(issues.some((issue) => issue.code === "duplicate_resolution_rule")).toBe(true);
  });

  test("rejects rules that defer to editor judgement", () => {
    const issues = validateSettlement(
      validMarketFields({
        resolutionRules: [
          "The outcome is decided at the editor's discretion.",
          "If the event is cancelled, the market resolves NO.",
          "If the source fails to publish, the market resolves NO.",
        ],
      }),
    );
    expect(issues.some((issue) => issue.code === "vague_resolution_rule")).toBe(true);
  });

  test("requires a rule for source failure", () => {
    const issues = validateSettlement(
      validMarketFields({
        resolutionRules: [
          "The market resolves YES if the named source publishes the result before the close time.",
          "If the event is postponed, the market resolves NO.",
          "If the event is cancelled, the market resolves NO.",
        ],
      }),
    );
    expect(issues.some((issue) => issue.code === "missing_source_failure_rule")).toBe(true);
  });
});

describe("aggregate semantic validation", () => {
  test("a valid future market has no blocking errors", () => {
    const issues = validateMarketSemantics(validMarketFields(), FIXED_NOW);
    expect(hasBlockingErrors(issues)).toBe(false);
  });

  test("collects deadline, question, source and settlement problems", () => {
    const issues = validateMarketSemantics(
      validMarketFields({
        closeAt: "2020-01-01T00:00:00.000Z",
        question: "Will traffic improve?",
        resolutionSource: "the media",
        resolutionSourceUrl: "http://localhost/x",
      }),
      FIXED_NOW,
    );
    const codes = issues.map((issue) => issue.code);
    expect(codes).toContain("deadline_in_past");
    expect(codes).toContain("subjective_term");
    expect(codes).toContain("generic_resolution_source");
    expect(codes).toContain("unsafe_source_url");
    expect(hasBlockingErrors(issues)).toBe(true);
  });

  test("issueSummary formats a bounded, readable summary", () => {
    const issues = validateMarketSemantics(
      validMarketFields({ closeAt: "2020-01-01T00:00:00.000Z" }),
      FIXED_NOW,
    );
    const summary = issueSummary(issues, 1);
    expect(summary).toContain("[deadline_in_past]");
    expect(summary.split("]").length).toBeLessThanOrEqual(3);
  });
});
