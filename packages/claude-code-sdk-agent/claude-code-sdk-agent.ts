// claude-code-sdk-agent — turn-based Agent implementation on
// @anthropic-ai/claude-agent-sdk. One Claude session per conversation key,
// resumed via options.resume and persisted with idle expiry (same model as
// codex-agent's threads).
//
// Per the agent contract, this mode does NOT queue: the caller serializes
// send() per conversation and routes the returned reply. An empty result
// still returns a notice; a failed turn (error result, or a stream that
// ends with no result) throws, leaving the source unread for at-least-once
// redelivery.

import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import {
  query,
  type Options,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  createIdleStore,
  defineAgent,
  renderPrompt,
  type AgentInput,
} from "agent";

/** Structural slice of the SDK this agent uses — lets tests inject a fake. */
export type QueryLike = (params: {
  prompt: string;
  options?: Options;
}) => AsyncIterable<SDKMessage>;

export type ClaudeCodeSdkAgentConfig = {
  /** Directory for persistent state (claude-sessions.json). */
  stateDir: string;
  /** SDK query options applied to every turn (model, cwd, permissionMode,
   *  allowedTools, maxTurns, mcpServers, ...). `resume` is managed here. */
  queryOptions?: Options;
  /** Idle hours after which a stored session is abandoned (default 72; 0 disables). */
  sessionMaxIdleHours?: number;
  /** Reply text for a turn that produced no response text. */
  emptyTurnNotice?: string;
  /** Injected query function (tests); defaults to the SDK's query(). */
  queryFn?: QueryLike;
};

const DEFAULT_IDLE_HOURS = 72;
const DEFAULT_EMPTY_NOTICE = "Claude completed this turn without producing a response.";

export const createClaudeCodeSdkAgent = defineAgent<ClaudeCodeSdkAgentConfig>((config) => {
  const runQuery: QueryLike = config.queryFn ?? (query as unknown as QueryLike);
  const maxIdleMs = (config.sessionMaxIdleHours ?? DEFAULT_IDLE_HOURS) * 60 * 60 * 1000;
  const store = createIdleStore({
    file: join(config.stateDir, "claude-sessions.json"),
    maxIdleMs,
  });

  return {
    mode: "claude-code-sdk",
    needsLocalFiles: true, // file contents reach the session as local paths in the prompt

    async start(): Promise<void> {
      if (!existsSync(config.stateDir)) {
        mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
      }
    },

    async send(conversationKey: string, input: AgentInput) {
      const resume = store.get(conversationKey); // undefined when absent/expired
      const stream = runQuery({
        prompt: renderPrompt(input, { agentName: "Claude" }),
        options: { ...config.queryOptions, ...(resume ? { resume } : {}) },
      });

      let sessionId: string | undefined;
      let result: SDKMessage | null = null;
      for await (const message of stream) {
        if ("session_id" in message && typeof message.session_id === "string") {
          sessionId = message.session_id;
        }
        if (message.type === "result") result = message;
      }
      // Remember the session even when the turn failed — the conversation's
      // context exists server-side either way, and resuming it beats
      // replaying a redelivered message into a fresh, amnesiac session.
      if (sessionId) store.set(conversationKey, sessionId);

      if (!result || result.type !== "result") {
        throw new Error("claude turn ended without a result message");
      }
      if (result.subtype !== "success" || result.is_error) {
        throw new Error(`claude turn failed (${result.subtype})`);
      }

      const text = result.result.trim() || (config.emptyTurnNotice ?? DEFAULT_EMPTY_NOTICE);
      return { text };
    },

    async stop(): Promise<void> {},
  };
});
