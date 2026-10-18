import { describe, expect, test } from "vitest";
import { requireEditorAccess } from "../../src/lib/api-auth";
import { HttpError } from "../../src/lib/http";

function request(headers: Record<string, string> = {}): Request {
  return new Request("http://app.test/api/markets", { method: "POST", headers });
}

describe("editor access control", () => {
  test("allows every request when no editor token is configured (local demo)", () => {
    expect(() => requireEditorAccess(request(), {})).not.toThrow();
  });

  test("requires the token header when a token is configured", () => {
    const env = { EDITOR_ACCESS_TOKEN: "test-editor-token" };
    let error: unknown;
    try {
      requireEditorAccess(request(), env);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(401);
    expect((error as HttpError).code).toBe("unauthorized_editor");
  });

  test("rejects a wrong token without leaking which part matched", () => {
    const env = { EDITOR_ACCESS_TOKEN: "test-editor-token" };
    expect(() => requireEditorAccess(request({ "x-editor-token": "wrong" }), env)).toThrow(
      HttpError,
    );
  });

  test("accepts the exact token", () => {
    const env = { EDITOR_ACCESS_TOKEN: "test-editor-token" };
    expect(() =>
      requireEditorAccess(request({ "x-editor-token": "test-editor-token" }), env),
    ).not.toThrow();
  });

  test("treats a blank configured token as unset", () => {
    expect(() => requireEditorAccess(request(), { EDITOR_ACCESS_TOKEN: "   " })).not.toThrow();
  });
});
