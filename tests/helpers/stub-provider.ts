import type { ModelOutput } from "../../src/lib/domain/schema";
import type {
  GenerationInput,
  MarketGenerationProvider,
  ProviderGenerationOptions,
  ProviderResult,
} from "../../src/lib/llm/types";

/**
 * Deterministic provider stub for service and handler tests. Returns queued
 * outputs in order (repeating the last one) and records every call.
 */
export class StubProvider implements MarketGenerationProvider {
  readonly name = "stub-provider";
  readonly mode = "heuristic" as const;
  readonly model: string | null = null;
  readonly fallbackReason = "forced_heuristic" as const;
  calls: GenerationInput[] = [];
  options: Array<ProviderGenerationOptions | undefined> = [];
  requestsPerCall: number;

  constructor(
    private readonly outputs: ModelOutput[],
    requestsPerCall = 1,
  ) {
    if (outputs.length === 0) throw new Error("StubProvider requires at least one output");
    this.requestsPerCall = requestsPerCall;
  }

  async generate(
    input: GenerationInput,
    options?: ProviderGenerationOptions,
  ): Promise<ProviderResult> {
    const index = Math.min(this.calls.length, this.outputs.length - 1);
    this.calls.push(input);
    this.options.push(options);
    return {
      output: this.outputs[index],
      provider: this.name,
      requests: this.requestsPerCall,
    };
  }
}

/** Provider that always throws the given error. */
export class FailingProvider implements MarketGenerationProvider {
  readonly name = "failing-provider";
  readonly mode = "llm" as const;
  readonly model = "test-model";
  readonly fallbackReason = null;
  calls = 0;

  constructor(private readonly error: Error) {}

  async generate(): Promise<ProviderResult> {
    this.calls += 1;
    throw this.error;
  }
}
