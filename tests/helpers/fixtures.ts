import type {
  MarketFields,
  ModelResolvableMarket,
  UnresolvableOutcome,
} from "../../src/lib/domain/schema";

/**
 * Shared deterministic fixtures for tests. The fixed "now" instant keeps
 * every deadline comparison independent of the wall clock.
 */
export const FIXED_NOW = new Date("2026-10-17T12:00:00.000Z");

export const VALID_RULES: string[] = [
  "The market resolves YES only if the named source publishes or confirms the event on or before the close time.",
  "If the named source fails to publish the expected information by the close time, the market resolves NO.",
  "If the event is postponed or rescheduled beyond the close time, the market resolves NO.",
  "If the event is cancelled, the market resolves NO.",
  "If the source publishes a correction, the corrected publication decides the market.",
];

export function validMarketFields(overrides: Partial<MarketFields> = {}): MarketFields {
  return {
    question: "Will the RBI cut the repo rate at its December 2026 meeting?",
    closeAt: "2026-12-05T18:30:00.000Z",
    timezone: "IST (UTC+05:30)",
    resolutionSource: "Reserve Bank of India",
    resolutionSourceUrl: "https://www.rbi.org.in",
    yesCriteria:
      "Yes, if the Reserve Bank of India publishes a repo-rate cut decision on or before the close time.",
    noCriteria:
      "No, if the Reserve Bank of India has not published a repo-rate cut decision by the close time.",
    resolutionRules: [...VALID_RULES],
    reasoning:
      "An independent observer can resolve the market from the official Reserve Bank of India publication.",
    ...overrides,
  };
}

export function validResolvableOutput(
  overrides: Partial<ModelResolvableMarket> = {},
): ModelResolvableMarket {
  return {
    outcome: "resolvable",
    status: "draft",
    ...validMarketFields(),
    ...overrides,
  };
}

export function validUnresolvableOutput(
  overrides: Partial<UnresolvableOutcome> = {},
): UnresolvableOutcome {
  return {
    outcome: "unresolvable",
    reason:
      "The headline depends on an undefined term with no measurable baseline or named source, so it cannot be settled objectively.",
    missingInformation: ["A measurable metric", "A named authority"],
    suggestedRevision: null,
    ...overrides,
  };
}
