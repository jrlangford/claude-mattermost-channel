// Conversation identity — ported from the codex bridge's conversationKey():
// DMs are one conversation per channel; group traffic is one conversation
// per thread, where an unthreaded post roots a new thread.

import type { Message } from "messaging-client";

export type Conversation = {
  key: string;
  channelId: string;
  /** Where replies go: thread root, when the conversation lives in one. */
  threadId?: string;
  isDM: boolean;
};

export function conversationKeyFor(
  channelId: string,
  isDM: boolean,
  messageId: string,
  threadId?: string
): string {
  if (isDM) return `dm:${channelId}`;
  return `channel:${channelId}:thread:${threadId || messageId}`;
}

export function conversationFor(message: Message, isDM: boolean): Conversation {
  return {
    key: conversationKeyFor(message.channelId, isDM, message.id, message.threadId),
    channelId: message.channelId,
    // In a group, an unthreaded post starts a thread rooted at itself — the
    // agent's replies should thread under it rather than flood the channel.
    threadId: isDM ? message.threadId : (message.threadId ?? message.id),
    isDM,
  };
}
