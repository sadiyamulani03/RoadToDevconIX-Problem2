import { z } from "zod";
import { ModelOutputSchema } from "../domain/schema";

/**
 * JSON Schema handed to the provider's structured-output mechanism.
 *
 * It is derived from the same Zod schema used for runtime validation, but
 * normalised for provider compatibility:
 *
 *  - `$schema` / `format` keywords are removed (providers reject unknown
 *    or unsupported formats and the server-side Zod parse is authoritative),
 *  - `oneOf` is rewritten to `anyOf` (the discriminated union has distinct
 *    `outcome` constants, so the semantics are equivalent and `anyOf` is
 *    the keyword supported by OpenAI-style structured outputs).
 *
 * Zod remains the single source of truth: the derived schema cannot drift
 * from the runtime validator.
 */

function normaliseForProvider(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(normaliseForProvider);
  }
  if (node !== null && typeof node === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "$schema" || key === "$id" || key === "format") continue;
      if (key === "oneOf") {
        output.anyOf = normaliseForProvider(value);
        continue;
      }
      output[key] = normaliseForProvider(value);
    }
    return output;
  }
  return node;
}

export function buildProviderJsonSchema(): Record<string, unknown> {
  const derived = z.toJSONSchema(ModelOutputSchema);
  const normalised = normaliseForProvider(derived);
  if (normalised === null || typeof normalised !== "object" || Array.isArray(normalised)) {
    throw new Error("z.toJSONSchema returned an unexpected shape");
  }
  return normalised as Record<string, unknown>;
}
