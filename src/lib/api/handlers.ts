import { requireEditorAccess } from "../api-auth";
import {
  ConfirmRequestSchema,
  DraftRequestSchema,
  UpdateDraftRequestSchema,
} from "../domain/schema";
import { handleRouteError, jsonResponse, readJsonBody } from "../http";
import type { EnvLike } from "../llm/config";
import type { MarketService } from "../market-service";

/**
 * Framework-agnostic route handlers. Next.js route files are thin wrappers
 * around these, which keeps the whole HTTP surface unit-testable with plain
 * `Request` objects and an injected service (no live server, no live model).
 */

export interface HandlerDependencies {
  getService: () => MarketService;
  env?: EnvLike;
}

export function createGenerateDraftHandler(deps: HandlerDependencies) {
  return async function POST(request: Request): Promise<Response> {
    try {
      requireEditorAccess(request, deps.env);
      const body = await readJsonBody(request);
      const input = DraftRequestSchema.parse(body);
      const result = await deps.getService().generateDraft(input);

      if (result.kind === "unresolvable") {
        return jsonResponse(
          {
            outcome: "unresolvable",
            rejection: result.rejection,
            generation: result.generation,
          },
          200,
        );
      }

      return jsonResponse(
        {
          outcome: "resolvable",
          market: result.record,
          generation: result.generation,
        },
        201,
      );
    } catch (error) {
      return handleRouteError(error);
    }
  };
}

/**
 * Read-only runtime configuration for the UI: which generation mode is
 * active and whether sources are network-verified. Contains no secrets.
 */
export function createConfigHandler(deps: HandlerDependencies) {
  return async function GET(): Promise<Response> {
    try {
      const info = deps.getService().providerInfo;
      return jsonResponse({
        provider: info,
        sourceVerification: "syntactic-only",
        accessControl: {
          editorTokenRequired: Boolean((deps.env ?? process.env).EDITOR_ACCESS_TOKEN?.trim()),
        },
      });
    } catch (error) {
      return handleRouteError(error);
    }
  };
}

export function createListMarketsHandler(deps: HandlerDependencies) {
  return async function GET(): Promise<Response> {
    try {
      const markets = deps.getService().list();
      return jsonResponse({ markets });
    } catch (error) {
      return handleRouteError(error);
    }
  };
}

export function createGetMarketHandler(deps: HandlerDependencies) {
  return async function GET(_request: Request, id: string): Promise<Response> {
    try {
      const market = deps.getService().get(id);
      return jsonResponse({ market });
    } catch (error) {
      return handleRouteError(error);
    }
  };
}

export function createUpdateMarketHandler(deps: HandlerDependencies) {
  return async function PATCH(request: Request, id: string): Promise<Response> {
    try {
      requireEditorAccess(request, deps.env);
      const body = await readJsonBody(request);
      const input = UpdateDraftRequestSchema.parse(body);
      const market = deps.getService().updateDraft(id, input.market);
      return jsonResponse({ market });
    } catch (error) {
      return handleRouteError(error);
    }
  };
}

export function createApproveMarketHandler(deps: HandlerDependencies) {
  return async function POST(request: Request, id: string): Promise<Response> {
    try {
      requireEditorAccess(request, deps.env);
      const body = await readJsonBody(request);
      ConfirmRequestSchema.parse(body);
      const market = deps.getService().approve(id);
      return jsonResponse({ market });
    } catch (error) {
      return handleRouteError(error);
    }
  };
}

export function createDiscardMarketHandler(deps: HandlerDependencies) {
  return async function POST(request: Request, id: string): Promise<Response> {
    try {
      requireEditorAccess(request, deps.env);
      const body = await readJsonBody(request);
      ConfirmRequestSchema.parse(body);
      const market = deps.getService().discard(id);
      return jsonResponse({ market });
    } catch (error) {
      return handleRouteError(error);
    }
  };
}
