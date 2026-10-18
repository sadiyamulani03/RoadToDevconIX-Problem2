import type {
  ApiErrorInfo,
  ApiResult,
  DraftResponse,
  EditableMarket,
  MarketResponse,
  MarketsResponse,
  RuntimeConfig,
} from "./types";

async function request<T>(
  path: string,
  init: RequestInit,
  editorToken: string,
): Promise<ApiResult<T>> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (editorToken.trim() !== "") {
    headers.set("x-editor-token", editorToken.trim());
  }

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch {
    return {
      ok: false,
      status: 0,
      error: {
        code: "network_error",
        message: "The application server could not be reached. Check that it is running and retry.",
        retryable: true,
      },
    };
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const serverError =
      payload !== null && typeof payload === "object" && "error" in payload
        ? (payload as { error?: Partial<ApiErrorInfo> }).error
        : undefined;
    return {
      ok: false,
      status: response.status,
      error: {
        code: serverError?.code ?? "unexpected_error",
        message:
          serverError?.message ??
          `The request failed with status ${response.status}.`,
        retryable: serverError?.retryable ?? response.status >= 500,
        details: serverError?.details,
      },
    };
  }

  return { ok: true, data: payload as T };
}

export function fetchRuntimeConfig(editorToken: string): Promise<ApiResult<RuntimeConfig>> {
  return request<RuntimeConfig>("/api/config", { method: "GET", cache: "no-store" }, editorToken);
}

export function requestDraft(
  input: { headline: string; articleSnippet: string | null },
  editorToken: string,
): Promise<ApiResult<DraftResponse>> {
  return request<DraftResponse>(
    "/api/draft",
    { method: "POST", body: JSON.stringify(input) },
    editorToken,
  );
}

export function listMarkets(editorToken: string): Promise<ApiResult<MarketsResponse>> {
  return request<MarketsResponse>("/api/markets", { method: "GET", cache: "no-store" }, editorToken);
}

export function getMarket(id: string, editorToken: string): Promise<ApiResult<MarketResponse>> {
  return request<MarketResponse>(
    `/api/markets/${encodeURIComponent(id)}`,
    { method: "GET", cache: "no-store" },
    editorToken,
  );
}

export function updateMarket(
  id: string,
  market: EditableMarket,
  editorToken: string,
): Promise<ApiResult<MarketResponse>> {
  return request<MarketResponse>(
    `/api/markets/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify({ market }) },
    editorToken,
  );
}

export function approveMarket(id: string, editorToken: string): Promise<ApiResult<MarketResponse>> {
  return request<MarketResponse>(
    `/api/markets/${encodeURIComponent(id)}/approve`,
    { method: "POST", body: JSON.stringify({ confirm: true }) },
    editorToken,
  );
}

export function discardMarket(id: string, editorToken: string): Promise<ApiResult<MarketResponse>> {
  return request<MarketResponse>(
    `/api/markets/${encodeURIComponent(id)}/discard`,
    { method: "POST", body: JSON.stringify({ confirm: true }) },
    editorToken,
  );
}
