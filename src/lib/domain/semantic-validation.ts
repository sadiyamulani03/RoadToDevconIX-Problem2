import type { MarketFields, SemanticIssue } from "./schema";

/**
 * Semantic validation: checks that schema-valid output is also a *fair,
 * objectively decidable* market. Schema validation is necessary but never
 * sufficient. Nothing here trusts the model prompt.
 *
 * All time comparisons use the `now` argument so tests can inject a fixed
 * clock. No function in this module performs network I/O.
 */

export const MIN_DEADLINE_LEAD_MS = 60 * 60 * 1000; // 1 hour
export const MAX_DEADLINE_HORIZON_MS = 5 * 365.25 * 24 * 60 * 60 * 1000; // ~5 years

const HAS_TIMEZONE_RE = /(?:Z|[+-]\d{2}:\d{2})$/;

export function parseIsoInstant(value: string): Date | null {
  const trimmed = value.trim();
  if (!HAS_TIMEZONE_RE.test(trimmed)) return null;

  // Reject impossible calendar dates (e.g. 2027-02-30) that `new Date`
  // would silently roll over into the next month.
  const calendar = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})T/);
  if (!calendar) return null;
  const year = Number(calendar[1]);
  const month = Number(calendar[2]);
  const day = Number(calendar[3]);
  if (month < 1 || month > 12 || day < 1) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) return null;

  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

export function hasBlockingErrors(issues: SemanticIssue[]): boolean {
  return issues.some((issue) => issue.severity === "error");
}

function issue(
  code: string,
  severity: SemanticIssue["severity"],
  field: string,
  message: string,
): SemanticIssue {
  return { code, severity, field, message };
}

/* -------------------------------------------------------------------------- */
/* Deadline validation                                                        */
/* -------------------------------------------------------------------------- */

export function validateDeadline(closeAt: string, now: Date): SemanticIssue[] {
  const issues: SemanticIssue[] = [];
  const trimmed = closeAt.trim();

  if (!HAS_TIMEZONE_RE.test(trimmed)) {
    issues.push(
      issue(
        "deadline_missing_timezone",
        "error",
        "closeAt",
        "The close time must include an explicit timezone (e.g. 2027-01-31T23:59:00Z or an offset such as +05:30).",
      ),
    );
  }

  const parsed = parseIsoInstant(trimmed);
  if (!parsed) {
    issues.push(
      issue("deadline_invalid", "error", "closeAt", "The close time is not a valid ISO 8601 timestamp."),
    );
    return issues;
  }

  const deltaMs = parsed.getTime() - now.getTime();
  if (deltaMs <= 0) {
    issues.push(
      issue(
        "deadline_in_past",
        "error",
        "closeAt",
        "The close time is not in the future. A market cannot close in the past or at the present moment.",
      ),
    );
  } else if (deltaMs < MIN_DEADLINE_LEAD_MS) {
    issues.push(
      issue(
        "deadline_too_soon",
        "error",
        "closeAt",
        "The close time is less than one hour away; there is no practical window to open a market.",
      ),
    );
  } else if (deltaMs > MAX_DEADLINE_HORIZON_MS) {
    issues.push(
      issue(
        "deadline_too_far",
        "warning",
        "closeAt",
        "The close time is more than five years away, which is unusually long for a news-driven market.",
      ),
    );
  }

  return issues;
}

/* -------------------------------------------------------------------------- */
/* Question quality                                                           */
/* -------------------------------------------------------------------------- */

export const SUBJECTIVE_TERMS = [
  "better",
  "best",
  "improve",
  "improves",
  "improved",
  "improving",
  "improvement",
  "worse",
  "worst",
  "successful",
  "success",
  "popular",
  "popularity",
  "happier",
  "happiest",
  "happy",
  "happiness",
  "good job",
  "doing well",
  "effectively",
  "efficiently",
  "reasonable",
  "significant",
  "significantly",
  "substantial",
  "substantially",
  "strong",
  "stronger",
  "strongest",
  "weak",
  "weaker",
  "healthy",
  "unhealthy",
  "beautiful",
  "attractive",
  "promising",
  "impressive",
  "disappointing",
  "meaningful",
  "stable",
  "unstable",
  "prosperous",
  "better off",
  "worse off",
  "worthwhile",
  "appropriate",
  "adequate",
  "fairly",
  "fair share",
] as const;

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

export interface SubjectiveMatch {
  term: string;
  hasNumericAnchor: boolean;
}

export function findSubjectiveTerms(text: string): SubjectiveMatch[] {
  const matches: SubjectiveMatch[] = [];
  const lower = text.toLowerCase();
  for (const sentence of splitSentences(lower)) {
    for (const term of SUBJECTIVE_TERMS) {
      const pattern = new RegExp(`\\b${term.replace(/\s+/g, "\\s+")}\\b`);
      if (pattern.test(sentence)) {
        matches.push({ term, hasNumericAnchor: /\d/.test(sentence) });
      }
    }
  }
  // de-duplicate by term + anchor
  const seen = new Set<string>();
  return matches.filter((match) => {
    const key = `${match.term}:${match.hasNumericAnchor}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function validateQuestion(question: string, closeAt: string | null): SemanticIssue[] {
  const issues: SemanticIssue[] = [];
  const trimmed = question.trim();

  if (!trimmed.endsWith("?")) {
    issues.push(
      issue(
        "question_not_a_question",
        "error",
        "question",
        "The market question must be phrased as a question answerable with YES or NO (it must end with '?').",
      ),
    );
  }

  const questionMarks = (trimmed.match(/\?/g) ?? []).length;
  if (questionMarks > 1) {
    issues.push(
      issue(
        "bundled_question",
        "error",
        "question",
        "The question asks more than one question. Split bundled events into separate markets.",
      ),
    );
  }

  if (!/^\s*(will|does|do|is|are|has|have|did|can|could|would|may)\b/i.test(trimmed)) {
    issues.push(
      issue(
        "question_not_yes_no_phrased",
        "warning",
        "question",
        "The question does not start with a YES/NO phrasing such as 'Will ...?', which risks an ambiguous settlement.",
      ),
    );
  }

  if (/\band\s+(whether|will|would|does|do|is|are|has|have|did|can)\b/i.test(trimmed)) {
    issues.push(
      issue(
        "possible_bundled_question",
        "warning",
        "question",
        "The question appears to bundle a second condition after 'and'; confirm it is a single proposition.",
      ),
    );
  }

  for (const match of findSubjectiveTerms(trimmed)) {
    if (match.hasNumericAnchor) {
      issues.push(
        issue(
          "subjective_term_needs_metric",
          "warning",
          "question",
          `The term "${match.term}" is subjective; make sure the numeric threshold is explicit in the question.`,
        ),
      );
    } else {
      issues.push(
        issue(
          "subjective_term",
          "error",
          "question",
          `The question depends on the undefined term "${match.term}", which cannot be settled objectively.`,
        ),
      );
    }
  }

  if (closeAt) {
    const closeDate = parseIsoInstant(closeAt);
    const years = [...trimmed.matchAll(/\b(20\d{2})\b/g)].map((match) => Number(match[1]));
    if (closeDate && years.length > 0) {
      const closeYear = closeDate.getUTCFullYear();
      const earliestYear = Math.min(...years);
      const latestYear = Math.max(...years);
      if (closeYear < earliestYear) {
        issues.push(
          issue(
            "deadline_before_question_event",
            "error",
            "closeAt",
            `The close time (${closeYear}) is before the year referenced by the question (${earliestYear}).`,
          ),
        );
      } else if (closeYear > latestYear + 2) {
        issues.push(
          issue(
            "deadline_well_after_question_event",
            "warning",
            "closeAt",
            `The close time (${closeYear}) is more than two years after the latest year in the question (${latestYear}).`,
          ),
        );
      }
    }
  }

  return issues;
}

/* -------------------------------------------------------------------------- */
/* Resolution-source quality                                                  */
/* -------------------------------------------------------------------------- */

export const GENERIC_SOURCE_TERMS = new Set([
  "internet",
  "the internet",
  "web",
  "the web",
  "online",
  "media",
  "the media",
  "media reports",
  "news",
  "the news",
  "news reports",
  "news outlets",
  "the press",
  "press",
  "press reports",
  "official reports",
  "official report",
  "official sources",
  "official source",
  "official statements",
  "sources",
  "sources close to",
  "reports",
  "the public",
  "public opinion",
  "social media",
  "various sources",
  "multiple sources",
  "the government",
  "government",
  "authorities",
  "officials",
  "experts",
  "analysts",
  "everyone",
  "common knowledge",
]);

export function isGenericSource(source: string): boolean {
  const normalized = source
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length < 4) return true;
  return GENERIC_SOURCE_TERMS.has(normalized);
}

export interface UrlSafetyResult {
  ok: boolean;
  code?: "invalid_source_url" | "non_http_source_url" | "url_credentials_not_allowed" | "unsafe_source_url";
  message?: string;
}

const PRIVATE_HOST_PREFIXES = [
  "localhost",
  "127.",
  "0.",
  "10.",
  "192.168.",
  "169.254.",
  "172.16.",
  "172.17.",
  "172.18.",
  "172.19.",
  "172.20.",
  "172.21.",
  "172.22.",
  "172.23.",
  "172.24.",
  "172.25.",
  "172.26.",
  "172.27.",
  "172.28.",
  "172.29.",
  "172.30.",
  "172.31.",
];

/**
 * Syntactic URL safety check. This module never fetches source URLs; this
 * guard exists so that any future optional verification cannot be pointed at
 * localhost or private networks (SSRF defense in depth) and so no private
 * address can be passed off as an authoritative public source.
 */
export function checkSourceUrlSafety(rawUrl: string): UrlSafetyResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, code: "invalid_source_url", message: "The resolution source URL is not a valid URL." };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      code: "non_http_source_url",
      message: "The resolution source URL must use http or https.",
    };
  }

  if (parsed.username !== "" || parsed.password !== "") {
    return {
      ok: false,
      code: "url_credentials_not_allowed",
      message: "The resolution source URL must not contain embedded credentials.",
    };
  }

  const hostname = parsed.hostname.toLowerCase();
  const isPrivateIpv6 =
    hostname.startsWith("[::1]") ||
    hostname.startsWith("[fc") ||
    hostname.startsWith("[fd") ||
    hostname.startsWith("[fe80");
  const isPrivate =
    hostname.endsWith(".local") ||
    hostname === "localhost" ||
    PRIVATE_HOST_PREFIXES.some((prefix) => hostname.startsWith(prefix)) ||
    isPrivateIpv6;

  if (isPrivate) {
    return {
      ok: false,
      code: "unsafe_source_url",
      message: "The resolution source URL points to a local or private address, which cannot be an authoritative public source.",
    };
  }

  return { ok: true };
}

export function validateResolutionSource(
  source: string,
  sourceUrl: string | null,
): SemanticIssue[] {
  const issues: SemanticIssue[] = [];

  if (isGenericSource(source)) {
    issues.push(
      issue(
        "generic_resolution_source",
        "error",
        "resolutionSource",
        `"${source.trim()}" is not a named, authoritative source. Name the specific body, publication or dataset that will settle the market.`,
      ),
    );
  }

  if (sourceUrl !== null) {
    const safety = checkSourceUrlSafety(sourceUrl);
    if (!safety.ok && safety.code) {
      issues.push(issue(safety.code, "error", "resolutionSourceUrl", safety.message ?? "The URL is not usable."));
    }
  }

  return issues;
}

/* -------------------------------------------------------------------------- */
/* Settlement fairness                                                        */
/* -------------------------------------------------------------------------- */

const SOURCE_FAILURE_RE =
  /(not\s+(?:be\s+)?(?:publish|announce|issu|release|confirm)|fails?\s+to|failure\s+to|no\s+(?:official\s+)?(?:announcement|statement|result|results|data|report|publication|confirmation)|(?:becomes?|is)\s+unavailable|does\s+not\s+publish|has\s+not\s+published|no\s+decision|without\s+(?:an?\s+)?(?:official\s+)?(?:announcement|statement|result))/i;

const POSTPONEMENT_RE = /(postpon|reschedul|delay|delayed|pushed\s+back)/i;
const CANCELLATION_RE = /(cancel|abandon|scrap|withdraw)/i;
const CORRECTION_RE = /(correct|revision|errata|amended|updated\s+version)/i;

const VAGUE_RULE_PATTERNS: RegExp[] = [
  /editor'?s?\s+(?:discretion|opinion|judgement|judgment)/i,
  /as\s+(?:the\s+)?editor\s+(?:sees|thinks|decides)/i,
  /(?:using|based\s+on)\s+(?:all\s+)?available\s+information/i,
  /common\s+sense/i,
  /reasonable\s+(?:interpretation|judgement|judgment|view)/i,
  /whatever\s+(?:happens|seems)/i,
  /as\s+appropriate/i,
  /if\s+in\s+doubt/i,
];

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function validateSettlement(market: MarketFields): SemanticIssue[] {
  const issues: SemanticIssue[] = [];

  if (market.yesCriteria.trim().toLowerCase() === market.noCriteria.trim().toLowerCase()) {
    issues.push(
      issue(
        "identical_yes_no_criteria",
        "error",
        "yesCriteria",
        "The YES and NO criteria are identical; they must describe mutually exclusive outcomes.",
      ),
    );
  }

  const seenRules = new Map<string, number>();
  market.resolutionRules.forEach((rule, index) => {
    const normalized = rule.trim().toLowerCase();
    seenRules.set(normalized, (seenRules.get(normalized) ?? 0) + 1);
    void index;
  });
  for (const [rule, count] of seenRules) {
    if (count > 1) {
      issues.push(
        issue(
          "duplicate_resolution_rule",
          "error",
          "resolutionRules",
          `The rule "${rule.slice(0, 60)}${rule.length > 60 ? "..." : ""}" appears more than once.`,
        ),
      );
    }
  }

  market.resolutionRules.forEach((rule) => {
    if (VAGUE_RULE_PATTERNS.some((pattern) => pattern.test(rule))) {
      issues.push(
        issue(
          "vague_resolution_rule",
          "error",
          "resolutionRules",
          `The rule "${rule.slice(0, 60)}${rule.length > 60 ? "..." : ""}" leaves the outcome to judgement instead of defining an objective resolution.`,
        ),
      );
    }
    if (wordCount(rule) < 6) {
      issues.push(
        issue(
          "rule_too_short",
          "warning",
          "resolutionRules",
          `The rule "${rule.slice(0, 60)}${rule.length > 60 ? "..." : ""}" is very short; spell out exactly how it is applied.`,
        ),
      );
    }
  });

  const combinedRules = market.resolutionRules.join("\n");
  if (!SOURCE_FAILURE_RE.test(combinedRules)) {
    issues.push(
      issue(
        "missing_source_failure_rule",
        "error",
        "resolutionRules",
        "The rules do not state what happens if the named source fails to publish the expected information by the deadline.",
      ),
    );
  }
  if (!POSTPONEMENT_RE.test(combinedRules)) {
    issues.push(
      issue(
        "missing_postponement_rule",
        "warning",
        "resolutionRules",
        "Consider an explicit rule for postponement or rescheduling of the event.",
      ),
    );
  }
  if (!CANCELLATION_RE.test(combinedRules)) {
    issues.push(
      issue(
        "missing_cancellation_rule",
        "warning",
        "resolutionRules",
        "Consider an explicit rule for cancellation of the event.",
      ),
    );
  }
  if (!CORRECTION_RE.test(combinedRules)) {
    issues.push(
      issue(
        "missing_correction_rule",
        "warning",
        "resolutionRules",
        "Consider a rule for how a corrected or revised publication is handled.",
      ),
    );
  }

  for (const match of findSubjectiveTerms([market.yesCriteria, market.noCriteria, ...market.resolutionRules].join(" "))) {
    if (!match.hasNumericAnchor) {
      issues.push(
        issue(
          "subjective_term_in_criteria",
          "error",
          "resolutionRules",
          `The settlement text depends on the undefined term "${match.term}".`,
        ),
      );
    }
  }

  if (!/(resolv|objective|official|public|deadline|source|confirm|measur|announce|publish|record)/i.test(market.reasoning)) {
    issues.push(
      issue(
        "reasoning_weak",
        "warning",
        "reasoning",
        "The reasoning does not explain how an independent observer would resolve the market.",
      ),
    );
  }

  return issues;
}

/* -------------------------------------------------------------------------- */
/* Aggregate                                                                  */
/* -------------------------------------------------------------------------- */

export function validateMarketSemantics(market: MarketFields, now: Date): SemanticIssue[] {
  return [
    ...validateDeadline(market.closeAt, now),
    ...validateQuestion(market.question, market.closeAt),
    ...validateResolutionSource(market.resolutionSource, market.resolutionSourceUrl),
    ...validateSettlement(market),
  ];
}

export function issueSummary(issues: SemanticIssue[], limit = 3): string {
  return issues
    .slice(0, limit)
    .map((semanticIssue) => `[${semanticIssue.code}] ${semanticIssue.message}`)
    .join(" ");
}
