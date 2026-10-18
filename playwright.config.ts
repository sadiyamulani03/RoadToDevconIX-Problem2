import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end smoke configuration. Runs against a production build on port
 * 3100 with the offline heuristic provider (no API key required) and an
 * isolated SQLite database.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npx next start -p 3100",
    url: "http://127.0.0.1:3100/api/config",
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      LLM_PROVIDER: "heuristic",
      DATABASE_PATH: "./.data/e2e-markets.db",
    },
  },
});
