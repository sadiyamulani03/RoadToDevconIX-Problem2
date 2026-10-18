"use client";

import { MAX_ARTICLE_SNIPPET_LENGTH, MAX_HEADLINE_LENGTH } from "@/lib/domain/constants";

export const EXAMPLE_RESOLVABLE = {
  headline: "Will the RBI cut the repo rate at its December 2026 monetary policy meeting?",
  articleSnippet:
    "The Reserve Bank of India's Monetary Policy Committee will announce its next policy decision on 5 December 2026. The official press release will be published at https://www.rbi.org.in.",
};

export const EXAMPLE_REJECTION = {
  headline: "Will Bengaluru traffic improve?",
  articleSnippet: "",
};

interface HeadlineFormProps {
  headline: string;
  snippet: string;
  onHeadlineChange: (value: string) => void;
  onSnippetChange: (value: string) => void;
  onGenerate: () => void;
  generating: boolean;
  headlineError: string | null;
}

export default function HeadlineForm({
  headline,
  snippet,
  onHeadlineChange,
  onSnippetChange,
  onGenerate,
  generating,
  headlineError,
}: HeadlineFormProps) {
  const headlineOver = headline.length > MAX_HEADLINE_LENGTH;
  const snippetOver = snippet.length > MAX_ARTICLE_SNIPPET_LENGTH;

  return (
    <section className="card" aria-labelledby="compose-heading">
      <div className="card-header">
        <h2 id="compose-heading">1 · Compose the headline</h2>
        <span className="card-subtle">Headline required · article context optional</span>
      </div>

      <div className="field">
        <label htmlFor="headline-input">News headline</label>
        <textarea
          id="headline-input"
          className="mono"
          value={headline}
          rows={3}
          maxLength={MAX_HEADLINE_LENGTH + 100}
          placeholder="e.g. Will the RBI cut the repo rate at its December 2026 monetary policy meeting?"
          aria-describedby={headlineError ? "headline-error" : "headline-hint"}
          aria-invalid={headlineError ? true : undefined}
          onChange={(event) => onHeadlineChange(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
              event.preventDefault();
              onGenerate();
            }
          }}
        />
        {headlineError ? (
          <span id="headline-error" className="error-text" role="alert">
            {headlineError}
          </span>
        ) : (
          <span id="headline-hint" className="hint">
            Paste the headline exactly as published. Ctrl/⌘ + Enter generates a draft.
          </span>
        )}
        <span className={`counter${headlineOver ? " over" : ""}`}>
          {headline.length} / {MAX_HEADLINE_LENGTH}
        </span>
      </div>

      <div className="field">
        <label htmlFor="snippet-input">Article context (optional)</label>
        <textarea
          id="snippet-input"
          value={snippet}
          rows={5}
          maxLength={MAX_ARTICLE_SNIPPET_LENGTH + 200}
          placeholder="Paste a short excerpt that names dates, authorities or official sources. It is treated as untrusted data."
          aria-describedby="snippet-hint"
          onChange={(event) => onSnippetChange(event.target.value)}
        />
        <span id="snippet-hint" className="hint">
          Names dates and official sources make a fair market much more likely.
        </span>
        <span className={`counter${snippetOver ? " over" : ""}`}>
          {snippet.length} / {MAX_ARTICLE_SNIPPET_LENGTH}
        </span>
      </div>

      <div className="btn-row">
        <button
          type="button"
          className="btn btn-primary"
          onClick={onGenerate}
          disabled={generating}
        >
          {generating ? "Generating draft…" : "Generate draft"}
        </button>
        <button
          type="button"
          className="btn btn-outline"
          onClick={() => {
            onHeadlineChange(EXAMPLE_RESOLVABLE.headline);
            onSnippetChange(EXAMPLE_RESOLVABLE.articleSnippet);
          }}
          disabled={generating}
        >
          Load resolvable example
        </button>
        <button
          type="button"
          className="btn btn-outline"
          onClick={() => {
            onHeadlineChange(EXAMPLE_REJECTION.headline);
            onSnippetChange(EXAMPLE_REJECTION.articleSnippet);
          }}
          disabled={generating}
        >
          Load rejection example
        </button>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-outline"
          onClick={() => {
            onHeadlineChange("");
            onSnippetChange("");
          }}
          disabled={generating || (headline === "" && snippet === "")}
        >
          Clear
        </button>
      </div>
    </section>
  );
}
