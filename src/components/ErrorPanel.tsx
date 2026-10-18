import type { ApiErrorInfo } from "@/lib/client/types";

const TITLES: Record<string, string> = {
  llm_timeout: "Generation timed out",
  llm_invalid_response: "The model returned an unusable response",
  llm_auth_error: "Model credentials were rejected",
  llm_rate_limited: "The model provider is rate limiting",
  llm_unavailable: "The model provider is unavailable",
  llm_network_error: "The model provider could not be reached",
  llm_invalid_request: "The model request was rejected",
  unauthorized_editor: "Editor access token required",
  network_error: "The application server could not be reached",
  storage_error: "Local storage error",
};

interface ErrorPanelProps {
  error: ApiErrorInfo;
  onRetry: () => void;
  showRetry: boolean;
}

export default function ErrorPanel({ error, onRetry, showRetry }: ErrorPanelProps) {
  const title = TITLES[error.code] ?? "Generation failed";

  return (
    <section className="panel panel-error" role="alert" aria-labelledby="error-heading" data-testid="error-panel">
      <h3 id="error-heading">{title}</h3>
      <p data-testid="error-message">{error.message}</p>

      {error.code === "unauthorized_editor" ? (
        <p>
          Enter the editor access token in the field at the top right of the page, then retry. The token
          is held only in this browser tab&apos;s session storage.
        </p>
      ) : null}

      {error.code === "llm_auth_error" ? (
        <p>
          The server&apos;s <code>LLM_API_KEY</code> was rejected by the provider. An administrator must fix
          the environment configuration; retrying will not help.
        </p>
      ) : null}

      {showRetry && error.retryable ? (
        <div className="panel-actions">
          <button type="button" className="btn btn-primary" onClick={onRetry}>
            Retry generation
          </button>
        </div>
      ) : null}

      <p className="provenance">
        Error code: <strong>{error.code}</strong>
        {typeof (error.details as { attempts?: number } | undefined)?.attempts === "number" ? (
          <> · attempts made: {(error.details as { attempts: number }).attempts}</>
        ) : null}
      </p>
    </section>
  );
}
