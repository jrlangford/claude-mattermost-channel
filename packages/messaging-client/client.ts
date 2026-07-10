// The plug-and-play client contract every messaging backend implements.
//
// Design constraints (from surveying Mattermost, Slack, and Matrix):
//
// - Message-scoped operations take (channelId, messageId), never a bare
//   message id: Slack keys everything on (channel, ts) and Matrix on
//   (roomId, eventId), so channel-less lookup is not portable. Consumers
//   that only hold a message id must track its channel themselves.
// - Emoji are shortcode names without colons (e.g. "eyes"). Mattermost and
//   Slack use names natively; the Matrix adapter translates to unicode.
// - The adapter owns its connection: connect() starts the transport and the
//   adapter handles reconnect backoff and heartbeats internally, surfacing
//   lifecycle through events. disconnect() is a permanent stop.
// - Channel enumeration is flat. Mattermost teams, Slack workspaces, and
//   Matrix spaces are adapter-internal grouping — listChannels() returns
//   every channel the bot participates in.
// - Optional capabilities are optional methods (check with `client.x?.()`),
//   not a flags object — e.g. Slack bots cannot send typing indicators.

import type {
  Attachment,
  AttachmentId,
  Channel,
  ChannelId,
  ChannelReadState,
  FetchMessagesOptions,
  Message,
  MessageId,
  MessagingEvents,
  OutgoingMessage,
  Unsubscribe,
  User,
  UserId,
} from "./types.ts";

export interface MessagingClient {
  /** Backend identifier, e.g. "mattermost" | "slack" | "matrix". */
  readonly backend: string;

  // ---- lifecycle ----------------------------------------------------------

  /**
   * Start the transport. Resolves once initially connected; thereafter the
   * adapter reconnects on its own and re-emits "connected".
   */
  connect(): Promise<void>;
  /** Permanently stop the transport (no reconnect). */
  disconnect(): Promise<void>;
  on<E extends keyof MessagingEvents>(
    event: E,
    handler: (payload: MessagingEvents[E]) => void
  ): Unsubscribe;

  // ---- identity -----------------------------------------------------------

  /** The bot's own user (mention detection, self-message filtering). */
  self(): Promise<User>;

  // ---- messaging ----------------------------------------------------------

  sendMessage(channelId: ChannelId, message: OutgoingMessage): Promise<Message>;
  editMessage(channelId: ChannelId, messageId: MessageId, text: string): Promise<Message>;
  addReaction(channelId: ChannelId, messageId: MessageId, emoji: string): Promise<void>;
  removeReaction(channelId: ChannelId, messageId: MessageId, emoji: string): Promise<void>;
  /** Optional: not every backend supports it (Slack bots cannot). */
  sendTyping?(channelId: ChannelId): Promise<void>;

  // ---- reads --------------------------------------------------------------

  getMessage(channelId: ChannelId, messageId: MessageId): Promise<Message>;
  /** Returns oldest-first. */
  fetchMessages(channelId: ChannelId, options?: FetchMessagesOptions): Promise<Message[]>;
  getUser(userId: UserId): Promise<User>;
  getChannel(channelId: ChannelId): Promise<Channel>;
  /** Every channel the bot participates in (grouping hierarchy flattened). */
  listChannels(): Promise<Channel[]>;

  // ---- read state ---------------------------------------------------------

  /** Mark the whole channel read (read receipts are channel-scoped). */
  markRead(channelId: ChannelId): Promise<void>;
  getReadState(channelId: ChannelId): Promise<ChannelReadState>;

  // ---- attachments --------------------------------------------------------

  getAttachment(attachmentId: AttachmentId): Promise<Attachment>;
  downloadAttachment(attachmentId: AttachmentId): Promise<Uint8Array>;
}

// ---- errors ---------------------------------------------------------------

export type MessagingErrorCode =
  | "not_found"
  | "forbidden"
  | "rate_limited"
  | "invalid_request"
  | "network"
  | "unsupported"
  | "unknown";

/**
 * Uniform error surface so consumers can branch on `code` (retry on
 * rate_limited/network, drop on forbidden, ...) without knowing which
 * backend threw. Adapters map their native errors into this.
 */
export class MessagingClientError extends Error {
  readonly code: MessagingErrorCode;
  /** For rate_limited: how long the backend asked us to back off. */
  readonly retryAfterMs?: number;

  constructor(
    code: MessagingErrorCode,
    message: string,
    options?: { cause?: unknown; retryAfterMs?: number }
  ) {
    super(message, { cause: options?.cause });
    this.name = "MessagingClientError";
    this.code = code;
    this.retryAfterMs = options?.retryAfterMs;
  }
}

// ---- defining clients -----------------------------------------------------

/**
 * A backend adapter is just a factory from its own config shape to a
 * MessagingClient. Config is intentionally adapter-specific (Mattermost
 * wants url/token/userId, Matrix wants homeserver/accessToken, ...);
 * portability lives in the returned client, not the config.
 */
export type MessagingClientFactory<Config> = (config: Config) => MessagingClient;

/** Identity helper: gives adapters config-type inference at the plug point. */
export function defineMessagingClient<Config>(
  factory: MessagingClientFactory<Config>
): MessagingClientFactory<Config> {
  return factory;
}
