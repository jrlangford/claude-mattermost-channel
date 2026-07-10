// Integration tests: matrix-client against a REAL Synapse homeserver.
//
// Skipped unless MX_IT_URL is set — run via integration/run.sh (docker
// compose), which executes this file inside a bun container on the compose
// network. Tests share one bootstrapped server + connected client (memoized
// setup) and are order-dependent within the file.

import { afterAll, describe, expect, test } from "bun:test";
import { type Message, type MessagingClient } from "messaging-client";
import { createMatrixClient } from "../index.ts";
import { bootstrap, type ITContext } from "./bootstrap.ts";

const MX_IT_URL = process.env.MX_IT_URL;
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
    const ctx = await bootstrap(MX_IT_URL!);
    const client = createMatrixClient({
      baseUrl: ctx.url,
      accessToken: ctx.botToken,
      userId: ctx.botUserId,
    });
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

/** Poll until fn() returns a value (sync delivery is async). */
async function waitFor<T>(fn: () => T | undefined, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Async variant for conditions that need an API call per probe. */
async function waitForAsync<T>(
  fn: () => Promise<T | undefined>,
  what: string,
  timeoutMs = 20_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The human correspondent — raw REST on purpose, independent of the code under test. */
async function humanApi(ctx: ITContext, path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${ctx.url}/_matrix/client${path}`, {
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

let txnCounter = 0;
const humanSend = async (
  ctx: ITContext,
  roomId: string,
  content: Record<string, unknown>
): Promise<{ event_id: string }> =>
  humanApi(
    ctx,
    `/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/it${++txnCounter}`,
    { method: "PUT", body: JSON.stringify(content) }
  );

const humanPost = (ctx: ITContext, roomId: string, body: string) =>
  humanSend(ctx, roomId, { msgtype: "m.text", body });

describe.skipIf(!MX_IT_URL)("matrix-client integration", () => {
  test("connect() resolves and fires connected; second connect() is a no-op", async () => {
    const s = await setup();
    expect(s.connects).toBe(1);
    await s.client.connect();
    expect(s.connects).toBe(1);
  }, LONG);

  test("self() returns the bot user", async () => {
    const { client, ctx } = await setup();
    const me = await client.self();
    expect(me.id).toBe(ctx.botUserId);
    expect(me.username).toBe("itbot");
  }, LONG);

  test("inbound DM arrives as a message event with the right shape", async () => {
    const s = await setup();
    const posted = await humanPost(s.ctx, s.ctx.dmRoomId, "hello bot");
    const msg = await waitFor(
      () => s.inbox.find((m) => m.id === posted.event_id),
      "inbound DM over sync"
    );
    expect(msg.channelId).toBe(s.ctx.dmRoomId);
    expect(msg.senderId).toBe(s.ctx.humanUserId);
    expect(msg.text).toBe("hello bot");
    expect(msg.threadId).toBeUndefined();
    expect(msg.createdAt).toBeGreaterThan(0);
  }, LONG);

  test("sendMessage posts; own event also arrives via sync (consumers filter)", async () => {
    const s = await setup();
    const sent = await s.client.sendMessage(s.ctx.dmRoomId, { text: "hello human" });
    expect(sent.id).toStartWith("$");
    expect(sent.channelId).toBe(s.ctx.dmRoomId);
    expect(sent.senderId).toBe(s.ctx.botUserId);
    await waitFor(() => s.inbox.find((m) => m.id === sent.id), "own event over sync");
  }, LONG);

  test("threading: reply lands in the thread and fetchMessages(threadId) sees both", async () => {
    const s = await setup();
    const root = await humanPost(s.ctx, s.ctx.dmRoomId, "thread root");
    const reply = await s.client.sendMessage(s.ctx.dmRoomId, {
      text: "thread reply",
      threadId: root.event_id,
    });
    expect(reply.threadId).toBe(root.event_id);

    const thread = await s.client.fetchMessages(s.ctx.dmRoomId, { threadId: root.event_id });
    const ids = thread.map((m) => m.id);
    expect(ids).toContain(root.event_id);
    expect(ids).toContain(reply.id);
    expect(ids.indexOf(root.event_id)).toBeLessThan(ids.indexOf(reply.id)); // oldest-first
  }, LONG);

  test("editMessage updates text, sets editedAt, and keeps the original id", async () => {
    const s = await setup();
    const sent = await s.client.sendMessage(s.ctx.dmRoomId, { text: "tpyo" });
    const edited = await s.client.editMessage(s.ctx.dmRoomId, sent.id, "typo fixed");
    expect(edited.id).toBe(sent.id); // logical message keeps its id
    expect(edited.text).toBe("typo fixed");
    expect(edited.editedAt).toBeGreaterThan(0);
  }, LONG);

  test("reactions: add is a 👀 annotation server-side, remove redacts it", async () => {
    const s = await setup();
    const sent = await s.client.sendMessage(s.ctx.dmRoomId, { text: "react to me" });
    await s.client.addReaction(s.ctx.dmRoomId, sent.id, "eyes");

    const relPath = `/v1/rooms/${encodeURIComponent(s.ctx.dmRoomId)}/relations/${encodeURIComponent(sent.id)}/m.annotation/m.reaction`;
    const after = await humanApi(s.ctx, relPath);
    const mine = (after.chunk as any[]).filter(
      (ev) => ev.sender === s.ctx.botUserId && ev.content["m.relates_to"]?.key === "👀"
    );
    expect(mine).toHaveLength(1);

    await s.client.removeReaction(s.ctx.dmRoomId, sent.id, "eyes");
    // Redaction propagation can lag a moment; poll until the annotation is gone.
    await waitForAsync(async () => {
      const cleared = await humanApi(s.ctx, relPath);
      const remaining = (cleared.chunk as any[]).filter(
        (ev) => ev.content["m.relates_to"]?.key === "👀"
      );
      return remaining.length === 0 ? true : undefined;
    }, "reaction redaction");
  }, LONG);

  test("sendTyping resolves", async () => {
    const s = await setup();
    await s.client.sendTyping!(s.ctx.dmRoomId);
  }, LONG);

  test("getMessage returns the message; wrong room maps to not_found", async () => {
    const s = await setup();
    const posted = await humanPost(s.ctx, s.ctx.dmRoomId, "fetch me");
    const msg = await s.client.getMessage(s.ctx.dmRoomId, posted.event_id);
    expect(msg.text).toBe("fetch me");

    expect(
      s.client.getMessage(s.ctx.townRoomId, posted.event_id)
    ).rejects.toMatchObject({ name: "MessagingClientError", code: "not_found" });
  }, LONG);

  test("fetchMessages: limit gives the newest window, oldest-first", async () => {
    const s = await setup();
    for (const t of ["one", "two", "three"]) {
      await humanPost(s.ctx, s.ctx.townRoomId, t);
      await new Promise((r) => setTimeout(r, 10)); // distinct origin_server_ts
    }
    const recent = await s.client.fetchMessages(s.ctx.townRoomId, { limit: 10 });
    expect(recent.map((m) => m.text)).toEqual(["one", "two", "three"]);
    for (let i = 1; i < recent.length; i++) {
      expect(recent[i]!.createdAt).toBeGreaterThanOrEqual(recent[i - 1]!.createdAt);
    }
  }, LONG);

  test("fetchMessages: since returns newer posts in ascending order", async () => {
    const s = await setup();
    const marker = await humanPost(s.ctx, s.ctx.townRoomId, "marker");
    const markerMsg = await s.client.getMessage(s.ctx.townRoomId, marker.event_id);
    await new Promise((r) => setTimeout(r, 10));
    const newer = await humanPost(s.ctx, s.ctx.townRoomId, "after marker");

    const since = await s.client.fetchMessages(s.ctx.townRoomId, {
      since: markerMsg.createdAt,
    });
    const ids = since.map((m) => m.id);
    expect(ids).toContain(newer.event_id);
    expect(ids).not.toContain(marker.event_id);
    for (let i = 1; i < since.length; i++) {
      expect(since[i]!.createdAt).toBeGreaterThanOrEqual(since[i - 1]!.createdAt);
    }
  }, LONG);

  test("m.mentions surface on inbound messages", async () => {
    const s = await setup();
    const posted = await humanSend(s.ctx, s.ctx.townRoomId, {
      msgtype: "m.text",
      body: "itbot ping",
      "m.mentions": { user_ids: [s.ctx.botUserId] },
    });
    const msg = await waitFor(
      () => s.inbox.find((m) => m.id === posted.event_id),
      "mention post over sync"
    );
    expect(msg.mentions).toContain(s.ctx.botUserId);
  }, LONG);

  test("getUser / getChannel map wire types (and m.direct room is dm)", async () => {
    const s = await setup();
    const human = await s.client.getUser(s.ctx.humanUserId);
    expect(human.username).toBe("ithuman");

    const town = await s.client.getChannel(s.ctx.townRoomId);
    expect(town.kind).toBe("public");
    expect(town.name).toBe("IT Town");

    const dm = await s.client.getChannel(s.ctx.dmRoomId);
    expect(dm.kind).toBe("dm");
  }, LONG);

  test("listChannels includes DM + town, no duplicates", async () => {
    const s = await setup();
    const channels = await s.client.listChannels();
    const ids = channels.map((c) => c.id);
    expect(ids).toContain(s.ctx.townRoomId);
    expect(ids).toContain(s.ctx.dmRoomId);
    expect(new Set(ids).size).toBe(ids.length);
  }, LONG);

  test("markRead / getReadState round-trip", async () => {
    const s = await setup();
    await s.client.markRead(s.ctx.dmRoomId);
    const posted = await humanPost(s.ctx, s.ctx.dmRoomId, "unread me");
    await waitFor(() => s.inbox.find((m) => m.id === posted.event_id), "unread post over sync");

    const before = await waitForAsync(async () => {
      const state = await s.client.getReadState(s.ctx.dmRoomId);
      return (state.unreadCount ?? 0) > 0 ? state : undefined;
    }, "unread count > 0");

    await s.client.markRead(s.ctx.dmRoomId);
    const after = await waitForAsync(async () => {
      const state = await s.client.getReadState(s.ctx.dmRoomId);
      return state.unreadCount === 0 ? state : undefined;
    }, "unread count back to 0");
    expect(after.lastViewedAt).toBeGreaterThanOrEqual(before.lastViewedAt);
    expect(after.lastViewedAt).toBeGreaterThan(0);
  }, LONG);

  test("attachments: upload (file-only message), then info + download round-trip", async () => {
    const s = await setup();
    const payload = new TextEncoder().encode("hello matrix attachment");
    const sent = await s.client.sendMessage(s.ctx.dmRoomId, {
      text: "",
      files: [{ name: "hello.txt", data: payload, mimeType: "text/plain" }],
    });
    expect(sent.attachments).toHaveLength(1);
    const attachment = sent.attachments![0]!;
    expect(attachment.id).toStartWith("mxc://");
    expect(attachment.name).toBe("hello.txt");
    expect(attachment.mimeType).toBe("text/plain");
    expect(attachment.size).toBe(payload.length);

    const info = await s.client.getAttachment(attachment.id);
    expect(info.mimeType).toStartWith("text/plain");

    const bytes = await s.client.downloadAttachment(attachment.id);
    expect(new TextDecoder().decode(bytes)).toBe("hello matrix attachment");
  }, LONG);

  test("read state survives a fresh client (bot restart scenario)", async () => {
    const s = await setup();
    await s.client.markRead(s.ctx.dmRoomId);

    // A brand-new client on the same account — the sync store starts empty,
    // exactly like a bot restart. Without a marker fallback this reads 0 and
    // a restarting bot replays already-answered history into a fresh agent.
    const fresh = createMatrixClient({
      baseUrl: s.ctx.url,
      accessToken: s.ctx.botToken,
      userId: s.ctx.botUserId,
    });
    await fresh.connect();
    try {
      const state = await fresh.getReadState(s.ctx.dmRoomId);
      expect(state.lastViewedAt).toBeGreaterThan(0);
    } finally {
      await fresh.disconnect();
    }
  }, LONG);

  test("error mapping: bad token → forbidden, missing event → not_found", async () => {
    const s = await setup();
    const badClient = createMatrixClient({
      baseUrl: s.ctx.url,
      accessToken: "notavalidtoken",
      userId: s.ctx.botUserId,
    });
    // Not getUser: Matrix profile lookup is an UNauthenticated endpoint, so a
    // bad token still succeeds there. /messages requires auth.
    expect(
      badClient.fetchMessages(s.ctx.dmRoomId, { limit: 1 })
    ).rejects.toMatchObject({
      name: "MessagingClientError",
      code: "forbidden",
    });

    expect(
      s.client.getMessage(s.ctx.dmRoomId, "$doesnotexist:it.local")
    ).rejects.toMatchObject({ name: "MessagingClientError", code: "not_found" });
  }, LONG);

  test("disconnect is permanent: connect() afterwards rejects", async () => {
    const s = await setup();
    const events: boolean[] = [];
    s.client.on("disconnected", (info) => events.push(info.willReconnect));
    await s.client.disconnect();
    expect(events).toEqual([false]);
    expect(s.client.connect()).rejects.toMatchObject({
      name: "MessagingClientError",
      code: "invalid_request",
    });
  }, LONG);
});
