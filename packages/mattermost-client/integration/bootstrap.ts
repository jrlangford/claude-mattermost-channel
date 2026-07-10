// Provisions a FRESH Mattermost test server over plain REST — no mmctl, no
// docker exec, so it runs anywhere the server is reachable. Relies on
// Mattermost's "first user created becomes system admin" behavior; the
// compose stack gives us a fresh DB every run. Every step tolerates
// already-exists so a kept-alive stack (KEEP=1) can be re-run.

export type ITContext = {
  url: string;
  adminToken: string;
  botToken: string;
  botUserId: string;
  humanToken: string;
  humanUserId: string;
  teamId: string;
  townChannelId: string;
  dmChannelId: string;
};

const PW = "ITtestpass123!";

type Json = Record<string, any>;

async function api(
  url: string,
  path: string,
  init?: RequestInit & { token?: string }
): Promise<Response> {
  return fetch(`${url}/api/v4${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.token ? { Authorization: `Bearer ${init.token}` } : {}),
      ...init?.headers,
    },
  });
}

async function must(res: Response, what: string): Promise<Json> {
  if (!res.ok) {
    throw new Error(`bootstrap: ${what} failed (${res.status}): ${await res.text()}`);
  }
  return res.json() as Promise<Json>;
}

/** ok → json; already-exists (4xx) → null so callers can fall back to GET. */
async function maybe(res: Response): Promise<Json | null> {
  if (res.ok) return res.json() as Promise<Json>;
  return null;
}

export async function waitForServer(url: string, timeoutMs = 240_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await api(url, "/system/ping");
      if (res.ok) return;
      lastErr = new Error(`ping ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`bootstrap: mattermost not ready after ${timeoutMs}ms: ${lastErr}`);
}

async function login(url: string, loginId: string): Promise<{ token: string; id: string }> {
  const res = await api(url, "/users/login", {
    method: "POST",
    body: JSON.stringify({ login_id: loginId, password: PW }),
  });
  const user = await must(res, `login as ${loginId}`);
  const token = res.headers.get("Token");
  if (!token) throw new Error(`bootstrap: login as ${loginId} returned no session token`);
  return { token, id: user.id };
}

export async function bootstrap(url: string): Promise<ITContext> {
  await waitForServer(url);

  // 1. Admin — the FIRST user created on a fresh server is system admin.
  await maybe(
    await api(url, "/users", {
      method: "POST",
      body: JSON.stringify({ email: "itadmin@example.com", username: "itadmin", password: PW }),
    })
  );
  const admin = await login(url, "itadmin");

  // 2. Team.
  const team =
    (await maybe(
      await api(url, "/teams", {
        method: "POST",
        token: admin.token,
        body: JSON.stringify({ name: "itteam", display_name: "IT Team", type: "O" }),
      })
    )) ?? (await must(await api(url, "/teams/name/itteam", { token: admin.token }), "get team"));

  // 3. Human user (the "correspondent" actor) — session token, not PAT, so
  //    no extra permissions are needed.
  await maybe(
    await api(url, "/users", {
      method: "POST",
      token: admin.token,
      body: JSON.stringify({ email: "ithuman@example.com", username: "ithuman", password: PW }),
    })
  );
  const human = await login(url, "ithuman");

  // 4. Bot + personal access token (bots cannot log in — PAT is the real
  //    auth path the plugin uses, so the tests exercise exactly that).
  const bot =
    (await maybe(
      await api(url, "/bots", {
        method: "POST",
        token: admin.token,
        body: JSON.stringify({ username: "itbot", display_name: "IT Bot" }),
      })
    )) ??
    (await must(await api(url, "/users/username/itbot", { token: admin.token }), "get bot user"));
  const botUserId: string = bot.user_id ?? bot.id;
  const pat = await must(
    await api(url, `/users/${botUserId}/tokens`, {
      method: "POST",
      token: admin.token,
      body: JSON.stringify({ description: "integration tests" }),
    }),
    "create bot token"
  );

  // 5. Memberships: both actors on the team, both in a public channel.
  for (const userId of [botUserId, human.id]) {
    await maybe(
      await api(url, `/teams/${team.id}/members`, {
        method: "POST",
        token: admin.token,
        body: JSON.stringify({ team_id: team.id, user_id: userId }),
      })
    );
  }
  const town =
    (await maybe(
      await api(url, "/channels", {
        method: "POST",
        token: admin.token,
        body: JSON.stringify({
          team_id: team.id,
          name: "it-town",
          display_name: "IT Town",
          type: "O",
        }),
      })
    )) ??
    (await must(
      await api(url, `/teams/${team.id}/channels/name/it-town`, { token: admin.token }),
      "get town channel"
    ));
  for (const userId of [botUserId, human.id]) {
    await maybe(
      await api(url, `/channels/${town.id}/members`, {
        method: "POST",
        token: admin.token,
        body: JSON.stringify({ user_id: userId }),
      })
    );
  }

  // 6. The DM channel between human and bot.
  const dm = await must(
    await api(url, "/channels/direct", {
      method: "POST",
      token: human.token,
      body: JSON.stringify([human.id, botUserId]),
    }),
    "create DM channel"
  );

  return {
    url,
    adminToken: admin.token,
    botToken: pat.token,
    botUserId,
    humanToken: human.token,
    humanUserId: human.id,
    teamId: team.id,
    townChannelId: town.id,
    dmChannelId: dm.id,
  };
}
