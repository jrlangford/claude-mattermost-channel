import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Agent, AgentInput } from "agent";
import type { Channel, Message, MessagingClient, MessagingEvents } from "messaging-client";
import { gate, pruneExpired, readAccess, saveAccess, type Access } from "./access.ts";
import { conversationFor, conversationKeyFor } from "./conversation.ts";
import { createBot } from "./bot.ts";

// ---------------------------------------------------------------------------
// fakes

function fakeClient(channels: Record<string, Channel["kind"]> = { c1: "dm" }) {
  const handlers = new Map<string, Set<(payload: any) => void>>();
  const sent: { channelId: string; text: string; threadId?: string }[] = [];
  const markedRead: string[] = [];
  const reactions: { channelId: string; messageId: string; emoji: string }[] = [];
  let nextId = 0;

  const client = {
    backend: "fake",
    async connect() {
      emit("connected", undefined);
    },
    async disconnect() {},
    on(event: string, handler: (payload: any) => void) {
      (handlers.get(event) ?? handlers.set(event, new Set()).get(event)!).add(handler);
      return () => handlers.get(event)?.delete(handler);
    },
    async self() {
      return { id: "bot-user", username: "itbot" };
    },
    async sendMessage(channelId: string, message: { text: string; threadId?: string }) {
      sent.push({ channelId, text: message.text, threadId: message.threadId });
      return { id: `sent-${++nextId}`, channelId, senderId: "bot-user", text: message.text, createdAt: Date.now() };
    },
    async getChannel(channelId: string) {
      return { id: channelId, kind: channels[channelId] ?? "public" };
    },
    async getUser(userId: string) {
      return { id: userId, username: `user-${userId}` };
    },
    async markRead(channelId: string) {
      markedRead.push(channelId);
    },
    async addReaction(channelId: string, messageId: string, emoji: string) {
      reactions.push({ channelId, messageId, emoji });
    },
    async listChannels() {
      return Object.entries(channels).map(([id, kind]) => ({ id, kind }));
    },
    async getReadState() {
      return { lastViewedAt: 1, unreadCount: 0 };
    },
    async fetchMessages() {
      return [];
    },
    async downloadAttachment() {
      return new TextEncoder().encode("filedata");
    },
  } as unknown as MessagingClient;

  function emit<E extends keyof MessagingEvents>(event: E, payload: MessagingEvents[E]) {
    for (const h of handlers.get(event) ?? []) h(payload);
  }

  return { client, sent, markedRead, reactions, emit };
}

function fakeAgent(behavior?: {
  reply?: string | null;
  failOnce?: boolean;
  needsLocalFiles?: boolean;
}) {
  const calls: { key: string; input: AgentInput }[] = [];
  let failed = false;
  const agent: Agent = {
    mode: "fake",
    needsLocalFiles: behavior?.needsLocalFiles,
    async start() {},
    async send(key, input) {
      calls.push({ key, input });
      if (behavior?.failOnce && !failed) {
        failed = true;
        throw new Error("turn exploded");
      }
      if (behavior?.reply === null) return null;
      return { text: behavior?.reply ?? "agent reply" };
    },
    async stop() {},
  };
  return { agent, calls };
}

const msg = (over: Partial<Message> = {}): Message => ({
  id: `m-${Math.random().toString(36).slice(2, 8)}`,
  channelId: "c1",
  senderId: "u1",
  text: "hello",
  createdAt: Date.now(),
  ...over,
});

async function settle(ms = 30) {
  await new Promise((r) => setTimeout(r, ms));
}

function allowedAccess(dir: string): void {
  const access: Access = {
    dmPolicy: "pairing",
    allowFrom: ["u1"],
    groups: { town: { requireMention: true, allowFrom: [] } },
    pending: {},
  };
  saveAccess(join(dir, "access.json"), access);
}

async function startBot(opts: {
  channels?: Record<string, Channel["kind"]>;
  agentBehavior?: Parameters<typeof fakeAgent>[0];
  allow?: boolean;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bot-"));
  if (opts.allow !== false) allowedAccess(dir);
  const fc = fakeClient(opts.channels ?? { c1: "dm", town: "public" });
  const fa = fakeAgent(opts.agentBehavior);
  const bot = createBot({
    client: fc.client,
    agent: fa.agent,
    stateDir: dir,
    receiptDelayMs: 1,
    approvalPollMs: 0,
    errorNotice: "the agent failed while handling that message.",
  });
  await bot.start();
  return { dir, fc, fa, bot };
}

// ---------------------------------------------------------------------------
// gate (pure policy)

describe("gate", () => {
  const base: Access = { dmPolicy: "pairing", allowFrom: [], groups: {}, pending: {} };
  const params = { senderId: "u1", channelId: "c1", isDM: true, mentioned: false };

  test("allowlisted DM sender delivers under any policy", () => {
    const access = { ...structuredClone(base), allowFrom: ["u1"], dmPolicy: "allowlist" as const };
    expect(gate(access, params).result).toEqual({ action: "deliver" });
  });

  test("disabled drops everyone; allowlist drops strangers", () => {
    expect(gate({ ...structuredClone(base), dmPolicy: "disabled" }, params).result.action).toBe("drop");
    expect(gate({ ...structuredClone(base), dmPolicy: "allowlist" }, params).result.action).toBe("drop");
  });

  test("pairing: stranger gets a code, capped resends, then silence", () => {
    const access = structuredClone(base);
    const first = gate(access, params);
    expect(first.result.action).toBe("pair");
    expect(first.mutated).toBe(true);
    const code = (first.result as any).code;

    const second = gate(access, params);
    expect(second.result).toEqual({ action: "pair", code, isResend: true });

    const third = gate(access, params); // MAX_PAIR_REPLIES = 2
    expect(third.result.action).toBe("drop");
  });

  test("pending cap: a flood of strangers cannot mint unlimited codes", () => {
    const access = structuredClone(base);
    for (let i = 0; i < 3; i++) {
      expect(gate(access, { ...params, senderId: `s${i}` }).result.action).toBe("pair");
    }
    expect(gate(access, { ...params, senderId: "s99" }).result.action).toBe("drop");
  });

  test("groups: opt-in only, per-channel allowlist, mention requirement", () => {
    const g = { senderId: "u1", channelId: "town", isDM: false, mentioned: false };
    expect(gate(structuredClone(base), g).result.action).toBe("drop"); // not opted in

    const opted = {
      ...structuredClone(base),
      groups: { town: { requireMention: true, allowFrom: [] } },
    };
    expect(gate(opted, g).result.action).toBe("drop"); // no mention
    expect(gate(opted, { ...g, mentioned: true }).result.action).toBe("deliver");

    const listed = {
      ...structuredClone(base),
      groups: { town: { requireMention: false, allowFrom: ["someone-else"] } },
    };
    expect(gate(listed, g).result.action).toBe("drop"); // not on channel allowlist
  });

  test("pruneExpired drops stale codes", () => {
    const access = structuredClone(base);
    access.pending.old = { senderId: "s", chatId: "c", createdAt: 0, expiresAt: 1, replies: 1 };
    expect(pruneExpired(access)).toBe(true);
    expect(Object.keys(access.pending)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// conversations

describe("conversation mapping", () => {
  test("DM keys on the channel; group keys on the thread (rooting unthreaded posts)", () => {
    expect(conversationKeyFor("c1", true, "m1")).toBe("dm:c1");
    expect(conversationKeyFor("c1", false, "m1")).toBe("channel:c1:thread:m1");
    expect(conversationKeyFor("c1", false, "m1", "r1")).toBe("channel:c1:thread:r1");
    expect(conversationFor(msg({ id: "m1", channelId: "g", threadId: undefined }), false).threadId).toBe("m1");
    expect(conversationFor(msg({ threadId: "r1" }), true).threadId).toBe("r1");
  });
});

// ---------------------------------------------------------------------------
// the bot pipeline

describe("createBot", () => {
  test("delivers a gated DM to the agent and posts the reply", async () => {
    const { fc, fa } = await startBot();
    fc.emit("message", msg({ id: "m1", text: "hi bot" }));
    await settle();

    expect(fa.calls).toHaveLength(1);
    expect(fa.calls[0]!.key).toBe("dm:c1");
    expect(fa.calls[0]!.input.text).toBe("hi bot");
    expect(fa.calls[0]!.input.meta).toMatchObject({
      chat_id: "c1",
      message_id: "m1",
      user: "user-u1",
      user_id: "u1",
    });
    expect(fc.sent).toHaveLength(1);
    expect(fc.sent[0]!.text).toBe("agent reply");
  });

  test("marks read + reacts 👀 only after the reply is posted", async () => {
    const { fc } = await startBot();
    fc.emit("message", msg({ id: "m1" }));
    await settle(50);
    expect(fc.markedRead).toEqual(["c1"]);
    expect(fc.reactions).toEqual([{ channelId: "c1", messageId: "m1", emoji: "eyes" }]);
  });

  test("session-mode null replies still settle the channel", async () => {
    const { fc, fa } = await startBot({ agentBehavior: { reply: null } });
    fc.emit("message", msg({ id: "m1" }));
    await settle(50);
    expect(fa.calls).toHaveLength(1);
    expect(fc.sent).toHaveLength(0); // nothing posted
    expect(fc.markedRead).toEqual(["c1"]); // but delivery-gated receipt fired
  });

  test("own messages and duplicates are skipped", async () => {
    const { fc, fa } = await startBot();
    fc.emit("message", msg({ id: "m1", senderId: "bot-user" }));
    const m = msg({ id: "m2" });
    fc.emit("message", m);
    fc.emit("message", m);
    await settle();
    expect(fa.calls).toHaveLength(1);
  });

  test("a failed turn leaves the channel unread, posts the error notice, undoes dedup", async () => {
    const { fc, fa } = await startBot({ agentBehavior: { failOnce: true } });
    const m = msg({ id: "m1", text: "boom" });
    fc.emit("message", m);
    await settle(50);

    expect(fc.markedRead).toHaveLength(0); // receipt held
    expect(fc.sent.map((s) => s.text)).toEqual(["the agent failed while handling that message."]);

    // Redelivery (as catch-up would) now succeeds: dedup was undone.
    fc.emit("message", m);
    await settle(50);
    expect(fa.calls).toHaveLength(2);
    expect(fc.markedRead).toEqual(["c1"]);
  });

  test("strangers get a pairing code; the agent never sees the message", async () => {
    const { fc, fa, dir } = await startBot({ allow: false });
    fc.emit("message", msg({ id: "m1", senderId: "stranger" }));
    await settle();

    expect(fa.calls).toHaveLength(0);
    expect(fc.sent).toHaveLength(1);
    expect(fc.sent[0]!.text).toContain("pairing code");
    const access = readAccess(join(dir, "access.json"));
    expect(Object.keys(access.pending)).toHaveLength(1);
  });

  test("group channels: mention required, replies thread under the post", async () => {
    const { fc, fa } = await startBot();
    fc.emit("message", msg({ id: "g1", channelId: "town", text: "no mention here" }));
    await settle();
    expect(fa.calls).toHaveLength(0); // dropped

    fc.emit("message", msg({ id: "g2", channelId: "town", text: "@itbot help" }));
    await settle();
    expect(fa.calls).toHaveLength(1);
    expect(fa.calls[0]!.key).toBe("channel:town:thread:g2");
    expect(fc.sent[0]!.threadId).toBe("g2"); // reply threads under the post
  });

  test("structured mentions work without text matching", async () => {
    const { fc, fa } = await startBot();
    fc.emit("message", msg({ id: "g3", channelId: "town", text: "hey", mentions: ["bot-user"] }));
    await settle();
    expect(fa.calls).toHaveLength(1);
  });

  test("needsLocalFiles agents get attachments localized to disk", async () => {
    const { fc, fa } = await startBot({ agentBehavior: { needsLocalFiles: true } });
    fc.emit(
      "message",
      msg({
        id: "m1",
        attachments: [{ id: "f1", name: "notes.txt", size: 8, mimeType: "text/plain" }],
      })
    );
    await settle(50);

    const files = fa.calls[0]!.input.files!;
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe("notes.txt");
    expect(readFileSync(files[0]!.path!, "utf-8")).toBe("filedata");
    expect(fa.calls[0]!.input.meta!.attachment_count).toBe("1");
  });

  test("agents without needsLocalFiles get metadata only", async () => {
    const { fa, fc } = await startBot();
    fc.emit("message", msg({ id: "m1", attachments: [{ id: "f1", name: "a.txt" }] }));
    await settle();
    expect(fa.calls[0]!.input.files).toBeUndefined();
    expect(fa.calls[0]!.input.meta!.attachments).toContain("f1");
  });

  test("outbound guard: DM vouched only after gated inbound; groups by opt-in", async () => {
    const { fc, bot } = await startBot();
    await expect(bot.guard.allow("c1")).rejects.toThrow("not allowlisted");
    await bot.guard.allow("town"); // opted-in group

    fc.emit("message", msg({ id: "m1" })); // gated DM from allowlisted u1
    await settle();
    await bot.guard.allow("c1"); // now vouched
  });

  test("approval files trigger the paired notice", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bot-"));
    allowedAccess(dir);
    const fc = fakeClient();
    const fa = fakeAgent();
    const bot = createBot({
      client: fc.client,
      agent: fa.agent,
      stateDir: dir,
      approvalPollMs: 10,
      receiptDelayMs: 1,
    });
    await bot.start();
    mkdirSync(join(dir, "approved"), { recursive: true });
    writeFileSync(join(dir, "approved", "u9"), "c9\n");
    await settle(60);
    expect(fc.sent.some((s) => s.channelId === "c9" && s.text.includes("Paired"))).toBe(true);
    await bot.stop();
  });
});
