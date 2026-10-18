import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      ".trash-node-modules/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      ".data/**",
      "next-env.d.ts",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
];

export default config;
