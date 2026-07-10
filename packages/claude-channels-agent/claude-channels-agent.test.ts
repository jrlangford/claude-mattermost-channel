import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { MessagingClient } from "messaging-client";
import { createClaudeChannelsAgent } from "./claude-channels-agent.ts";

// -- fakes ---------------------------------------------------------------

function fakeMessagingClient() {
  const calls: Record<string, unknown[][]> = {};
  const record = (name: string, args: unknown[]) => {
    (calls[name] ??= []).push(args);
  };
  const client = {
    backend: "fake",
    async sendMessage(...args: unknown[]) {
      record("sendMessage", args);
      return { id: "sent-1", channelId: args[0], senderId: "bot", text: "", createdAt: 1 };
    },
    async editMessage(...args: unknown[]) {
      record("editMessage", args);
      return { id: args[1], channelId: args[0], senderId: "bot", text: "", createdAt: 1 };
    },
    async addReaction(...args: unknown[]) {
      record("addReaction", args);
    },
    async fetchMessages(...args: unknown[]) {
      record("fetchMessages", args);
      return [
        {
          id: "m1",
          channelId: args[0],
          senderId: "u1",
          text: "hello",
          createdAt: 1_700_000_000_000,
          attachments: [{ id: "f1", name: "a.pdf" }],
        },
      ];
    },
    async getAttachment(...args: unknown[]) {
      record("getAttachment", args);
      return { id: args[0], name: "../../evil.pdf", size: 5, mimeType: "application/pdf" };
    },
    async downloadAttachment(...args: unknown[]) {
      record("downloadAttachment", args);
      return new TextEncoder().encode("hello");
    },
  } as unknown as MessagingClient;
  return { client, calls };
}

async function harness(opts: { denied?: string[]; rateMax?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "channels-agent-"));
  const { client, calls } = fakeMessagingClient();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const agent = createClaudeChannelsAgent({
    client,
    allowOutbound: async (channelId) => {
      if (opts.denied?.includes(channelId)) throw new Error(`channel ${channelId} not allowed`);
    },
    downloadsDir: join(dir, "downloads"),
    connectGraceMs: 0, // no first-connect race in tests
    rateLimit: { windowMs: 60_000, maxPerWindow: opts.rateMax ?? 15 },
    transport: serverTransport,
  });

  const mcpClient = new Client({ name: "test-session", version: "0.0.0" }, { capabilities: {} });
  const notifications: any[] = [];
  mcpClient.fallbackNotificationHandler = async (n) => {
    notifications.push(n);
  };

  await agent.start();
  await mcpClient.connect(clientTransport);
  const callTool = (name: string, args: Record<string, unknown>) =>
    mcpClient.callTool({ name, arguments: args }) as Promise<any>;
  return { agent, calls, notifications, callTool, mcpClient, dir };
}

// -- tests -----------------------------------------------------------------

describe("createClaudeChannelsAgent", () => {
  test("send() pushes a channel notification and returns null (session mode)", async () => {
    const h = await harness();
    const reply = await h.agent.send("dm:c1", {
      text: "hello bot",
      meta: { chat_id: "c1", message_id: "m1", user: "ivan" },
    });
    expect(reply).toBeNull();
    // Notification delivery is fire-and-forget on the transport; poll briefly.
    await new Promise((r) => setTimeout(r, 50));
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0].method).toBe("notifications/claude/channel");
    expect(h.notifications[0].params.content).toBe("hello bot");
    expect(h.notifications[0].params.meta.chat_id).toBe("c1");
  });

  test("declares the claude/channel capability (host drops notifications without it)", async () => {
    // Regression: the port once shipped with only {tools: {}} — Claude Code
    // then accepted every notification on the transport but never surfaced
    // one, because the channel listener registers off this capability.
    const h = await harness();
    const caps = h.mcpClient.getServerCapabilities();
    expect(caps?.experimental?.["claude/channel"]).toEqual({});
    expect(caps?.tools).toBeDefined();
  });

  test("send() before start() throws", async () => {
    const { client } = fakeMessagingClient();
    const agent = createClaudeChannelsAgent({
      client,
      allowOutbound: async () => {},
      downloadsDir: "/tmp/unused",
    });
    expect(agent.send("dm:c1", { text: "x" })).rejects.toThrow("before start()");
  });

  test("reply tool posts via the messaging client with threading", async () => {
    const h = await harness();
    const result = await h.callTool("reply", {
      channel_id: "c1",
      text: "hi",
      reply_to: "root1",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("sent-1");
    expect(h.calls.sendMessage![0]).toEqual(["c1", { text: "hi", threadId: "root1", files: undefined }]);
  });

  test("every tool is gated by allowOutbound (prompt-injection boundary)", async () => {
    const h = await harness({ denied: ["evil"] });
    for (const [tool, args] of [
      ["reply", { channel_id: "evil", text: "x" }],
      ["edit_message", { channel_id: "evil", message_id: "m", text: "x" }],
      ["react", { channel_id: "evil", message_id: "m", emoji: "eyes" }],
      ["fetch_messages", { channel_id: "evil" }],
      ["download_attachment", { channel_id: "evil", attachment_id: "f1" }],
    ] as const) {
      const result = await h.callTool(tool, args as Record<string, unknown>);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not allowed");
    }
    expect(h.calls.sendMessage).toBeUndefined();
  });

  test("outbound rate limit trips per channel", async () => {
    const h = await harness({ rateMax: 2 });
    await h.callTool("reply", { channel_id: "c1", text: "1" });
    await h.callTool("reply", { channel_id: "c1", text: "2" });
    const third = await h.callTool("reply", { channel_id: "c1", text: "3" });
    expect(third.isError).toBe(true);
    expect(third.content[0].text).toContain("rate limit");
    // A different channel has its own window.
    const other = await h.callTool("reply", { channel_id: "c2", text: "ok" });
    expect(other.isError).toBeUndefined();
  });

  test("reply uploads local files (capped at 5)", async () => {
    const h = await harness();
    const filePath = join(h.dir, "note.txt");
    writeFileSync(filePath, "file body");
    const result = await h.callTool("reply", { channel_id: "c1", text: "with file", files: [filePath] });
    expect(result.isError).toBeUndefined();
    const [, message] = h.calls.sendMessage![0] as [string, { files: { name: string; data: Uint8Array }[] }];
    expect(message.files).toHaveLength(1);
    expect(message.files[0]!.name).toBe("note.txt");
    expect(new TextDecoder().decode(message.files[0]!.data)).toBe("file body");

    const tooMany = await h.callTool("reply", {
      channel_id: "c1",
      text: "x",
      files: [filePath, filePath, filePath, filePath, filePath, filePath],
    });
    expect(tooMany.isError).toBe(true);
  });

  test("fetch_messages renders ids, threads, and attachments", async () => {
    const h = await harness();
    const result = await h.callTool("fetch_messages", { channel_id: "c1", limit: 10 });
    expect(result.content[0].text).toContain("hello");
    expect(result.content[0].text).toContain("<m1>");
    expect(result.content[0].text).toContain("f1 (a.pdf)");
    expect(h.calls.fetchMessages![0]![1]).toEqual({ limit: 10, threadId: undefined });
  });

  test("download_attachment saves with a sanitized, id-prefixed name", async () => {
    const h = await harness();
    const result = await h.callTool("download_attachment", {
      channel_id: "c1",
      attachment_id: "f1",
    });
    expect(result.isError).toBeUndefined();
    const path = /saved to (\S+)/.exec(result.content[0].text)![1]!;
    expect(path).toContain("evil.pdf");
    expect(path).not.toContain(".."); // traversal stripped
    expect(readFileSync(path, "utf-8")).toBe("hello");
    expect(result.content[0].text).toContain("untrusted sender input");
  });

  test("oversized attachments are refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "channels-agent-"));
    const { client } = fakeMessagingClient();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const agent = createClaudeChannelsAgent({
      client,
      allowOutbound: async () => {},
      downloadsDir: join(dir, "dl"),
      maxFileBytes: 3, // smaller than the 5-byte fake payload
      connectGraceMs: 0,
      transport: serverTransport,
    });
    const mcpClient = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await agent.start();
    await mcpClient.connect(clientTransport);
    const result = (await mcpClient.callTool({
      name: "download_attachment",
      arguments: { channel_id: "c1", attachment_id: "f1" },
    })) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("cap");
  });

  test("tools are listed for the session", async () => {
    const h = await harness();
    const { tools } = await h.mcpClient.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "download_attachment",
      "edit_message",
      "fetch_messages",
      "react",
      "reply",
    ]);
  });
});
