// The agent contract every mode implements. Pure interface — implementations
// live in their own packages and take whatever they need (an SDK, an MCP
// transport, a messaging client) through their own factory config. Known
// modes: codex-agent and claude-code-sdk-agent (turn-based — send() runs a
// turn and returns the final response) and claude-channels-agent (session —
// send() pushes into a live Claude Code session and returns null; replies
// flow out of band through the session's own tool surface).
//
// The delivery contract: send() resolving means "this input is handled" per
// the mode's own criterion — the caller routes any returned reply and only
// then advances its read pointer. send() throwing means the caller leaves
// the source unread, so at-least-once catch-up redelivers later. Modes must
// therefore tolerate redelivery of an already handled input (callers dedup
// in-process, but not across restarts).

import type { AgentInput, AgentReply } from "./types.ts";

export interface Agent {
  /** Mode identifier, e.g. "codex" | "claude-code-sdk" | "claude-channels". */
  readonly mode: string;

  /**
   * True when this mode needs input files ON LOCAL DISK (turn modes — the
   * agent has no way to fetch them itself). The caller then localizes
   * attachments into AgentInput.files before send(). Session modes leave
   * this unset and fetch on demand through their own tools.
   */
  readonly needsLocalFiles?: boolean;

  /** Boot the agent. Called once, before the first send(). */
  start(): Promise<void>;

  /**
   * Handle one input in the given conversation. The caller serializes
   * send() per conversation key — an agent never sees two concurrent turns
   * for the same conversation, but different conversations may run
   * concurrently.
   */
  send(conversationKey: string, input: AgentInput): Promise<AgentReply | null>;

  /** Graceful shutdown (flush queues, close sessions). */
  stop(): Promise<void>;
}

/**
 * A mode is a factory from its own config shape to an Agent — same plug
 * pattern as messaging-client's defineMessagingClient. Config stays
 * mode-specific; portability lives in the returned Agent.
 */
export type AgentFactory<Config> = (config: Config) => Agent;

/** Identity helper: gives modes config-type inference at the plug point. */
export function defineAgent<Config>(factory: AgentFactory<Config>): AgentFactory<Config> {
  return factory;
}
