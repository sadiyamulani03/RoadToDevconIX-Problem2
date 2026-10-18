import type { GenerationFallbackReason, ModelOutput, UnresolvableOutcome } from "../domain/schema";
import { MIN_DEADLINE_LEAD_MS, findSubjectiveTerms } from "../domain/semantic-validation";
import type {
  GenerationInput,
  MarketGenerationProvider,
  ProviderResult,
} from "./types";

/**
 * Offline, deterministic fallback used when no LLM API key is configured (or
 * when LLM_PROVIDER=heuristic). It is clearly labelled in every response and
 * in the UI as a heuristic, never presented as model output.
 *
 * It only ever:
 *  - extracts dates, a named source and/or a URL from the supplied text,
 *  - refuses headlines it cannot ground (subjective terms, no future date,
 *    no named source),
 *  - never invents facts, sources or URLs.
 */

export interface HeuristicProviderOptions {
  fallbackReason?: GenerationFallbackReason | null;
  now?: () => Date;
}

export const HEURISTIC_PROVIDER_NAME = "heuristic-rules-v1";

interface DateCandidate {
  instant: Date;
  label: string;
  fromSnippet: boolean;
}

const MONTH_INDEX: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

const MONTH_PATTERN = Object.keys(MONTH_INDEX).join("|");

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Builds an instant at 23:59:59 in the given UTC offset (minutes east of UTC). */
function endOfDayInstant(year: number, month: number, day: number, offsetMinutes: number): Date {
  const utcMs = Date.UTC(year, month - 1, day, 23, 59, 59) - offsetMinutes * 60_000;
  return new Date(utcMs);
}

function humanDate(year: number, month: number, day: number, zoneLabel: string): string {
  return `${year}-${pad(month)}-${pad(day)} 23:59:59 ${zoneLabel}`;
}

function extractDateCandidates(text: string, fromSnippet: boolean): DateCandidate[] {
  const candidates: DateCandidate[] = [];

  for (const match of text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= lastDayOfMonth(year, month)) {
      candidates.push({
        instant: endOfDayInstant(year, month, day, 0),
        label: `${year}-${pad(month)}-${pad(day)}`,
        fromSnippet,
      });
    }
  }

  const monthFirst = new RegExp(
    `\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})\\b`,
    "gi",
  );
  for (const match of text.matchAll(monthFirst)) {
    const month = MONTH_INDEX[match[1].toLowerCase()];
    const day = Number(match[2]);
    const year = Number(match[3]);
    if (day >= 1 && day <= lastDayOfMonth(year, month)) {
      candidates.push({
        instant: endOfDayInstant(year, month, day, 0),
        label: `${year}-${pad(month)}-${pad(day)}`,
        fromSnippet,
      });
    }
  }

  const dayFirst = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_PATTERN})\\s+(20\\d{2})\\b`,
    "gi",
  );
  for (const match of text.matchAll(dayFirst)) {
    const day = Number(match[1]);
    const month = MONTH_INDEX[match[2].toLowerCase()];
    const year = Number(match[3]);
    if (day >= 1 && day <= lastDayOfMonth(year, month)) {
      candidates.push({
        instant: endOfDayInstant(year, month, day, 0),
        label: `${year}-${pad(month)}-${pad(day)}`,
        fromSnippet,
      });
    }
  }

  const monthYear = new RegExp(`\\b(${MONTH_PATTERN})\\s+(20\\d{2})\\b`, "gi");
  for (const match of text.matchAll(monthYear)) {
    const month = MONTH_INDEX[match[1].toLowerCase()];
    const year = Number(match[2]);
    const day = lastDayOfMonth(year, month);
    candidates.push({
      instant: endOfDayInstant(year, month, day, 0),
      label: `${year}-${pad(month)}-${pad(day)}`,
      fromSnippet,
    });
  }

  const bareYear = /\b(20\d{2})\b(?!-\d{2}-\d{2})/g;
  for (const match of text.matchAll(bareYear)) {
    const year = Number(match[1]);
    candidates.push({
      instant: endOfDayInstant(year, 12, 31, 0),
      label: `${year}-12-31`,
      fromSnippet,
    });
  }

  const seen = new Set<number>();
  return candidates
    .filter((candidate) => {
      const key = candidate.instant.getTime();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.instant.getTime() - b.instant.getTime());
}

function detectTimezone(text: string): { offsetMinutes: number; label: string } {
  if (/\bIST\b|India Standard Time/i.test(text)) {
    return { offsetMinutes: 330, label: "IST (UTC+05:30)" };
  }
  return { offsetMinutes: 0, label: "UTC" };
}

function extractSourceUrl(...texts: string[]): string | null {
  for (const text of texts) {
    const match = text.match(/https?:\/\/[^\s<>"')\]},;]+/);
    if (match) {
      return match[0].replace(/[.,;:]+$/, "");
    }
  }
  return null;
}

function extractSourceName(...texts: string[]): string | null {
  const patterns: RegExp[] = [
    // Accept "According" at the start of a sentence as well as lowercase.
    /\b[Aa]ccording to (?:the )?([A-Z][\p{L}\d&.'-]*(?:\s+(?:of|for|and|the|[A-Z][\p{L}\d&.'-]*)){0,6})/u,
    /\b(?:the\s+)?([A-Z][\p{L}\d&.'-]*(?:\s+(?:of|for|and|the|[A-Z][\p{L}\d&.'-]*)){1,6})\s+(?:will|has|have|had|is|are|announced|confirmed|publishes?|published|reports?|said|scheduled|declared|released|releases)\b/u,
    /\b([A-Z][\p{L}\d&.'-]*(?:\s+[A-Z][\p{L}\d&.'-]*){1,5})\s+(?:official|press release|results?|data|website|notification|gazette)\b/u,
  ];
  for (const text of texts) {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        return match[1].trim();
      }
    }
  }
  return null;
}

function sourceFromUrl(url: string): string | null {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return hostname.length > 0 ? hostname : null;
  } catch {
    return null;
  }
}

function toPredicate(question: string): string {
  return question
    .trim()
    .replace(/\?+$/, "")
    .replace(/^(will|does|do|is|are|has|have|did|can|could|would|may)\s+/i, "")
    .trim();
}

function unresolvable(
  reason: string,
  missingInformation: string[],
  suggestedRevision: string | null,
): ModelOutput {
  const outcome: UnresolvableOutcome = {
    outcome: "unresolvable",
    reason,
    missingInformation,
    suggestedRevision,
  };
  return outcome;
}

export function createHeuristicProvider(options: HeuristicProviderOptions = {}): MarketGenerationProvider {
  const now = options.now ?? (() => new Date());
  const fallbackReason = options.fallbackReason ?? "no_api_key";

  return {
    name: HEURISTIC_PROVIDER_NAME,
    mode: "heuristic",
    model: null,
    fallbackReason: fallbackReason ?? "no_api_key",
    async generate(input: GenerationInput): Promise<ProviderResult> {
      const output = generateHeuristicOutput(input, now());
      return { output, provider: HEURISTIC_PROVIDER_NAME, requests: 1 };
    },
  };
}

/**
 * Pure, deterministic heuristic. Exported directly for unit and golden tests.
 */
export function generateHeuristicOutput(input: GenerationInput, now: Date): ModelOutput {
  const headline = input.headline.trim();
  const snippet = input.articleSnippet?.trim() ?? "";
  const combined = snippet.length > 0 ? `${headline} ${snippet}` : headline;

  if (!headline) {
    return unresolvable(
      "No headline was supplied.",
      ["A news headline"],
      null,
    );
  }

  const subjective = findSubjectiveTerms(headline);
  const blockingSubjective = subjective.filter((match) => !match.hasNumericAnchor);
  if (blockingSubjective.length > 0) {
    const terms = blockingSubjective.map((match) => `"${match.term}"`).join(", ");
    return unresolvable(
      `The headline depends on subjective terms (${terms}) with no objective, measurable settlement condition. A fair market needs a defined metric, threshold and baseline.`,
      [
        "A measurable quantity with a numeric threshold",
        "A defined baseline or comparator",
        "A named authority that publishes the measurement",
      ],
      'Rewrite the headline around a measurable outcome, for example: "Will <measurable metric> be above <numeric threshold> by <date> according to <named authority>?"',
    );
  }

  const questionMarks = (headline.match(/\?/g) ?? []).length;
  if (questionMarks > 1) {
    return unresolvable(
      "The headline bundles more than one question, so it cannot be settled as a single YES/NO market.",
      ["A single proposition to settle"],
      "Split the bundled events into separate headlines, one per market.",
    );
  }

  if (!/^(will|does|do|is|are|has|have|did|can|could|would|may)\b/i.test(headline)) {
    return unresolvable(
      "The headline is not phrased as a YES/NO question, so the fallback cannot convert it into a fair market without inventing a proposition.",
      ["A YES/NO question phrasing"],
      `Rewrite as a question, for example: "Will ${headline.replace(/[.?]+$/, "")}?"`,
    );
  }

  const headlineDates = extractDateCandidates(headline, false);
  const snippetDates = extractDateCandidates(snippet, true);
  const allDates = [...snippetDates, ...headlineDates].sort(
    (a, b) => a.instant.getTime() - b.instant.getTime(),
  );

  const cutoff = now.getTime() + MIN_DEADLINE_LEAD_MS;
  const futureDates = allDates.filter((candidate) => candidate.instant.getTime() > cutoff);
  const soonDates = allDates.filter(
    (candidate) => candidate.instant.getTime() > now.getTime() && candidate.instant.getTime() <= cutoff,
  );
  const chosenDate = futureDates[0] ?? soonDates[0];

  if (!chosenDate) {
    if (allDates.length > 0) {
      return unresolvable(
        `Every date mentioned in the headline or snippet (${allDates
          .map((candidate) => candidate.label)
          .join(", ")}) is already in the past, so a future settlement deadline cannot be established.`,
        ["A future announcement or event date"],
        "Update the headline with a date that is still in the future.",
      );
    }
    return unresolvable(
      "The headline and snippet contain no explicit date, so a settlement deadline cannot be established without inventing one.",
      ["An explicit announcement or event date", "A settlement deadline"],
      'Add a dated commitment, for example: "Will <event> happen by <date>?"',
    );
  }

  const url = extractSourceUrl(snippet, headline);
  const namedSource = extractSourceName(snippet, headline);
  const source = namedSource ?? (url ? sourceFromUrl(url) : null);

  if (!source) {
    return unresolvable(
      "No named, authoritative source appears in the headline or snippet, so the outcome cannot be settled objectively.",
      ["The named authority, publication or dataset that will settle the outcome"],
      'Name the settling authority, for example: "according to <official body/publication>".',
    );
  }

  const timezone = detectTimezone(combined);
  const closeInstant = new Date(
    chosenDate.instant.getTime() - timezone.offsetMinutes * 60_000,
  );
  const cluster = chosenDate.instant.getTime() + timezone.offsetMinutes * 60_000;
  const clusterDate = new Date(cluster);
  const closeAt = closeInstant.toISOString();
  const closeHuman = humanDate(
    clusterDate.getUTCFullYear(),
    clusterDate.getUTCMonth() + 1,
    clusterDate.getUTCDate(),
    timezone.label,
  );

  const question = headline.endsWith("?") ? headline : `${headline}?`;
  const predicate = toPredicate(question);

  const output: ModelOutput = {
    outcome: "resolvable",
    status: "draft",
    question,
    closeAt,
    timezone: timezone.label,
    resolutionSource: source,
    resolutionSourceUrl: url,
    yesCriteria: `Yes, if ${source} publishes or confirms that ${predicate} on or before ${closeHuman}.`,
    noCriteria: `No, if ${source} has not published or confirmed that ${predicate} by ${closeHuman}, including if the relevant announcement is delayed or never issued.`,
    resolutionRules: [
      `If ${source} reports that the event is postponed or rescheduled to a date after ${closeHuman}, the market resolves NO.`,
      `If ${source} reports that the event is cancelled or abandoned, the market resolves NO.`,
      `If ${source} has not published the expected information by ${closeHuman}, the market resolves NO; the deadline is not extended silently.`,
      `If two official sources conflict, the publication issued by ${source} takes precedence; if ${source} publishes a correction, the corrected publication decides the market.`,
    ],
    reasoning: `Constructed offline by the ${HEURISTIC_PROVIDER_NAME} fallback (no LLM configured). The deadline, close time and source were extracted only from text present in the supplied headline or snippet; no external facts were added. An independent observer can settle the market from ${source} by ${closeHuman}.`,
  };

  return output;
}
