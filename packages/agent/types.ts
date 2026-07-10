// Types for the agent abstraction — "something you can converse with".
// Deliberately free of messaging vocabulary: no channels, threads, senders,
// or chat attachments. The BOT layer (which sees both this contract and
// messaging-client) renders messages into AgentInput and routes replies.

/**
 * One unit of input for an agent, within a conversation identified by the
 * caller's key. Everything is already rendered/resolved by the caller.
 */
export type AgentInput = {
  /** The user's message text — untrusted remote input, always. */
  text: string;
  /** Files accompanying the input, localized to disk by the caller. */
  files?: AgentFile[];
  /**
   * Opaque context from the caller, rendered verbatim where a mode needs it
   * (prompt metadata block, notification meta). Implementations don't
   * interpret the keys; callers choose them.
   */
  meta?: Record<string, string>;
};

/** A file handed to an agent. Either `path` (on local disk) or `error`
 *  (why it isn't) is set — a failed file is reported, not dropped. */
export type AgentFile = {
  name: string;
  path?: string;
  mimeType?: string;
  size?: number;
  error?: string;
};

/**
 * What a send() produced, for the caller to route back to the conversation.
 * `null` means there is nothing to route — either the mode replies out of
 * band (session modes) or it chose silence. A turn mode that wants "no
 * response" surfaced returns its own notice text instead of null.
 */
export type AgentReply = {
  text: string;
};
