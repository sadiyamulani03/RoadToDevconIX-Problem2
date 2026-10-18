import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

/**
 * Secret scanner used by `npm run scan:secrets` and by the acceptance audit.
 *
 * Design rules:
 *  - never print or return the matched secret value, only file, line and label;
 *  - scan tracked files plus untracked files that are not git-ignored (what
 *    `git add .` would actually commit);
 *  - skip binaries, generated output and dependency directories defensively;
 *  - verify that `.env.example` contains placeholders only.
 */

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".trash-node-modules",
  ".data",
  "coverage",
  "playwright-report",
  "test-results",
]);

const SKIP_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".webp",
  ".pdf",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".map",
  ".db",
  ".sqlite",
  ".tsbuildinfo",
]);

const MAX_FILE_BYTES = 1_000_000;

interface Pattern {
  label: string;
  regex: RegExp;
}

const PATTERNS: Pattern[] = [
  { label: "openai_api_key", regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { label: "github_token", regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
  { label: "github_fine_grained_token", regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { label: "aws_access_key", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: "google_api_key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: "slack_token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { label: "stripe_secret_key", regex: /\bsk_live_[0-9a-zA-Z]{24,}\b/g },
  { label: "private_key_block", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { label: "bearer_token_literal", regex: /["'`]Bearer\s+[A-Za-z0-9\-._~+/]{20,}={0,3}["'`]/g },
  {
    label: "assigned_secret",
    regex:
      /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\b\s*[:=]\s*["'`]([A-Za-z0-9\-_./+=]{16,})["'`]/gi,
  },
];

const PLACEHOLDER_MARKERS = [
  "your",
  "example",
  "placeholder",
  "changeme",
  "change-me",
  "replace",
  "xxx",
  "dummy",
  "fake",
  "test",
  "sample",
  "not-real",
  "redacted",
  "todo",
];

/** Env keys whose values must be placeholders (or empty) in .env.example. */
const SENSITIVE_ENV_KEY = /(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i;

export interface SecretFinding {
  file: string;
  line: number;
  label: string;
}

export interface ScanReport {
  filesScanned: number;
  findings: SecretFinding[];
  envExampleViolations: string[];
  envFilesWouldBeCommitted: string[];
  scanRoot: string;
}

function looksLikePlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  return PLACEHOLDER_MARKERS.some((marker) => lower.includes(marker)) || value.trim() === "";
}

export function listCandidateFiles(root: string): string[] {
  let output = "";
  try {
    output = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: root, encoding: "utf8" },
    );
  } catch {
    output = "";
  }

  const files = output
    .split("\0")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (files.length === 0) return [];

  return files
    .filter((entry) => {
      const segments = entry.split("/");
      if (segments.some((segment) => SKIP_DIRS.has(segment))) return false;
      const dot = entry.lastIndexOf(".");
      if (dot >= 0 && SKIP_EXTENSIONS.has(entry.slice(dot).toLowerCase())) return false;
      return true;
    })
    .filter((entry) => existsSync(`${root}/${entry}`));
}

export function scanContent(file: string, content: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const pattern of PATTERNS) {
      pattern.regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.regex.exec(line)) !== null) {
        const candidate = match[1] ?? match[0];
        if (pattern.label === "assigned_secret" && looksLikePlaceholder(candidate)) {
          continue;
        }
        findings.push({ file, line: index + 1, label: pattern.label });
      }
    }
  });
  return findings;
}

export function scanRepository(root: string): ScanReport {
  const files = listCandidateFiles(root);
  const findings: SecretFinding[] = [];
  const envExampleViolations: string[] = [];
  const envFilesWouldBeCommitted: string[] = [];

  for (const file of files) {
    const absolute = `${root}/${file}`;

    if (/(^|\/)\.env(\..*)?$/.test(file) && file !== ".env.example") {
      envFilesWouldBeCommitted.push(file);
    }

    let size = 0;
    try {
      size = statSync(absolute).size;
    } catch {
      continue;
    }
    if (size > MAX_FILE_BYTES) continue;

    let content: string;
    try {
      content = readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    if (content.includes("\u0000")) continue;

    if (file === ".env.example") {
      content.split(/\r?\n/).forEach((line, index) => {
        const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
        if (!match) return;
        if (!SENSITIVE_ENV_KEY.test(match[1])) return;
        const value = match[2].trim();
        if (value === "") return;
        if (looksLikePlaceholder(value)) return;
        envExampleViolations.push(
          `${file}:${index + 1} ${match[1]} has a non-placeholder value`,
        );
      });
    }

    findings.push(...scanContent(file, content));
  }

  return {
    filesScanned: files.length,
    findings,
    envExampleViolations,
    envFilesWouldBeCommitted,
    scanRoot: root,
  };
}

export { PATTERNS, SKIP_DIRS };
