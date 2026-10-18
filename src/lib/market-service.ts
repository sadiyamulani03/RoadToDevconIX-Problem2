import type { Clock } from "./clock";
import {
  MarketDataSchema,
  type DraftRequest,
  type GenerationInfo,
  type MarketData,
  type MarketFields,
  type MarketRecord,
  type ModelResolvableMarket,
  type UnresolvableOutcome,
} from "./domain/schema";
import {
  hasBlockingErrors,
  validateMarketSemantics,
} from "./domain/semantic-validation";
import type { MarketGenerationProvider, ProviderGenerationOptions } from "./llm/types";
import { MarketStore } from "./db";

export type MarketServiceErrorCode =
  | "not_found"
  | "already_approved"
  | "discarded_cannot_be_approved"
  | "approved_markets_cannot_be_discarded"
  | "discarded_markets_cannot_be_edited"
  | "rules_locked_after_approval"
  | "draft_failed_validation"
  | "stored_draft_invalid";

const STATUS_BY_CODE: Record<MarketServiceErrorCode, number> = {
  not_found: 404,
  already_approved: 409,
  discarded_cannot_be_approved: 409,
  approved_markets_cannot_be_discarded: 409,
  discarded_markets_cannot_be_edited: 409,
  rules_locked_after_approval: 409,
  draft_failed_validation: 422,
  stored_draft_invalid: 422,
};

export class MarketServiceError extends Error {
  readonly code: MarketServiceErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: MarketServiceErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "MarketServiceError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }
}

export type GenerateDraftResult =
  | { kind: "resolvable"; record: MarketRecord; generation: GenerationInfo }
  | { kind: "unresolvable"; rejection: UnresolvableOutcome; generation: GenerationInfo };

export interface MarketServiceOptions {
  store: MarketStore;
  provider: MarketGenerationProvider;
  clock: Clock;
  /** Bounded semantic correction passes after an invalid deadline. Default 1. */
  maxCorrectionPasses?: number;
  generateId?: () => string;
}

const DEADLINE_ERROR_CODES = new Set([
  "deadline_in_past",
  "deadline_too_soon",
  "deadline_invalid",
  "deadline_missing_timezone",
  "deadline_before_question_event",
]);

export class MarketService {
  private readonly store: MarketStore;
  private readonly provider: MarketGenerationProvider;
  private readonly clock: Clock;
  private readonly maxCorrectionPasses: number;
  private readonly generateId: () => string;

  constructor(options: MarketServiceOptions) {
    this.store = options.store;
    this.provider = options.provider;
    this.clock = options.clock;
    this.maxCorrectionPasses = options.maxCorrectionPasses ?? 1;
    this.generateId = options.generateId ?? (() => crypto.randomUUID());
  }

  get providerInfo() {
    return {
      name: this.provider.name,
      mode: this.provider.mode,
      model: this.provider.model,
      fallbackReason: this.provider.fallbackReason,
    };
  }

  /**
   * Generates a market draft. The generation path can only ever persist a
   * draft: the resolved `status` is written as "draft" unconditionally.
   */
  async generateDraft(input: DraftRequest): Promise<GenerateDraftResult> {
    let totalRequests = 0;
    let options: ProviderGenerationOptions | undefined;

    const callProvider = async () => {
      const result = await this.provider.generate(input, options);
      totalRequests += result.requests;
      return result.output;
    };

    let output = await callProvider();

    if (output.outcome === "unresolvable") {
      return { kind: "unresolvable", rejection: output, generation: this.generationInfo(totalRequests) };
    }

    let market = this.toMarketData(output);
    let issues = validateMarketSemantics(market, this.clock.now());

    let correctionsUsed = 0;
    while (
      correctionsUsed < this.maxCorrectionPasses &&
      issues.some((issue) => issue.severity === "error" && DEADLINE_ERROR_CODES.has(issue.code))
    ) {
      correctionsUsed += 1;
      options = {
        correction: {
          issues: issues
            .filter((issue) => issue.severity === "error" && DEADLINE_ERROR_CODES.has(issue.code))
            .map(({ code, severity, field, message }) => ({ code, severity, field, message })),
        },
      };
      output = await callProvider();
      if (output.outcome === "unresolvable") {
        return {
          kind: "unresolvable",
          rejection: output,
          generation: this.generationInfo(totalRequests),
        };
      }
      market = this.toMarketData(output);
      issues = validateMarketSemantics(market, this.clock.now());
    }

    const record = this.store.create({
      id: this.generateId(),
      market,
      issues,
      generationMode: this.provider.mode,
      generationProvider: this.provider.name,
      now: this.clock.now(),
    });
    return { kind: "resolvable", record, generation: this.generationInfo(totalRequests) };
  }

  get(id: string): MarketRecord {
    const record = this.store.get(id);
    if (!record) {
      throw new MarketServiceError("not_found", `No market exists with id ${id}.`);
    }
    return record;
  }

  list(limit = 50): MarketRecord[] {
    return this.store.list(limit);
  }

  /** Replaces the editable fields of a draft. Approved rules are immutable. */
  updateDraft(id: string, fields: MarketFields): MarketRecord {
    const record = this.get(id);
    if (record.status === "approved") {
      throw new MarketServiceError(
        "rules_locked_after_approval",
        "Approved market rules are locked and cannot be edited. Create a new draft instead.",
      );
    }
    if (record.status === "discarded") {
      throw new MarketServiceError(
        "discarded_markets_cannot_be_edited",
        "Discarded drafts cannot be edited. Generate a new draft instead.",
      );
    }

    const parsed = MarketDataSchema.safeParse({
      ...fields,
      outcome: "resolvable",
      status: record.status,
    });
    if (!parsed.success) {
      throw new MarketServiceError(
        "draft_failed_validation",
        "The edited market does not satisfy the market schema.",
        parsed.error.issues.slice(0, 5),
      );
    }

    const issues = validateMarketSemantics(parsed.data, this.clock.now());
    return this.store.updateMarket(id, parsed.data, issues, this.clock.now());
  }

  /**
   * Explicit editor approval. Re-loads the persisted draft, re-validates it
   * against the schema, re-runs semantic validation with a fresh clock and
   * refuses to approve anything invalid or expired.
   */
  approve(id: string): MarketRecord {
    const record = this.get(id);
    if (record.status === "approved") {
      throw new MarketServiceError("already_approved", "This market is already approved.");
    }
    if (record.status === "discarded") {
      throw new MarketServiceError(
        "discarded_cannot_be_approved",
        "A discarded draft cannot be approved. Generate a new draft instead.",
      );
    }

    const parsed = MarketDataSchema.safeParse(record.market);
    if (!parsed.success) {
      throw new MarketServiceError(
        "stored_draft_invalid",
        "The stored draft failed schema validation and cannot be approved.",
        parsed.error.issues.slice(0, 5),
      );
    }

    const issues = validateMarketSemantics(parsed.data, this.clock.now());
    if (hasBlockingErrors(issues)) {
      throw new MarketServiceError(
        "draft_failed_validation",
        "The draft has blocking validation errors and cannot be approved until they are fixed.",
        issues,
      );
    }

    return this.store.updateStatus(id, "approved", this.clock.now(), issues);
  }

  discard(id: string): MarketRecord {
    const record = this.get(id);
    if (record.status === "approved") {
      throw new MarketServiceError(
        "approved_markets_cannot_be_discarded",
        "An approved market cannot be discarded; its rules are final.",
      );
    }
    if (record.status === "discarded") {
      return record;
    }
    return this.store.updateStatus(id, "discarded", this.clock.now());
  }

  private toMarketData(output: ModelResolvableMarket): MarketData {
    return {
      outcome: "resolvable",
      status: "draft",
      question: output.question,
      closeAt: output.closeAt,
      timezone: output.timezone,
      resolutionSource: output.resolutionSource,
      resolutionSourceUrl: output.resolutionSourceUrl,
      yesCriteria: output.yesCriteria,
      noCriteria: output.noCriteria,
      resolutionRules: [...output.resolutionRules],
      reasoning: output.reasoning,
    };
  }

  private generationInfo(requests: number): GenerationInfo {
    return {
      mode: this.provider.mode,
      provider: this.provider.name,
      model: this.provider.model,
      requests,
      fallbackReason: this.provider.fallbackReason,
    };
  }
}
