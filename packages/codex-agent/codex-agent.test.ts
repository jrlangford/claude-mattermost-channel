import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createCodexAgent, type CodexLike, type ThreadLike } from "./codex-agent.ts";

// A scripted fake Codex: records start/resume calls and every prompt run.
function fakeCodex(responses: string[] = ["ok"]) {
  const calls: { started: number; resumed: string[]; prompts: string[] } = {
    started: 0,
    resumed: [],
    prompts: [],
  };
  let nextThreadId = 0;
  const makeThread = (id: string | null): ThreadLike => ({
    id,
    async run(prompt: string) {
      calls.prompts.push(prompt);
      const response = responses[Math.min(calls.prompts.length - 1, responses.length - 1)]!;
      return { finalResponse: response };
    },
  });
  const codex: CodexLike = {
    startThread() {
      calls.started++;
      return makeThread(`thread-${++nextThreadId}`);
    },
    resumeThread(id: string) {
      calls.resumed.push(id);
      return makeThread(id);
    },
  };
  return { codex, calls };
}

function agentIn(dir: string, codex: CodexLike, over: object = {}) {
  return createCodexAgent({ stateDir: dir, codex, ...over });
}

describe("createCodexAgent", () => {
  test("declares turn-mode traits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-agent-"));
    const agent = agentIn(dir, fakeCodex().codex);
    expect(agent.mode).toBe("codex");
    expect(agent.needsLocalFiles).toBe(true);
  });

  test("first send starts a thread, runs the rendered prompt, persists the id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-agent-"));
    const { codex, calls } = fakeCodex(["hello back"]);
    const agent = agentIn(dir, codex);
    await agent.start();

    const reply = await agent.send("dm:c1", {
      text: "hi codex",
      meta: { chat_id: "c1", sender: "ivan (u1)" },
    });
    expect(reply).toEqual({ text: "hello back" });
    expect(calls.started).toBe(1);
    expect(calls.prompts[0]).toContain("You are Codex connected");
    expect(calls.prompts[0]).toContain("- chat_id: c1");
    expect(calls.prompts[0]).toEndWith("Message:\nhi codex");

    const store = JSON.parse(readFileSync(join(dir, "codex-threads.json"), "utf-8"));
    expect(store["dm:c1"].id).toBe("thread-1");
  });

  test("same conversation reuses the in-memory thread; no resume round-trip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-agent-"));
    const { codex, calls } = fakeCodex();
    const agent = agentIn(dir, codex);
    await agent.start();
    await agent.send("dm:c1", { text: "one" });
    await agent.send("dm:c1", { text: "two" });
    expect(calls.started).toBe(1);
    expect(calls.resumed).toEqual([]);
  });

  test("a fresh agent resumes from the persisted id (restart survival)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-agent-"));
    const first = fakeCodex();
    const agent1 = agentIn(dir, first.codex);
    await agent1.start();
    await agent1.send("dm:c1", { text: "one" });

    const second = fakeCodex();
    const agent2 = agentIn(dir, second.codex);
    await agent2.start();
    await agent2.send("dm:c1", { text: "two" });
    expect(second.calls.resumed).toEqual(["thread-1"]);
    expect(second.calls.started).toBe(0);
  });

  test("idle-expired stored threads start fresh instead of resuming", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-agent-"));
    const file = join(dir, "codex-threads.json");
    writeFileSync(
      file,
      JSON.stringify({ "dm:c1": { id: "stale", lastUsedAt: Date.now() - 100 * 3600_000 } })
    );
    const { codex, calls } = fakeCodex();
    const agent = agentIn(dir, codex, { threadMaxIdleHours: 72 });
    await agent.start();
    await agent.send("dm:c1", { text: "hello again" });
    expect(calls.resumed).toEqual([]);
    expect(calls.started).toBe(1);
  });

  test("distinct conversations get distinct threads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-agent-"));
    const { codex, calls } = fakeCodex();
    const agent = agentIn(dir, codex);
    await agent.start();
    await agent.send("dm:c1", { text: "a" });
    await agent.send("channel:c2:thread:t1", { text: "b" });
    expect(calls.started).toBe(2);
  });

  test("empty turn returns the notice instead of silence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-agent-"));
    const agent = agentIn(dir, fakeCodex(["   "]).codex);
    await agent.start();
    const reply = await agent.send("dm:c1", { text: "hm" });
    expect(reply!.text).toContain("without producing a response");

    const custom = agentIn(dir, fakeCodex([""]).codex, { emptyTurnNotice: "(silence)" });
    expect((await custom.send("dm:c2", { text: "hm" }))!.text).toBe("(silence)");
  });

  test("files render into the prompt with paths and errors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-agent-"));
    const { codex, calls } = fakeCodex();
    const agent = agentIn(dir, codex);
    await agent.start();
    await agent.send("dm:c1", {
      text: "see file",
      files: [
        { name: "a.pdf", path: "/tmp/a.pdf", mimeType: "application/pdf", size: 9 },
        { name: "b.bin", error: "too large" },
      ],
    });
    expect(calls.prompts[0]).toContain("- a.pdf (application/pdf, 9 bytes): /tmp/a.pdf");
    expect(calls.prompts[0]).toContain("- b.bin: not available (too large)");
  });

  test("a throwing turn propagates (leave-unread semantics are the caller's)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-agent-"));
    const codex: CodexLike = {
      startThread: () => ({
        id: null,
        run: async () => {
          throw new Error("turn exploded");
        },
      }),
      resumeThread: () => {
        throw new Error("unused");
      },
    };
    const agent = agentIn(dir, codex);
    await agent.start();
    expect(agent.send("dm:c1", { text: "x" })).rejects.toThrow("turn exploded");
  });
});
