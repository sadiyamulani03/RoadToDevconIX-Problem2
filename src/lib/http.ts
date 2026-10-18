import { ZodError } from "zod";
import { MarketStoreError } from "./db";
import { MarketProviderError } from "./llm/errors";
import { MarketServiceError } from "./market-service";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: unknown;
  };
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  options: { retryable?: boolean; details?: unknown } = {},
): Response {
  const body: ApiErrorBody = {
    error: {
      code,
      message,
      retryable: options.retryable ?? false,
      ...(options.details === undefined ? {} : { details: options.details }),
    },
  };
  return jsonResponse(body, status);
}

export const MAX_REQUEST_BYTES = 64 * 1024;

export async function readJsonBody(request: Request): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const size = Number.parseInt(contentLength, 10);
    if (Number.isFinite(size) && size > MAX_REQUEST_BYTES) {
      throw new HttpError(413, "request_too_large", "The request body is too large.");
    }
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new HttpError(400, "invalid_request_body", "The request body could not be read.");
  }
  if (text.length > MAX_REQUEST_BYTES) {
    throw new HttpError(413, "request_too_large", "The request body is too large.");
  }
  if (text.trim() === "") {
    throw new HttpError(400, "empty_request_body", "A JSON request body is required.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "invalid_json", "The request body is not valid JSON.");
  }
}

const PROVIDER_ERROR_MAP: Record<
  MarketProviderError["code"],
  { status: number; code: string; message: string; retryable: boolean }
> = {
  timeout: {
    status: 504,
    code: "llm_timeout",
    message:
      "The model request exceeded its timeout and was stopped. No draft was created. You can retry.",
    retryable: true,
  },
  rate_limited: {
    status: 503,
    code: "llm_rate_limited",
    message: "The model provider is rate-limiting requests. Wait a moment and retry.",
    retryable: true,
  },
  server_error: {
    status: 502,
    code: "llm_unavailable",
    message: "The model provider returned a server error. Retry, or switch to the heuristic fallback.",
    retryable: true,
  },
  network: {
    status: 502,
    code: "llm_network_error",
    message: "The model provider could not be reached. Check the network or base URL and retry.",
    retryable: true,
  },
  auth_error: {
    status: 502,
    code: "llm_auth_error",
    message:
      "The configured model credentials were rejected. An administrator must check LLM_API_KEY on the server.",
    retryable: false,
  },
  invalid_request: {
    status: 502,
    code: "llm_invalid_request",
    message:
      "The model provider rejected the request format. Check LLM_MODEL and LLM_STRUCTURED_OUTPUT on the server.",
    retryable: false,
  },
  invalid_output: {
    status: 502,
    code: "llm_invalid_response",
    message:
      "The model did not return a response matching the required market schema within the allowed attempts. No draft was created.",
    retryable: true,
  },
};

/**
 * Maps any thrown error to a controlled JSON response. Never includes
 * provider payloads, request headers or environment values.
 */
export function handleRouteError(error: unknown): Response {
  if (error instanceof HttpError) {
    return errorResponse(error.status, error.code, error.message, { details: error.details });
  }
  if (error instanceof ZodError) {
    return errorResponse(400, "invalid_request", "The request body failed validation.", {
      details: error.issues.slice(0, 6).map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    });
  }
  if (error instanceof MarketServiceError) {
    return errorResponse(error.status, error.code, error.message, { details: error.details });
  }
  if (error instanceof MarketProviderError) {
    const mapped = PROVIDER_ERROR_MAP[error.code];
    return errorResponse(mapped.status, mapped.code, mapped.message, {
      retryable: mapped.retryable,
      details: { attempts: error.attempts },
    });
  }
  if (error instanceof MarketStoreError) {
    console.error("[headline-to-market] storage error:", error.message);
    return errorResponse(500, "storage_error", "The local market store could not complete the operation.");
  }

  const message = error instanceof Error ? error.message : "Unknown error";
  console.error("[headline-to-market] unexpected error:", message);
  return errorResponse(500, "internal_error", "An unexpected server error occurred.");
}
