import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeCodeSdkAgent, type QueryLike } from "./claude-code-sdk-agent.ts";

type Call = { prompt: string; options?: Options };

/** A scripted fake query(): records calls, yields init + a result message. */
function fakeQuery(script: {
  sessionId?: string;
  result?: { subtype?: string; result?: string; is_error?: boolean } | null;
}) {
  const calls: Call[] = [];
  const queryFn: QueryLike = (params) => {
    calls.push(params);
    return (async function* () {
      yield {
        type: "system",
        subtype: "init",
        session_id: script.sessionId ?? "sess-1",
      } as any;
      if (script.result !== null) {
        yield {
          type: "result",
          subtype: script.result?.subtype ?? "success",
          is_error: script.result?.is_error ?? false,
          result: script.result?.result ?? "hi there",
          session_id: script.sessionId ?? "sess-1",
        } as any;
      }
    })();
  };
  return { queryFn, calls };
}

describe("createClaudeCodeSdkAgent", () => {
  test("declares turn-mode traits", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccsdk-"));
    const agent = createClaudeCodeSdkAgent({ stateDir: dir, queryFn: fakeQuery({}).queryFn });
    expect(agent.mode).toBe("claude-code-sdk");
    expect(agent.needsLocalFiles).toBe(true);
  });

  test("runs the rendered prompt and returns the result text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccsdk-"));
    const { queryFn, calls } = fakeQuery({ result: { result: "hello back" } });
    const agent = createClaudeCodeSdkAgent({ stateDir: dir, queryFn });
    await agent.start();

    const reply = await agent.send("dm:c1", {
      text: "hi claude",
      meta: { chat_id: "c1" },
    });
    expect(reply).toEqual({ text: "hello back" });
    expect(calls[0]!.prompt).toContain("You are Claude connected");
    expect(calls[0]!.prompt).toContain("- chat_id: c1");
    expect(calls[0]!.options?.resume).toBeUndefined();
  });

  test("persists the session id and resumes it on the next send", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccsdk-"));
    const { queryFn, calls } = fakeQuery({ sessionId: "sess-42" });
    const agent = createClaudeCodeSdkAgent({ stateDir: dir, queryFn });
    await agent.start();

    await agent.send("dm:c1", { text: "one" });
    const store = JSON.parse(readFileSync(join(dir, "claude-sessions.json"), "utf-8"));
    expect(store["dm:c1"].id).toBe("sess-42");

    await agent.send("dm:c1", { text: "two" });
    expect(calls[1]!.options?.resume).toBe("sess-42");
  });

  test("distinct conversations do not share sessions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccsdk-"));
    const { queryFn, calls } = fakeQuery({ sessionId: "sess-a" });
    const agent = createClaudeCodeSdkAgent({ stateDir: dir, queryFn });
    await agent.start();
    await agent.send("dm:c1", { text: "one" });
    await agent.send("dm:c2", { text: "two" });
    expect(calls[1]!.options?.resume).toBeUndefined();
  });

  test("caller queryOptions pass through; resume is still managed here", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccsdk-"));
    const { queryFn, calls } = fakeQuery({ sessionId: "sess-9" });
    const agent = createClaudeCodeSdkAgent({
      stateDir: dir,
      queryFn,
      queryOptions: { model: "claude-sonnet-5", maxTurns: 3 } as Options,
    });
    await agent.start();
    await agent.send("dm:c1", { text: "one" });
    await agent.send("dm:c1", { text: "two" });
    expect(calls[1]!.options).toMatchObject({
      model: "claude-sonnet-5",
      maxTurns: 3,
      resume: "sess-9",
    });
  });

  test("empty result text returns the notice", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccsdk-"));
    const agent = createClaudeCodeSdkAgent({
      stateDir: dir,
      queryFn: fakeQuery({ result: { result: "  " } }).queryFn,
    });
    await agent.start();
    const reply = await agent.send("dm:c1", { text: "hm" });
    expect(reply!.text).toContain("without producing a response");
  });

  test("error results throw (leave-unread semantics), but the session is still remembered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccsdk-"));
    const { queryFn } = fakeQuery({
      sessionId: "sess-err",
      result: { subtype: "error_during_execution", result: "" },
    });
    const agent = createClaudeCodeSdkAgent({ stateDir: dir, queryFn });
    await agent.start();
    expect(agent.send("dm:c1", { text: "x" })).rejects.toThrow("error_during_execution");
    const store = JSON.parse(readFileSync(join(dir, "claude-sessions.json"), "utf-8"));
    expect(store["dm:c1"].id).toBe("sess-err");
  });

  test("a stream with no result message throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccsdk-"));
    const agent = createClaudeCodeSdkAgent({
      stateDir: dir,
      queryFn: fakeQuery({ result: null }).queryFn,
    });
    await agent.start();
    expect(agent.send("dm:c1", { text: "x" })).rejects.toThrow("without a result message");
  });

  test("is_error on a success result also throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccsdk-"));
    const agent = createClaudeCodeSdkAgent({
      stateDir: dir,
      queryFn: fakeQuery({ result: { result: "boom", is_error: true } }).queryFn,
    });
    await agent.start();
    expect(agent.send("dm:c1", { text: "x" })).rejects.toThrow("claude turn failed");
  });
});
