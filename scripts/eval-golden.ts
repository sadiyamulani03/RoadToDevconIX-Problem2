/**
 * Golden-set evaluation CLI.
 *
 *   npm run eval:golden          deterministic offline evaluation (always runs)
 *   npm run eval:golden -- --live  additionally runs the configured live model
 *                                  (skipped, with a clear notice, when no
 *                                  LLM_API_KEY is configured)
 *
 * Exit code 1 if any deterministic case fails.
 */
import { fileURLToPath } from "node:url";
import { loadGoldenSet, runGoldenSet } from "../tests/golden/golden-runner";
import { createProviderFromConfig, loadLlmConfig } from "../src/lib/llm/config";
import { MarketProviderError } from "../src/lib/llm/errors";

const FIXTURE_PATH = fileURLToPath(new URL("../tests/fixtures/golden-set.json", import.meta.url));

async function main(): Promise<number> {
  const live = process.argv.includes("--live");
  const goldenSet = loadGoldenSet(FIXTURE_PATH);

  console.log("Golden set:", FIXTURE_PATH);
  console.log(
    `Cases: ${goldenSet.cases.length} (${goldenSet.cases.filter((c) => c.expectedOutcome === "resolvable").length} resolvable, ` +
      `${goldenSet.cases.filter((c) => c.expectedOutcome === "unresolvable").length} unresolvable)`,
  );

  const summary = runGoldenSet(goldenSet);
  console.log("\nDeterministic offline evaluation (heuristic-rules-v1):");
  for (const result of summary.results) {
    const mark = result.passed ? "PASS" : "FAIL";
    console.log(
      `  [${mark}] ${result.id} (${result.category}) expected=${result.expectedOutcome} actual=${result.actualOutcome}`,
    );
    for (const failure of result.failures) {
      console.log(`         - ${failure}`);
    }
  }
  console.log(`\nDeterministic result: ${summary.passed}/${summary.total} passed.`);

  let liveFailures = 0;
  if (live) {
    const config = loadLlmConfig();
    if (config.mode !== "llm") {
      console.log(
        "\nLIVE EVALUATION SKIPPED: no LLM_API_KEY is configured (or LLM_PROVIDER=heuristic). " +
          "This run does not claim any live-model result.",
      );
    } else {
      console.log(
        `\nLive evaluation against \`${config.model}\` at ${config.baseUrl} ` +
          `(timeout ${config.timeoutMs} ms, max attempts ${config.maxAttempts}):`,
      );
      const provider = createProviderFromConfig(config);
      for (const goldenCase of goldenSet.cases) {
        try {
          const result = await provider.generate(
            { headline: goldenCase.headline, articleSnippet: goldenCase.articleSnippet },
            {},
          );
          const matches = result.output.outcome === goldenCase.expectedOutcome;
          if (!matches) liveFailures += 1;
          console.log(
            `  [${matches ? "PASS" : "FAIL"}] ${goldenCase.id} expected=${goldenCase.expectedOutcome} actual=${result.output.outcome} requests=${result.requests}`,
          );
        } catch (error) {
          liveFailures += 1;
          const message =
            error instanceof MarketProviderError
              ? `${error.code}: ${error.message}`
              : "unexpected provider error";
          console.log(`  [ERROR] ${goldenCase.id} ${message}`);
        }
      }
      console.log(`\nLive result: ${goldenSet.cases.length - liveFailures}/${goldenSet.cases.length} matched.`);
    }
  }

  return summary.failed > 0 || liveFailures > 0 ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error("Golden evaluation crashed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
