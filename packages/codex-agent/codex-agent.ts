// codex-agent — turn-based Agent implementation on @openai/codex-sdk.
// Ported from the codex bridge's turn logic (codex-server.ts): one Codex
// thread per conversation key, persisted with idle expiry so long-dead
// conversations start fresh instead of resuming a stale thread with its
// full context re-sent.
//
// Per the agent contract, this mode does NOT queue: the caller serializes
// send() per conversation and routes the returned reply. An empty turn
// still returns a notice — consuming input with no visible reply would be a
// silent swallow. A failed turn throws, leaving the source unread for
// at-least-once redelivery.

import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { Codex, type CodexOptions, type ThreadOptions } from "@openai/codex-sdk";
import {
  createIdleStore,
  defineAgent,
  renderPrompt,
  type AgentInput,
} from "agent";

/** Structural slice of the Codex SDK this agent uses — lets tests inject a fake. */
export type CodexLike = {
  startThread(options?: ThreadOptions): ThreadLike;
  resumeThread(id: string, options?: ThreadOptions): ThreadLike;
};

export type ThreadLike = {
  id: string | null;
  run(input: string): Promise<{ finalResponse: string }>;
};

export type CodexAgentConfig = {
  /** Directory for persistent state (codex-threads.json). */
  stateDir: string;
  /** Codex SDK constructor options (apiKey, baseUrl, codexPathOverride, config). */
  codexOptions?: CodexOptions;
  /** Options applied to every thread (model, sandboxMode, workingDirectory, ...). */
  threadOptions?: ThreadOptions;
  /** Idle hours after which a stored thread is abandoned (default 72; 0 disables). */
  threadMaxIdleHours?: number;
  /** Reply text for a turn that produced no response. */
  emptyTurnNotice?: string;
  /** Injected Codex instance (tests); defaults to `new Codex(codexOptions)`. */
  codex?: CodexLike;
};

const DEFAULT_IDLE_HOURS = 72;
const DEFAULT_EMPTY_NOTICE = "Codex completed this turn without producing a response.";

export const createCodexAgent = defineAgent<CodexAgentConfig>((config) => {
  const codex: CodexLike = config.codex ?? new Codex(config.codexOptions ?? {});
  const maxIdleMs = (config.threadMaxIdleHours ?? DEFAULT_IDLE_HOURS) * 60 * 60 * 1000;
  const store = createIdleStore({
    file: join(config.stateDir, "codex-threads.json"),
    maxIdleMs,
  });

  // In-memory Thread handles (the SDK object carries live state); the store
  // only persists ids for resumption across restarts. The in-memory cache
  // honors the same idle expiry — a weeks-long process must not resume a
  // thread the store would already consider stale.
  const threads = new Map<string, { thread: ThreadLike; lastUsedAt: number }>();

  const idleExpired = (lastUsedAt: number): boolean =>
    maxIdleMs > 0 && Date.now() - lastUsedAt > maxIdleMs;

  function getThread(key: string): ThreadLike {
    const cached = threads.get(key);
    if (cached && !idleExpired(cached.lastUsedAt)) {
      cached.lastUsedAt = Date.now();
      return cached.thread;
    }
    const savedId = store.get(key); // undefined when absent or idle-expired
    const thread = savedId
      ? codex.resumeThread(savedId, config.threadOptions)
      : codex.startThread(config.threadOptions);
    threads.set(key, { thread, lastUsedAt: Date.now() });
    return thread;
  }

  return {
    mode: "codex",
    needsLocalFiles: true, // Codex has no tool surface back into the bot

    async start(): Promise<void> {
      if (!existsSync(config.stateDir)) {
        mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
      }
    },

    async send(conversationKey: string, input: AgentInput) {
      const thread = getThread(conversationKey);
      const turn = await thread.run(renderPrompt(input, { agentName: "Codex" }));
      if (thread.id) store.set(conversationKey, thread.id);

      const text = turn.finalResponse.trim() || (config.emptyTurnNotice ?? DEFAULT_EMPTY_NOTICE);
      return { text };
    },

    async stop(): Promise<void> {
      threads.clear();
    },
  };
});
