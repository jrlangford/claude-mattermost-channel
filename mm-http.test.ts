// Regression tests for beads-4hn89: MM error bodies must never be handed to
// callers as if they were the requested object. The observed defect: a 403
// on POST /posts returned {"id":"api.context.permissions.app_error",...};
// mmPost parsed it as a post, `post.id` was truthy, and the reply tool
// reported `sent (id: api.context.permissions.app_error)` — false success.
// These tests fail against the old behavior (raw res.json() passthrough).

import { describe, test, expect } from "bun:test";
import { mmJson, mmOk } from "./mm-http";

const PERMISSION_ERROR = {
  id: "api.context.permissions.app_error",
  message: "You do not have the appropriate permissions.",
  status_code: 403,
};

function errorResponse(body: unknown = PERMISSION_ERROR, status = 403): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("mmJson", () => {
  test("REGRESSION 4hn89: permission-denied post throws instead of returning the error body as a post", async () => {
    await expect(mmJson<{ id: string }>(errorResponse(), "reply post")).rejects.toThrow(
      /reply post failed: HTTP 403 \(api\.context\.permissions\.app_error/,
    );
    // The critical property: the error id can never surface as a "post id".
    try {
      await mmJson<{ id: string }>(errorResponse(), "reply post");
      expect.unreachable("must throw");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
    }
  });

  test("success body passes through", async () => {
    const post = await mmJson<{ id: string }>(
      new Response(JSON.stringify({ id: "realpostid123" }), { status: 201 }),
      "reply post",
    );
    expect(post.id).toBe("realpostid123");
  });

  test("non-JSON error body still throws with status", async () => {
    const res = new Response("<html>gateway timeout</html>", { status: 504 });
    await expect(mmJson(res, "fetch")).rejects.toThrow(/fetch failed: HTTP 504/);
  });

  test("server message is carried into the thrown error", async () => {
    await expect(mmJson(errorResponse(), "react")).rejects.toThrow(
      /You do not have the appropriate permissions/,
    );
  });
});

describe("mmOk", () => {
  test("view failure throws (was silently swallowed pre-fix — retry loop never saw HTTP errors)", async () => {
    await expect(mmOk(errorResponse(), "channel view")).rejects.toThrow(/channel view failed/);
  });

  test("success resolves", async () => {
    await expect(mmOk(new Response("", { status: 200 }), "channel view")).resolves.toBeUndefined();
  });
});
