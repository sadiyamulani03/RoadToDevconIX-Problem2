export type MarketProviderErrorCode =
  | "timeout"
  | "network"
  | "rate_limited"
  | "server_error"
  | "auth_error"
  | "invalid_request"
  | "invalid_output";

/**
 * Controlled generation failure surfaced to the editor. The message is
 * always safe to display: it never contains provider payloads, headers or
 * credentials.
 */
export class MarketProviderError extends Error {
  readonly code: MarketProviderErrorCode;
  readonly retryable: boolean;
  readonly attempts: number;

  constructor(
    message: string,
    code: MarketProviderErrorCode,
    retryable: boolean,
    attempts: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "MarketProviderError";
    this.code = code;
    this.retryable = retryable;
    this.attempts = attempts;
  }
}
