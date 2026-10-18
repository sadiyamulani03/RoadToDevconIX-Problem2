/**
 * Tracked-file secret scan. Exits non-zero when a credential-shaped value is
 * found in any file that `git add .` would commit. Matched values are never
 * printed — only the file, line and pattern label.
 *
 *   npm run scan:secrets
 */
import { scanRepository } from "./secret-scan";

const root = process.cwd();
const report = scanRepository(root);

console.log(`Secret scan root: ${report.scanRoot}`);
console.log(`Candidate files scanned (tracked + untracked-not-ignored): ${report.filesScanned}`);

let failed = false;

if (report.envFilesWouldBeCommitted.length > 0) {
  failed = true;
  console.error("\nEnvironment files that would be committed:");
  for (const file of report.envFilesWouldBeCommitted) {
    console.error(`  [env_file_committed] ${file}`);
  }
}

if (report.envExampleViolations.length > 0) {
  failed = true;
  console.error("\n.env.example is supposed to contain placeholders only:");
  for (const violation of report.envExampleViolations) {
    console.error(`  [env_example_value] ${violation}`);
  }
}

if (report.findings.length > 0) {
  failed = true;
  console.error("\nPotential credentials detected (values intentionally not printed):");
  for (const finding of report.findings) {
    console.error(`  [${finding.label}] ${finding.file}:${finding.line}`);
  }
}

if (!failed) {
  console.log("No credentials detected in candidate files. .env.example contains placeholders only.");
  console.log(
    "Note: this scans the working tree. Git-history exposure must be checked separately with a history-aware scanner.",
  );
} else {
  console.error("\nSecret scan FAILED. Remove the credential, rotate it, and do not commit it.");
}

process.exitCode = failed ? 1 : 0;
