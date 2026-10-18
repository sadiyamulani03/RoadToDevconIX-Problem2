import type { SemanticIssue } from "@/lib/domain/schema";

interface ValidationIssuesProps {
  issues: SemanticIssue[];
  heading?: string;
}

export default function ValidationIssues({ issues, heading }: ValidationIssuesProps) {
  if (issues.length === 0) {
    return (
      <p className="card-subtle" data-testid="validation-clean">
        No semantic validation issues found. Deadline, question, source and settlement rules passed the
        server-side checks.
      </p>
    );
  }

  const ordered = [
    ...issues.filter((issue) => issue.severity === "error"),
    ...issues.filter((issue) => issue.severity === "warning"),
  ];

  return (
    <div>
      {heading ? <h3 style={{ fontSize: 15, marginBottom: 8 }}>{heading}</h3> : null}
      <ul className="issue-list" data-testid="validation-issues">
        {ordered.map((issue, index) => (
          <li
            key={`${issue.code}-${issue.field}-${index}`}
            className={`issue issue-${issue.severity}`}
          >
            <span className="issue-meta">
              {issue.severity === "error" ? "ERROR" : "WARNING"} · {issue.field} · {issue.code}
            </span>
            {issue.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
