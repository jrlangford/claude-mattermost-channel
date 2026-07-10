// Backend-neutral domain types for messaging tools (Mattermost, Slack,
// Matrix, ...). Adapters translate their wire formats into these shapes at
// the edge; consumers never see a backend-specific field outside `raw`.

// All ids are opaque strings in whatever format the backend uses (Mattermost
// 26-char ids, Slack "C.../U..." ids and "1234.5678" timestamps, Matrix
// "!room:server" / "$event" ids). Consumers must not parse them — only pass
// them back to the client that produced them.
export type ChannelId = string;
export type UserId = string;
export type MessageId = string;
export type AttachmentId = string;

// Collapsed across backends: Mattermost D/G/P/O, Slack im/mpim/private/
// public, Matrix rooms (DM-ness is a client convention there — adapters map
// best-effort). Access-gating logic mostly branches on `dm` vs everything
// else.
export type ChannelKind = "dm" | "group_dm" | "private" | "public";

export type Channel = {
  id: ChannelId;
  kind: ChannelKind;
  name?: string;
};

export type User = {
  id: UserId;
  /** Stable handle used for @-mentions (no leading @). */
  username?: string;
  displayName?: string;
  isBot?: boolean;
};

export type Attachment = {
  id: AttachmentId;
  name?: string;
  /** Bytes, when the backend reports it. */
  size?: number;
  mimeType?: string;
};

export type Message = {
  id: MessageId;
  channelId: ChannelId;
  senderId: UserId;
  /** Plain/markdown text as the backend delivers it. */
  text: string;
  /** ms since epoch (adapters normalize — e.g. Slack's seconds-float ts). */
  createdAt: number;
  editedAt?: number;
  /** Root message of the thread this message belongs to, if threaded. */
  threadId?: MessageId;
  attachments?: Attachment[];
  /**
   * Users explicitly mentioned, when the backend provides structured
   * mentions (Matrix m.mentions, Slack <@U...> tokens). Adapters without
   * structured data may fall back to text matching or omit this.
   */
  mentions?: UserId[];
  /** Backend-specific escape hatch. Never rely on its shape portably. */
  raw?: unknown;
};

/** Outbound file content. Data-based (not path-based) to stay portable. */
export type FileUpload = {
  name: string;
  data: Uint8Array;
  mimeType?: string;
};

export type OutgoingMessage = {
  text: string;
  /** Reply into this thread (root message id). */
  threadId?: MessageId;
  files?: FileUpload[];
};

export type ChannelReadState = {
  /**
   * When the bot last marked this channel read, ms since epoch. <= 0 means
   * never viewed. Note Mattermost's since-fetch matches on update_at, not
   * create_at — catch-up consumers must apply their own create-time cutoff
   * (the bot core does).
   */
  lastViewedAt: number;
  /** Unread message count, when the backend can report it cheaply. */
  unreadCount?: number;
};

export type FetchMessagesOptions = {
  /** Max messages to return (newest window, returned oldest-first). */
  limit?: number;
  /** Only messages created-or-updated after this ms timestamp. */
  since?: number;
  /** Fetch a thread's messages instead (root message id). */
  threadId?: MessageId;
};

export type DisconnectInfo = {
  /** True when the adapter will reconnect on its own (backoff internal). */
  willReconnect: boolean;
  error?: unknown;
};

/** Event map for MessagingClient.on(). */
export type MessagingEvents = {
  /** A new inbound message (including the bot's own — consumers filter). */
  message: Message;
  /** Connection established (fires again after each reconnect). */
  connected: void;
  disconnected: DisconnectInfo;
  error: unknown;
};

export type Unsubscribe = () => void;
