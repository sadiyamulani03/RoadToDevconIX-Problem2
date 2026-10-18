import { z } from "zod";
import {
  MAX_ARTICLE_SNIPPET_LENGTH,
  MAX_HEADLINE_LENGTH,
  MAX_RESOLUTION_RULES,
  MIN_QUESTION_LENGTH,
  MIN_RESOLUTION_RULES,
} from "./constants";

export {
  MAX_ARTICLE_SNIPPET_LENGTH,
  MAX_HEADLINE_LENGTH,
  MAX_RESOLUTION_RULES,
  MIN_QUESTION_LENGTH,
  MIN_RESOLUTION_RULES,
} from "./constants";

/**
 * Domain schema for Headline to Market.
 *
 * The model response is always parsed through `ModelOutputSchema`, a
 * discriminated union with exactly two outcomes:
 *
 *   - `resolvable`   -> a complete market draft (always `status: "draft"`)
 *   - `unresolvable` -> an explicit rejection with a required reason
 *
 * A TypeScript type assertion is never a substitute for this runtime
 * validation; the parsed value is the only value the application uses.
 */

export const MARKET_STATUSES = ["draft", "approved", "discarded"] as const;
export const MarketStatusSchema = z.enum(MARKET_STATUSES);
export type MarketStatus = z.infer<typeof MarketStatusSchema>;

export const GENERATION_MODES = ["llm", "heuristic"] as const;
export const GenerationModeSchema = z.enum(GENERATION_MODES);
export type GenerationMode = z.infer<typeof GenerationModeSchema>;

const IsoInstantSchema = z.iso.datetime({ offset: true });

export const MarketFieldsSchema = z.object({
  question: z.string().trim().min(MIN_QUESTION_LENGTH).max(300),
  closeAt: IsoInstantSchema,
  timezone: z.string().trim().min(2).max(64),
  resolutionSource: z.string().trim().min(3).max(200),
  resolutionSourceUrl: z.union([z.url().max(500), z.null()]),
  yesCriteria: z.string().trim().min(10).max(600),
  noCriteria: z.string().trim().min(10).max(600),
  resolutionRules: z
    .array(z.string().trim().min(5).max(400))
    .min(MIN_RESOLUTION_RULES)
    .max(MAX_RESOLUTION_RULES),
  reasoning: z.string().trim().min(20).max(1000),
});
export type MarketFields = z.infer<typeof MarketFieldsSchema>;

/** What the model is allowed to return for the resolvable branch. */
export const ModelResolvableMarketSchema = MarketFieldsSchema.extend({
  outcome: z.literal("resolvable"),
  status: z.literal("draft"),
});
export type ModelResolvableMarket = z.infer<typeof ModelResolvableMarketSchema>;

/** What the model is allowed to return for the unresolvable branch. */
export const UnresolvableOutcomeSchema = z.object({
  outcome: z.literal("unresolvable"),
  reason: z.string().trim().min(20).max(1000),
  missingInformation: z
    .array(z.string().trim().min(3).max(300))
    .max(10),
  suggestedRevision: z.union([z.string().trim().min(10).max(500), z.null()]),
});
export type UnresolvableOutcome = z.infer<typeof UnresolvableOutcomeSchema>;

/**
 * Discriminated union of the only two model outcomes. This is the schema the
 * raw model response is parsed against before any generated field is used.
 */
export const ModelOutputSchema = z.discriminatedUnion("outcome", [
  ModelResolvableMarketSchema,
  UnresolvableOutcomeSchema,
]);
export type ModelOutput = z.infer<typeof ModelOutputSchema>;

/** A stored/edited market. The lifecycle status lives on the record. */
export const MarketDataSchema = MarketFieldsSchema.extend({
  outcome: z.literal("resolvable"),
  status: MarketStatusSchema,
});
export type MarketData = z.infer<typeof MarketDataSchema>;

export const SemanticIssueSchema = z.object({
  code: z.string().min(1).max(64),
  severity: z.enum(["error", "warning"]),
  field: z.string().min(1).max(64),
  message: z.string().min(1).max(500),
});
export type SemanticIssue = z.infer<typeof SemanticIssueSchema>;

/**
 * Persisted market record. `market.status` must mirror `status`; the refine
 * below makes any divergence a hard validation failure at the storage
 * boundary.
 */
export const MarketRecordSchema = z
  .object({
    id: z.uuid(),
    status: MarketStatusSchema,
    createdAt: IsoInstantSchema,
    updatedAt: IsoInstantSchema,
    approvedAt: z.union([IsoInstantSchema, z.null()]),
    discardedAt: z.union([IsoInstantSchema, z.null()]),
    generationMode: GenerationModeSchema,
    generationProvider: z.string().min(1).max(100),
    sourceVerification: z.literal("syntactic-only"),
    revision: z.number().int().min(1),
    market: MarketDataSchema,
    semanticIssues: z.array(SemanticIssueSchema).max(50),
  })
  .superRefine((record, ctx) => {
    if (record.market.status !== record.status) {
      ctx.addIssue({
        code: "custom",
        message: "market.status must mirror record.status",
        path: ["market", "status"],
      });
    }
  });
export type MarketRecord = z.infer<typeof MarketRecordSchema>;

export const GENERATION_FALLBACK_REASONS = ["no_api_key", "forced_heuristic"] as const;
export const GenerationFallbackReasonSchema = z.enum(GENERATION_FALLBACK_REASONS);
export type GenerationFallbackReason = z.infer<typeof GenerationFallbackReasonSchema>;

export const GenerationInfoSchema = z.object({
  mode: GenerationModeSchema,
  provider: z.string().min(1).max(100),
  model: z.union([z.string().min(1).max(120), z.null()]),
  requests: z.number().int().min(1).max(100),
  fallbackReason: z.union([GenerationFallbackReasonSchema, z.null()]),
});
export type GenerationInfo = z.infer<typeof GenerationInfoSchema>;

/** Request body for POST /api/draft. */
export const DraftRequestSchema = z.object({
  headline: z
    .string()
    .trim()
    .min(8, "headline must be at least 8 characters")
    .max(MAX_HEADLINE_LENGTH, `headline must be at most ${MAX_HEADLINE_LENGTH} characters`),
  articleSnippet: z
    .union([z.string().trim().max(MAX_ARTICLE_SNIPPET_LENGTH), z.null()])
    .optional()
    .transform((value) => (value && value.length > 0 ? value : null)),
});
export type DraftRequest = z.infer<typeof DraftRequestSchema>;

/** Request body for PATCH /api/markets/[id]. */
export const UpdateDraftRequestSchema = z.object({
  market: MarketFieldsSchema,
});
export type UpdateDraftRequest = z.infer<typeof UpdateDraftRequestSchema>;

/** Body required for destructive/lifecycle actions. */
export const ConfirmRequestSchema = z.object({
  confirm: z.literal(true),
});
export type ConfirmRequest = z.infer<typeof ConfirmRequestSchema>;
