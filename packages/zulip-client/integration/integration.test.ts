// Integration tests: the zulip-client adapter against a real Zulip server
// (docker compose, see run.sh). Both sides of every conversation use the
// adapter itself — the bot under test and a "human" driving it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MessagingClientError, type Message, type MessagingClient } from "messaging-client";
import { createZulipClient } from "../zulip.ts";
import { bootstrap, type ITContext } from "./bootstrap.ts";

// Skipped unless ZULIP_IT_URL is set — run via integration/run.sh (docker
// compose), which executes this file inside a bun container on the compose
// network.
const ZULIP_IT_URL = process.env.ZULIP_IT_URL;

let ctx: ITContext;
let bot: MessagingClient;
let human: MessagingClient;

function collectMessages(client: MessagingClient): { messages: Message[]; stop: () => void } {
  const messages: Message[] = [];
  const stop = client.on("message", (m) => messages.push(m));
  return { messages, stop };
}

async function until<T>(probe: () => T | undefined, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("timed out waiting for condition");
}

describe.skipIf(!ZULIP_IT_URL)("zulip-client integration", () => {
  beforeAll(async () => {
    ctx = await bootstrap(ZULIP_IT_URL!);
    bot = createZulipClient({ url: ctx.url, email: ctx.botEmail, apiKey: ctx.botApiKey });
    human = createZulipClient({ url: ctx.url, email: ctx.humanEmail, apiKey: ctx.humanApiKey });
    await bot.connect();
    await human.connect();
  });

  afterAll(async () => {
    await bot?.disconnect();
    await human?.disconnect();
  });

  describe("identity", () => {
    test("self() maps the bot user", async () => {
      const me = await bot.self();
      expect(me.id).toBe(ctx.botUserId);
      expect(me.username).toBe("itbot");
      expect(me.displayName).toBe("IT Bot");
    });

    test("getUser maps another user", async () => {
      const user = await bot.getUser(ctx.humanUserId);
      // Zulip hides other users' real emails by default
      // (email_address_visibility), so the handle derives from the synthetic
      // user<id>@... address — stable, just not the seeded localpart.
      expect(user.username).toBeDefined();
      expect(user.displayName).toBe("IT Human");
      expect(user.id).toBe(ctx.humanUserId);
    });

    test("a bad api key maps to forbidden", async () => {
      const evil = createZulipClient({ url: ctx.url, email: ctx.botEmail, apiKey: "wrong" });
      expect(evil.self()).rejects.toMatchObject({ code: "forbidden" });
    });
  });

  describe("DMs", () => {
    test("human's DM reaches the bot through the event queue", async () => {
      const inbox = collectMessages(bot);
      try {
        const sent = await human.sendMessage(ctx.dmChannelId, { text: "ping from human" });
        const received = await until(() => inbox.messages.find((m) => m.id === sent.id));
        expect(received.channelId).toBe(ctx.dmChannelId);
        expect(received.senderId).toBe(ctx.humanUserId);
        expect(received.text).toBe("ping from human");
        expect(received.threadId).toBeUndefined();
      } finally {
        inbox.stop();
      }
    });

    test("bot's reply round-trips through getMessage", async () => {
      const sent = await bot.sendMessage(ctx.dmChannelId, { text: "pong from bot" });
      const fetched = await human.getMessage(ctx.dmChannelId, sent.id);
      expect(fetched.text).toBe("pong from bot");
      expect(fetched.senderId).toBe(ctx.botUserId);
      expect(fetched.channelId).toBe(ctx.dmChannelId);
    });
  });

  describe("streams and topics", () => {
    test("threadId maps onto the topic", async () => {
      const sent = await bot.sendMessage(ctx.townChannelId, {
        text: "topical message",
        threadId: "it-topic",
      });
      const fetched = await bot.getMessage(ctx.townChannelId, sent.id);
      expect(fetched.threadId).toBe("it-topic");
      expect(fetched.channelId).toBe(ctx.townChannelId);
    });

    test("fetchMessages narrows by topic", async () => {
      await bot.sendMessage(ctx.townChannelId, { text: "in the weeds", threadId: "other-topic" });
      const inTopic = await bot.fetchMessages(ctx.townChannelId, { threadId: "it-topic" });
      expect(inTopic.length).toBeGreaterThan(0);
      expect(inTopic.every((m) => m.threadId === "it-topic")).toBe(true);
    });

    test("fetchMessages respects limit and returns oldest-first", async () => {
      for (const n of [1, 2, 3]) {
        await bot.sendMessage(ctx.townChannelId, { text: `burst ${n}`, threadId: "it-topic" });
      }
      const window = await bot.fetchMessages(ctx.townChannelId, { limit: 2 });
      expect(window).toHaveLength(2);
      expect(window[0]!.createdAt).toBeLessThanOrEqual(window[1]!.createdAt);
    });

    test("fetchMessages since filters older messages", async () => {
      const before = await bot.sendMessage(ctx.townChannelId, { text: "old", threadId: "since-t" });
      await new Promise((r) => setTimeout(r, 1100)); // zulip timestamps are seconds
      const cutoff = Date.now();
      const after = await bot.sendMessage(ctx.townChannelId, { text: "new", threadId: "since-t" });
      const since = await bot.fetchMessages(ctx.townChannelId, { since: cutoff });
      expect(since.some((m) => m.id === after.id)).toBe(true);
      expect(since.some((m) => m.id === before.id)).toBe(false);
    });
  });

  describe("editing and reactions", () => {
    test("editMessage updates text and editedAt", async () => {
      const sent = await bot.sendMessage(ctx.dmChannelId, { text: "tpyo" });
      const edited = await bot.editMessage(ctx.dmChannelId, sent.id, "typo fixed");
      expect(edited.text).toBe("typo fixed");
      expect(edited.editedAt).toBeGreaterThan(0);
    });

    test("reactions use shortcode names", async () => {
      const sent = await human.sendMessage(ctx.dmChannelId, { text: "react to me" });
      await bot.addReaction(ctx.dmChannelId, sent.id, "eyes");
      const raw = await fetch(`${ctx.url}/api/v1/messages/${sent.id}`, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${ctx.humanEmail}:${ctx.humanApiKey}`).toString("base64")}`,
        },
      }).then((r) => r.json() as Promise<{ message: { reactions: { emoji_name: string }[] } }>);
      expect(raw.message.reactions.some((r) => r.emoji_name === "eyes")).toBe(true);
      await bot.removeReaction(ctx.dmChannelId, sent.id, "eyes");
    });

    test("getMessage enforces the channel scope", async () => {
      const sent = await bot.sendMessage(ctx.dmChannelId, { text: "scoped" });
      expect(bot.getMessage(ctx.townChannelId, sent.id)).rejects.toMatchObject({
        code: "not_found",
      });
    });
  });

  describe("channels", () => {
    test("getChannel maps a public stream", async () => {
      const channel = await bot.getChannel(ctx.townChannelId);
      expect(channel.kind).toBe("public");
      expect(channel.name).toBe("town");
    });

    test("getChannel maps a DM", async () => {
      const channel = await bot.getChannel(ctx.dmChannelId);
      expect(channel.kind).toBe("dm");
    });

    test("listChannels includes the stream and the DM conversation", async () => {
      const channels = await bot.listChannels();
      const ids = channels.map((c) => c.id);
      expect(ids).toContain(ctx.townChannelId);
      expect(ids).toContain(ctx.dmChannelId);
    });
  });

  describe("read state", () => {
    test("markRead settles unreads and survives a fresh client", async () => {
      const sent = await human.sendMessage(ctx.dmChannelId, { text: "unread ping" });
      const before = await bot.getReadState(ctx.dmChannelId);
      expect(before.unreadCount ?? 0).toBeGreaterThan(0);

      await bot.markRead(ctx.dmChannelId);
      const after = await bot.getReadState(ctx.dmChannelId);
      expect(after.unreadCount).toBe(0);
      expect(after.lastViewedAt).toBeGreaterThanOrEqual(sent.createdAt - 1000);

      // Restart scenario: flags live on the server, so a brand-new client
      // (fresh process) must see the same read state — no replay.
      const fresh = createZulipClient({ url: ctx.url, email: ctx.botEmail, apiKey: ctx.botApiKey });
      const restarted = await fresh.getReadState(ctx.dmChannelId);
      expect(restarted.lastViewedAt).toBeGreaterThan(0);
      expect(restarted.unreadCount).toBe(0);
    });
  });

  describe("attachments", () => {
    test("upload, surface, and download round-trip", async () => {
      const payload = new TextEncoder().encode("attachment payload 123");
      const sent = await bot.sendMessage(ctx.dmChannelId, {
        text: "here is a file",
        files: [{ name: "hello.txt", data: payload, mimeType: "text/plain" }],
      });
      expect(sent.text).toContain("/user_uploads/");

      const fetched = await human.getMessage(ctx.dmChannelId, sent.id);
      expect(fetched.attachments).toBeDefined();
      const attachment = fetched.attachments![0]!;
      expect(attachment.name).toBe("hello.txt");

      const info = await human.getAttachment(attachment.id);
      expect(info.name).toBe("hello.txt");

      const bytes = await human.downloadAttachment(attachment.id);
      expect(new TextDecoder().decode(bytes)).toBe("attachment payload 123");
    });
  });
});
