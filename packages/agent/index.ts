// agent — "something you can converse with": the AI side of a bot, as the
// counterpart of messaging-client (the chat-network side). Pure contract +
// common code; mode implementations live in their own packages
// (codex-agent, claude-code-sdk-agent, claude-channels-agent).

export { defineAgent, type Agent, type AgentFactory } from "./agent.ts";
export { renderPrompt, type RenderPromptOptions } from "./prompt.ts";
export { createIdleStore, type IdleStore } from "./store.ts";
export type { AgentFile, AgentInput, AgentReply } from "./types.ts";
