// Checked Mattermost response handling (beads-4hn89).
//
// MM error responses are valid JSON whose `id` field is the error string —
// e.g. {"id":"api.context.permissions.app_error","message":"...","status_code":403}.
// Parsing that body as the requested object produced success-shaped failures:
// the reply tool returned `sent (id: api.context.permissions.app_error)` for a
// post the server REJECTED, and callers believed the message landed (observed
// live 2026-08-05: themis's #prs post; earlier the same week: a react against
// a corrupted chat_id). Every JSON-returning MM call must go through here so
// a rejected request is a thrown error, not a plausible-looking object.

/** Parse a Mattermost API response, throwing loudly on HTTP failure with the
 *  server's error id + message in the thrown text. */
export async function mmJson<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    throw new Error(`${what} failed: ${await describeError(res)}`);
  }
  return (await res.json()) as T;
}

/** Assert success for calls whose body we don't need (e.g. channel view). */
export async function mmOk(res: Response, what: string): Promise<void> {
  if (!res.ok) {
    throw new Error(`${what} failed: ${await describeError(res)}`);
  }
}

async function describeError(res: Response): Promise<string> {
  let detail = "";
  try {
    const err = (await res.json()) as { id?: string; message?: string };
    detail = [err.id, err.message].filter(Boolean).join(" — ");
  } catch {
    // Non-JSON error body (proxy page, empty) — status alone.
  }
  return `HTTP ${res.status}${detail ? ` (${detail})` : ""}`;
}
