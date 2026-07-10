// bot — the write-once bot core: composes a MessagingClient (transport) with
// an Agent (the AI side) and owns the bot logic both hand-written bridges
// shared: access gating/pairing, dedup, unread catch-up, per-conversation
// queues, delivery-gated read receipts, reply routing.

export {
  MAX_PAIR_REPLIES,
  MAX_PENDING,
  PAIR_EXPIRY_MS,
  createOutboundGuard,
  gate,
  pruneExpired,
  readAccess,
  saveAccess,
  type Access,
  type GateParams,
  type GateResult,
  type GroupPolicy,
  type OutboundGuard,
  type PendingEntry,
} from "./access.ts";
export { createBot, type Bot, type BotConfig } from "./bot.ts";
export { conversationFor, conversationKeyFor, type Conversation } from "./conversation.ts";
