import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  poweredByHeader: false,
  // Pin the tracing root to this repository so builds are deterministic even
  // when a parent directory happens to contain another lockfile.
  outputFileTracingRoot: path.join(import.meta.dirname),
};

export default nextConfig;
