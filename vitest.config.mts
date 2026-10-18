import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts", "tests/golden/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/.next/**",
      "**/.trash-node-modules/**",
      "tests/e2e/**",
    ],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
