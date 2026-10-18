import { createHash, timingSafeEqual } from "node:crypto";
import { HttpError } from "./http";
import type { EnvLike } from "./llm/config";

/**
 * Access model:
 *
 *  - If EDITOR_ACCESS_TOKEN is unset, the app uses the documented local-demo
 *    model: every request is allowed and the operator is responsible for
 *    running the app on a trusted machine only.
 *  - If EDITOR_ACCESS_TOKEN is set, every mutating endpoint requires an
 *    `x-editor-token` header whose value matches. This is a bearer-style
 *    shared secret for single-editor deployments, not a multi-user identity
 *    system; that limitation is documented in the README.
 *
 * The comparison hashes both values first so it is constant-time regardless
 * of length and never leaks the token through comparison timing.
 */

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function requireEditorAccess(
  request: Request,
  env: EnvLike = process.env,
): void {
  const expected = env.EDITOR_ACCESS_TOKEN?.trim();
  if (!expected) return;

  const provided = request.headers.get("x-editor-token")?.trim() ?? "";
  if (provided === "" || !timingSafeEqual(digest(provided), digest(expected))) {
    throw new HttpError(
      401,
      "unauthorized_editor",
      "A valid editor access token is required for this action.",
    );
  }
}
