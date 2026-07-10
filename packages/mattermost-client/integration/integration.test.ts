// Integration tests: mattermost-client against a REAL Mattermost server.
//
// Skipped unless MM_IT_URL is set — run via integration/run.sh (docker
// compose), which executes this file inside a bun container on the compose
// network. Tests share one bootstrapped server + connected client (memoized
// setup, not beforeAll, so readiness time counts against the generous
// per-test timeout) and are order-dependent within the file.

import { afterAll, describe, expect, test } from "bun:test";
import {
  MessagingClientError,
  type Message,
  type MessagingClient,
} from "messaging-client";
import { createMattermostClient } from "../index.ts";
import { bootstrap, type ITContext } from "./bootstrap.ts";

const MM_IT_URL = process.env.MM_IT_URL;
const LONG = 240_000;

type Setup = {
  ctx: ITContext;
  client: MessagingClient;
  inbox: Message[];
  connects: number;
};

let setupPromise: Promise<Setup> | null = null;
let teardownClient: MessagingClient | null = null;

function setup(): Promise<Setup> {
  setupPromise ??= (async () => {
    const ctx = await bootstrap(MM_IT_URL!);
    const client = createMattermostClient({ url: ctx.url, token: ctx.botToken });
    teardownClient = client;
    const s: Setup = { ctx, client, inbox: [], connects: 0 };
    client.on("message", (msg) => s.inbox.push(msg));
    client.on("connected", () => s.connects++);
    await client.connect();
    return s;
  })();
  return setupPromise;
}

afterAll(async () => {
  await teardownClient?.disconnect();
});

/** Poll until fn() returns a value (WS delivery is async). */
async function waitFor<T>(fn: () => T | undefined, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The human correspondent — raw REST on purpose, independent of the code under test. */
async function humanApi(ctx: ITContext, path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${ctx.url}/api/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${ctx.humanToken}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) throw new Error(`human ${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

const humanPost = (ctx: ITContext, channelId: string, message: string, rootId?: string) =>
  humanApi(ctx, "/posts", {
    method: "POST",
    body: JSON.stringify({ channel_id: channelId, message, ...(rootId ? { root_id: rootId } : {}) }),
  });

describe.skipIf(!MM_IT_URL)("mattermost-client integration", () => {
  test("connect() resolves and fires connected; second connect() is a no-op", async () => {
    const s = await setup();
    expect(s.connects).toBe(1);
    await s.client.connect(); // started guard — resolves immediately
    expect(s.connects).toBe(1);
  }, LONG);

  test("self() returns the bot user", async () => {
    const { client, ctx } = await setup();
    const me = await client.self();
    expect(me.id).toBe(ctx.botUserId);
    expect(me.username).toBe("itbot");
    expect(me.isBot).toBe(true);
  }, LONG);

  test("inbound DM arrives as a message event with the right shape", async () => {
    const s = await setup();
    const posted = await humanPost(s.ctx, s.ctx.dmChannelId, "hello bot");
    const msg = await waitFor(
      () => s.inbox.find((m) => m.id === posted.id),
      "inbound DM over WS"
    );
    expect(msg.channelId).toBe(s.ctx.dmChannelId);
    expect(msg.senderId).toBe(s.ctx.humanUserId);
    expect(msg.text).toBe("hello bot");
    expect(msg.threadId).toBeUndefined();
    expect(msg.createdAt).toBeGreaterThan(0);
  }, LONG);

  test("sendMessage posts; own post also arrives on the WS (consumers filter)", async () => {
    const s = await setup();
    const sent = await s.client.sendMessage(s.ctx.dmChannelId, { text: "hello human" });
    expect(sent.id).toMatch(/^[a-z0-9]{26}$/i);
    expect(sent.channelId).toBe(s.ctx.dmChannelId);
    expect(sent.senderId).toBe(s.ctx.botUserId);
    await waitFor(() => s.inbox.find((m) => m.id === sent.id), "own post over WS");
  }, LONG);

  test("threading: reply lands in the thread and fetchMessages(threadId) sees both", async () => {
    const s = await setup();
    const root = await humanPost(s.ctx, s.ctx.dmChannelId, "thread root");
    const reply = await s.client.sendMessage(s.ctx.dmChannelId, {
      text: "thread reply",
      threadId: root.id,
    });
    expect(reply.threadId).toBe(root.id);

    const thread = await s.client.fetchMessages(s.ctx.dmChannelId, { threadId: root.id });
    const ids = thread.map((m) => m.id);
    expect(ids).toContain(root.id);
    expect(ids).toContain(reply.id);
    expect(ids.indexOf(root.id)).toBeLessThan(ids.indexOf(reply.id)); // oldest-first
  }, LONG);

  test("editMessage updates text and sets editedAt", async () => {
    const s = await setup();
    const sent = await s.client.sendMessage(s.ctx.dmChannelId, { text: "tpyo" });
    const edited = await s.client.editMessage(s.ctx.dmChannelId, sent.id, "typo fixed");
    expect(edited.id).toBe(sent.id);
    expect(edited.text).toBe("typo fixed");
    expect(edited.editedAt).toBeGreaterThan(0);
  }, LONG);

  test("reactions: add is visible server-side, remove clears it", async () => {
    const s = await setup();
    const sent = await s.client.sendMessage(s.ctx.dmChannelId, { text: "react to me" });
    await s.client.addReaction(s.ctx.dmChannelId, sent.id, "eyes");
    const after: any[] =
      (await humanApi(s.ctx, `/posts/${sent.id}/reactions`)) ?? [];
    expect(after.some((r) => r.emoji_name === "eyes" && r.user_id === s.ctx.botUserId)).toBe(true);

    await s.client.removeReaction(s.ctx.dmChannelId, sent.id, "eyes");
    const cleared: any[] =
      (await humanApi(s.ctx, `/posts/${sent.id}/reactions`)) ?? [];
    expect(cleared.some((r) => r.emoji_name === "eyes")).toBe(false);
  }, LONG);

  test("sendTyping resolves", async () => {
    const s = await setup();
    await s.client.sendTyping!(s.ctx.dmChannelId);
  }, LONG);

  test("getMessage returns the message; wrong channel maps to not_found", async () => {
    const s = await setup();
    const posted = await humanPost(s.ctx, s.ctx.dmChannelId, "fetch me");
    const msg = await s.client.getMessage(s.ctx.dmChannelId, posted.id);
    expect(msg.text).toBe("fetch me");

    expect(
      s.client.getMessage(s.ctx.townChannelId, posted.id)
    ).rejects.toMatchObject({ name: "MessagingClientError", code: "not_found" });
  }, LONG);

  test("fetchMessages: limit gives the newest window, oldest-first", async () => {
    const s = await setup();
    const texts = ["one", "two", "three"];
    for (const t of texts) {
      await humanPost(s.ctx, s.ctx.townChannelId, t);
      await new Promise((r) => setTimeout(r, 10)); // distinct create_at
    }
    const last2 = await s.client.fetchMessages(s.ctx.townChannelId, { limit: 2 });
    expect(last2.map((m) => m.text)).toEqual(["two", "three"]);
    for (let i = 1; i < last2.length; i++) {
      expect(last2[i]!.createdAt).toBeGreaterThanOrEqual(last2[i - 1]!.createdAt);
    }
  }, LONG);

  test("fetchMessages: since returns newer posts in ascending order", async () => {
    const s = await setup();
    const marker = await humanPost(s.ctx, s.ctx.townChannelId, "marker");
    await new Promise((r) => setTimeout(r, 10));
    const newer = await humanPost(s.ctx, s.ctx.townChannelId, "after marker");
    const since = await s.client.fetchMessages(s.ctx.townChannelId, {
      since: marker.create_at,
    });
    const ids = since.map((m) => m.id);
    expect(ids).toContain(newer.id);
    for (let i = 1; i < since.length; i++) {
      expect(since[i]!.createdAt).toBeGreaterThanOrEqual(since[i - 1]!.createdAt);
    }
  }, LONG);

  test("mentions surface from the posted broadcast", async () => {
    const s = await setup();
    const posted = await humanPost(s.ctx, s.ctx.townChannelId, "@itbot ping");
    const msg = await waitFor(
      () => s.inbox.find((m) => m.id === posted.id),
      "mention post over WS"
    );
    expect(msg.mentions).toContain(s.ctx.botUserId);
  }, LONG);

  test("getUser / getChannel map wire types (and DM kind is dm)", async () => {
    const s = await setup();
    const human = await s.client.getUser(s.ctx.humanUserId);
    expect(human.username).toBe("ithuman");

    const town = await s.client.getChannel(s.ctx.townChannelId);
    expect(town.kind).toBe("public");
    expect(town.name).toBe("IT Town");

    const dm = await s.client.getChannel(s.ctx.dmChannelId);
    expect(dm.kind).toBe("dm");
  }, LONG);

  test("listChannels flattens teams, includes DM + town, no duplicates", async () => {
    const s = await setup();
    const channels = await s.client.listChannels();
    const ids = channels.map((c) => c.id);
    expect(ids).toContain(s.ctx.townChannelId);
    expect(ids).toContain(s.ctx.dmChannelId);
    expect(new Set(ids).size).toBe(ids.length);
  }, LONG);

  test("markRead / getReadState round-trip", async () => {
    const s = await setup();
    await s.client.markRead(s.ctx.dmChannelId);
    await humanPost(s.ctx, s.ctx.dmChannelId, "unread me");
    const before = await s.client.getReadState(s.ctx.dmChannelId);
    expect(before.unreadCount ?? 0).toBeGreaterThan(0);

    await s.client.markRead(s.ctx.dmChannelId);
    const after = await s.client.getReadState(s.ctx.dmChannelId);
    expect(after.unreadCount).toBe(0);
    expect(after.lastViewedAt).toBeGreaterThanOrEqual(before.lastViewedAt);
    expect(after.lastViewedAt).toBeGreaterThan(0);
  }, LONG);

  test("attachments: upload with sendMessage, then info + download round-trip", async () => {
    const s = await setup();
    const payload = new TextEncoder().encode("hello mattermost attachment");
    const sent = await s.client.sendMessage(s.ctx.dmChannelId, {
      text: "file incoming",
      files: [{ name: "hello.txt", data: payload, mimeType: "text/plain" }],
    });
    expect(sent.attachments).toHaveLength(1);
    const fileId = sent.attachments![0]!.id;

    const info = await s.client.getAttachment(fileId);
    expect(info.name).toBe("hello.txt");
    // Mattermost normalizes the stored type (e.g. "text/plain; charset=utf-8").
    expect(info.mimeType).toStartWith("text/plain");
    expect(info.size).toBe(payload.length);

    const bytes = await s.client.downloadAttachment(fileId);
    expect(new TextDecoder().decode(bytes)).toBe("hello mattermost attachment");
  }, LONG);

  test("more than 5 files is rejected client-side as invalid_request", async () => {
    const s = await setup();
    const file = { name: "x.txt", data: new Uint8Array([1]) };
    expect(
      s.client.sendMessage(s.ctx.dmChannelId, { text: "too many", files: Array(6).fill(file) })
    ).rejects.toMatchObject({ name: "MessagingClientError", code: "invalid_request" });
  }, LONG);

  test("error mapping: bad token → forbidden, missing post → not_found", async () => {
    const s = await setup();
    const badClient = createMattermostClient({ url: s.ctx.url, token: "notavalidtoken0000000000" });
    expect(badClient.getUser(s.ctx.humanUserId)).rejects.toMatchObject({
      name: "MessagingClientError",
      code: "forbidden",
    });

    expect(
      s.client.getMessage(s.ctx.dmChannelId, "zzzzzzzzzzzzzzzzzzzzzzzzzz")
    ).rejects.toMatchObject({ name: "MessagingClientError", code: "not_found" });
  }, LONG);

  test("heartbeat client stays connected (Bun ping/pong path)", async () => {
    const s = await setup();
    const hb = createMattermostClient({
      url: s.ctx.url,
      token: s.ctx.botToken,
      heartbeatIntervalMs: 500,
    });
    let drops = 0;
    hb.on("disconnected", () => drops++);
    await hb.connect();
    await new Promise((r) => setTimeout(r, 1_800)); // > 3 ping intervals
    expect(drops).toBe(0);
    await hb.disconnect();
  }, LONG);

  test("disconnect is permanent: no reconnect, connect() afterwards rejects", async () => {
    const s = await setup();
    const events: boolean[] = [];
    s.client.on("disconnected", (info) => events.push(info.willReconnect));
    await s.client.disconnect();
    await waitFor(() => (events.length > 0 ? true : undefined), "disconnected event");
    expect(events).toEqual([false]);
    expect(s.client.connect()).rejects.toMatchObject({
      name: "MessagingClientError",
      code: "invalid_request",
    });
  }, LONG);
});
