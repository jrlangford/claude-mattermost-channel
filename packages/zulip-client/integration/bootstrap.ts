// Provisions test context against a seeded Zulip server over plain REST.
// Realm + users must already exist (seed.py via manage.py — Zulip has no
// registration REST API); this exchanges their passwords for API keys and
// sets up the shared channel. Every step tolerates already-exists so a
// kept-alive stack (KEEP=1) can be re-run.

import { dmChannelId } from "../convert.ts";

export type ITContext = {
  url: string;
  botEmail: string;
  botApiKey: string;
  botUserId: string;
  humanEmail: string;
  humanApiKey: string;
  humanUserId: string;
  /** The shared "town" channel, in the adapter's stream:<id> encoding. */
  townChannelId: string;
  /** The bot↔human DM, in the adapter's dm:<ids> encoding. */
  dmChannelId: string;
};

const PW = "ITtestpass123!";
const BOT_EMAIL = "itbot@e2e.local";
const HUMAN_EMAIL = "ithuman@e2e.local";

export async function waitForServer(url: string, timeoutMs = 600_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      // Unauthenticated and cheap; first boot runs migrations for minutes.
      const res = await fetch(`${url}/api/v1/server_settings`);
      if (res.ok) return;
      lastErr = new Error(`server_settings ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`bootstrap: zulip not ready after ${timeoutMs}ms: ${lastErr}`);
}

async function must(res: Response, what: string): Promise<Record<string, any>> {
  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok || body.result === "error") {
    throw new Error(`bootstrap: ${what} failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

async function fetchIdentity(
  url: string,
  email: string
): Promise<{ apiKey: string; userId: string }> {
  const key = await must(
    await fetch(`${url}/api/v1/fetch_api_key`, {
      method: "POST",
      body: new URLSearchParams({ username: email, password: PW }),
    }),
    `fetch_api_key for ${email}`
  );
  const auth = `Basic ${Buffer.from(`${email}:${key.api_key}`).toString("base64")}`;
  const me = await must(
    await fetch(`${url}/api/v1/users/me`, { headers: { Authorization: auth } }),
    `users/me for ${email}`
  );
  return { apiKey: key.api_key as string, userId: String(me.user_id) };
}

export async function bootstrap(url: string): Promise<ITContext> {
  await waitForServer(url);

  const bot = await fetchIdentity(url, BOT_EMAIL);
  const human = await fetchIdentity(url, HUMAN_EMAIL);

  // Shared channel, both members. Subscribing is idempotent and creates the
  // channel on first use.
  for (const who of [
    { email: BOT_EMAIL, apiKey: bot.apiKey },
    { email: HUMAN_EMAIL, apiKey: human.apiKey },
  ]) {
    const auth = `Basic ${Buffer.from(`${who.email}:${who.apiKey}`).toString("base64")}`;
    await must(
      await fetch(`${url}/api/v1/users/me/subscriptions`, {
        method: "POST",
        headers: { Authorization: auth },
        body: new URLSearchParams({ subscriptions: JSON.stringify([{ name: "town" }]) }),
      }),
      `subscribe ${who.email} to town`
    );
  }
  const botAuth = `Basic ${Buffer.from(`${BOT_EMAIL}:${bot.apiKey}`).toString("base64")}`;
  const town = await must(
    await fetch(`${url}/api/v1/get_stream_id?stream=town`, {
      headers: { Authorization: botAuth },
    }),
    "get town stream id"
  );

  return {
    url,
    botEmail: BOT_EMAIL,
    botApiKey: bot.apiKey,
    botUserId: bot.userId,
    humanEmail: HUMAN_EMAIL,
    humanApiKey: human.apiKey,
    humanUserId: human.userId,
    townChannelId: `stream:${town.stream_id}`,
    dmChannelId: dmChannelId([Number(bot.userId), Number(human.userId)]),
  };
}
