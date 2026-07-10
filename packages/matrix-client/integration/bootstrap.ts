// Provisions a FRESH Synapse test server over plain REST — open registration
// (enabled in the compose config) means no admin API is needed. Every step
// tolerates already-exists so a kept-alive stack (KEEP=1) can be re-run.

export type ITContext = {
  url: string;
  botToken: string;
  botUserId: string;
  humanToken: string;
  humanUserId: string;
  dmRoomId: string;
  townRoomId: string;
};

const PW = "ITtestpass123!";

async function api(
  url: string,
  path: string,
  init?: RequestInit & { token?: string }
): Promise<Response> {
  return fetch(`${url}/_matrix/client${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.token ? { Authorization: `Bearer ${init.token}` } : {}),
      ...init?.headers,
    },
  });
}

async function must(res: Response, what: string): Promise<Record<string, any>> {
  if (!res.ok) {
    throw new Error(`bootstrap: ${what} failed (${res.status}): ${await res.text()}`);
  }
  return res.json() as Promise<Record<string, any>>;
}

export async function waitForServer(url: string, timeoutMs = 240_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
      lastErr = new Error(`health ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`bootstrap: synapse not ready after ${timeoutMs}ms: ${lastErr}`);
}

/** Register (dummy auth), falling back to login when the user exists. */
async function registerOrLogin(
  url: string,
  username: string
): Promise<{ userId: string; token: string }> {
  let res = await api(url, "/v3/register", {
    method: "POST",
    body: JSON.stringify({ username, password: PW, auth: { type: "m.login.dummy" } }),
  });
  if (res.status === 401) {
    // UIA session dance: retry the dummy stage with the offered session.
    const flows = (await res.json()) as { session?: string };
    res = await api(url, "/v3/register", {
      method: "POST",
      body: JSON.stringify({
        username,
        password: PW,
        auth: { type: "m.login.dummy", session: flows.session },
      }),
    });
  }
  if (res.ok) {
    const body = (await res.json()) as { user_id: string; access_token: string };
    return { userId: body.user_id, token: body.access_token };
  }
  const err = (await res.json().catch(() => ({}))) as { errcode?: string };
  if (err.errcode !== "M_USER_IN_USE") {
    throw new Error(`bootstrap: register ${username} failed (${res.status}): ${JSON.stringify(err)}`);
  }
  const login = await must(
    await api(url, "/v3/login", {
      method: "POST",
      body: JSON.stringify({
        type: "m.login.password",
        identifier: { type: "m.id.user", user: username },
        password: PW,
      }),
    }),
    `login as ${username}`
  );
  return { userId: login.user_id, token: login.access_token };
}

export async function bootstrap(url: string): Promise<ITContext> {
  await waitForServer(url);

  const bot = await registerOrLogin(url, "itbot");
  const human = await registerOrLogin(url, "ithuman");

  // DM room: human creates + invites the bot, bot joins. is_direct makes
  // clients (and our adapter, via m.direct below) treat it as a DM.
  const dm = await must(
    await api(url, "/v3/createRoom", {
      method: "POST",
      token: human.token,
      body: JSON.stringify({
        is_direct: true,
        invite: [bot.userId],
        preset: "trusted_private_chat",
      }),
    }),
    "create DM room"
  );
  await must(
    await api(url, `/v3/join/${encodeURIComponent(dm.room_id)}`, {
      method: "POST",
      token: bot.token,
      body: "{}",
    }),
    "bot join DM"
  );
  // The m.direct account-data map is how the BOT knows the room is a DM —
  // this is the client convention the adapter's kind detection reads.
  await must(
    await api(url, `/v3/user/${encodeURIComponent(bot.userId)}/account_data/m.direct`, {
      method: "PUT",
      token: bot.token,
      body: JSON.stringify({ [human.userId]: [dm.room_id] }),
    }),
    "set m.direct"
  );

  // Public room, both members.
  const town = await must(
    await api(url, "/v3/createRoom", {
      method: "POST",
      token: human.token,
      body: JSON.stringify({ preset: "public_chat", name: "IT Town" }),
    }),
    "create town room"
  );
  await must(
    await api(url, `/v3/join/${encodeURIComponent(town.room_id)}`, {
      method: "POST",
      token: bot.token,
      body: "{}",
    }),
    "bot join town"
  );

  return {
    url,
    botToken: bot.token,
    botUserId: bot.userId,
    humanToken: human.token,
    humanUserId: human.userId,
    dmRoomId: dm.room_id,
    townRoomId: town.room_id,
  };
}
