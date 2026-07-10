// Zulip adapter for the messaging-client contract.
//
// Transport only, like the sibling adapters: REST calls plus Zulip's
// long-polling event-queue API (register a queue, then GET /events blocks
// until events or a server heartbeat). There is no WebSocket; the poll loop
// plays that role, with the same 5s→5min reconnect backoff as the other
// adapters. Queue expiry (BAD_EVENT_QUEUE_ID) triggers a fresh register.
//
// Zulip-isms handled here (id scheme and topic mapping live in convert.ts):
// - Auth is HTTP Basic (email:api_key); bodies are form-encoded, not JSON.
// - Message content is requested as raw markdown (apply_markdown=false).
// - Uploads are separate POSTs whose returned paths get appended to the
//   message text as markdown links — that's how Zulip attaches files.
// - Read state is per-message "read" flags; there is no channel-level
//   last-viewed timestamp, so getReadState derives one from the newest
//   window of messages and their flags.

import {
  MessagingClientError,
  defineMessagingClient,
  sanitizeFilename,
  type Attachment,
  type Channel,
  type ChannelId,
  type ChannelReadState,
  type FetchMessagesOptions,
  type FileUpload,
  type Message,
  type MessageId,
  type MessagingErrorCode,
  type MessagingEvents,
  type OutgoingMessage,
  type Unsubscribe,
  type User,
  type UserId,
} from "messaging-client";
import {
  channelFromDmId,
  channelFromStream,
  dmChannelId,
  messageFromZulip,
  narrowFor,
  parseChannelId,
  streamChannelId,
  userFromZulip,
  type ZulipMessage,
  type ZulipStream,
  type ZulipUser,
} from "./convert.ts";

export type ZulipConfig = {
  /** Server base URL, e.g. https://zulip.example.com */
  url: string;
  /** Bot email address (Basic-auth username). */
  email: string;
  /** Bot API key (Basic-auth password). */
  apiKey: string;
};

const INITIAL_RECONNECT_MS = 5_000;
const MAX_RECONNECT_MS = 5 * 60_000;
const CACHE_CAP = 500;
// Window scanned when deriving read state / marking read. Zulip has no
// channel-level read pointer, so both operate on the newest N messages.
const READ_WINDOW = 200;

function cappedSet<K, V>(map: Map<K, V>, key: K, value: V, cap: number): void {
  map.set(key, value);
  if (map.size > cap) {
    const first = map.keys().next().value;
    if (first !== undefined) map.delete(first);
  }
}

function codeFromStatus(status: number): MessagingErrorCode {
  switch (status) {
    case 400:
      return "invalid_request";
    case 401:
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 429:
      return "rate_limited";
    default:
      return "unknown";
  }
}

type ZulipErrorBody = { result?: string; msg?: string; code?: string };

export const createZulipClient = defineMessagingClient<ZulipConfig>((config) => {
  const url = config.url.replace(/\/+$/, "");
  const authHeader = `Basic ${Buffer.from(`${config.email}:${config.apiKey}`).toString("base64")}`;

  // -- event emitter ---------------------------------------------------------

  const handlers = new Map<keyof MessagingEvents, Set<(payload: never) => void>>();

  function on<E extends keyof MessagingEvents>(
    event: E,
    handler: (payload: MessagingEvents[E]) => void
  ): Unsubscribe {
    let set = handlers.get(event);
    if (!set) {
      set = new Set();
      handlers.set(event, set);
    }
    set.add(handler as (payload: never) => void);
    return () => set.delete(handler as (payload: never) => void);
  }

  function emit<E extends keyof MessagingEvents>(event: E, payload: MessagingEvents[E]): void {
    const set = handlers.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        (handler as (payload: MessagingEvents[E]) => void)(payload);
      } catch (err) {
        console.error("zulip-client: event handler threw:", err);
      }
    }
  }

  // -- REST --------------------------------------------------------------------

  async function errorFromResponse(res: Response, path: string): Promise<MessagingClientError> {
    let detail = "";
    let apiCode: string | undefined;
    try {
      const body = (await res.json()) as ZulipErrorBody;
      if (body?.msg) detail = `: ${body.msg}`;
      apiCode = body?.code;
    } catch {}
    const retryAfterHeader = res.headers.get("Retry-After");
    const retryAfterMs = retryAfterHeader ? parseFloat(retryAfterHeader) * 1000 : undefined;
    const err = new MessagingClientError(
      codeFromStatus(res.status),
      `zulip ${path} failed (${res.status}${apiCode ? ` ${apiCode}` : ""})${detail}`,
      { retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : undefined }
    );
    return err;
  }

  async function api(
    path: string,
    init?: { method?: string; form?: Record<string, string>; query?: Record<string, string>; signal?: AbortSignal }
  ): Promise<Response> {
    const query = init?.query ? `?${new URLSearchParams(init.query)}` : "";
    let res: Response;
    try {
      res = await fetch(`${url}/api/v1${path}${query}`, {
        method: init?.method ?? (init?.form ? "POST" : "GET"),
        headers: { Authorization: authHeader },
        ...(init?.form ? { body: new URLSearchParams(init.form) } : {}),
        ...(init?.signal ? { signal: init.signal } : {}),
      });
    } catch (err) {
      throw new MessagingClientError("network", `zulip ${path} request failed`, { cause: err });
    }
    if (!res.ok) throw await errorFromResponse(res, path);
    return res;
  }

  const apiJson = async <T>(
    path: string,
    init?: { method?: string; form?: Record<string, string>; query?: Record<string, string>; signal?: AbortSignal }
  ): Promise<T> => (await api(path, init)).json() as Promise<T>;

  // -- caches / self -----------------------------------------------------------

  const userCache = new Map<UserId, User>();
  const channelCache = new Map<ChannelId, Channel>();
  let selfUser: User | null = null;

  async function self(): Promise<User> {
    if (!selfUser) selfUser = userFromZulip(await apiJson<ZulipUser>("/users/me"));
    return selfUser;
  }

  // -- message fetch helpers -----------------------------------------------------

  type FetchedMessage = ZulipMessage & { flags?: string[] };

  async function getMessagesWindow(
    channelId: ChannelId,
    options: { topic?: string; limit: number }
  ): Promise<FetchedMessage[]> {
    const data = await apiJson<{ messages: FetchedMessage[] }>("/messages", {
      query: {
        anchor: "newest",
        num_before: String(options.limit),
        num_after: "0",
        narrow: JSON.stringify(narrowFor(channelId, options.topic)),
        apply_markdown: "false",
      },
    });
    return data.messages; // oldest-first already
  }

  // -- long-poll event loop --------------------------------------------------------

  let stopped = false;
  let started = false;
  let reconnectDelay = INITIAL_RECONNECT_MS;
  let pollAbort: AbortController | null = null;
  let queueId: string | null = null;
  let lastEventId = -1;
  let longpollTimeoutMs = 105_000;

  async function registerQueue(): Promise<void> {
    const data = await apiJson<{
      queue_id: string;
      last_event_id: number;
      event_queue_longpoll_timeout_seconds?: number;
    }>("/register", {
      form: { event_types: JSON.stringify(["message"]), apply_markdown: "false" },
    });
    queueId = data.queue_id;
    lastEventId = data.last_event_id;
    // Give the server's own timeout a buffer; heartbeats arrive within it.
    longpollTimeoutMs = ((data.event_queue_longpoll_timeout_seconds ?? 90) + 15) * 1000;
  }

  type ZulipEvent = { id: number; type: string; message?: FetchedMessage };

  async function pollLoop(onFirstConnect?: () => void): Promise<void> {
    while (!stopped) {
      try {
        if (!queueId) {
          await registerQueue();
          reconnectDelay = INITIAL_RECONNECT_MS;
          onFirstConnect?.();
          onFirstConnect = undefined;
          emit("connected", undefined);
        }
        pollAbort = new AbortController();
        const timer = setTimeout(() => pollAbort?.abort(), longpollTimeoutMs);
        let data: { events: ZulipEvent[] };
        try {
          data = await apiJson<{ events: ZulipEvent[] }>("/events", {
            query: { queue_id: queueId!, last_event_id: String(lastEventId) },
            signal: pollAbort.signal,
          });
        } finally {
          clearTimeout(timer);
          pollAbort = null;
        }
        for (const event of data.events) {
          if (event.id > lastEventId) lastEventId = event.id;
          if (event.type === "message" && event.message) {
            try {
              emit("message", messageFromZulip(event.message));
            } catch (err) {
              emit("error", err);
            }
          }
        }
      } catch (err) {
        if (stopped) break;
        // Expired/unknown queue: re-register immediately (fresh "connected").
        if (err instanceof MessagingClientError && err.message.includes("BAD_EVENT_QUEUE_ID")) {
          queueId = null;
          emit("disconnected", { willReconnect: true, error: err });
          continue;
        }
        emit("disconnected", { willReconnect: true, error: err });
        console.error(
          `zulip-client: event poll failed, retrying in ${reconnectDelay / 1000}s...`,
          err instanceof Error ? err.message : err
        );
        await new Promise((r) => setTimeout(r, reconnectDelay));
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_MS);
        // A long-dead connection usually means the queue is gone too.
        queueId = null;
      }
    }
  }

  // -- uploads -------------------------------------------------------------------

  async function uploadFile(file: FileUpload): Promise<{ path: string; name: string }> {
    const form = new FormData();
    form.append(
      "filename",
      new Blob([file.data], { type: file.mimeType ?? "application/octet-stream" }),
      file.name
    );
    let res: Response;
    try {
      res = await fetch(`${url}/api/v1/user_uploads`, {
        method: "POST",
        headers: { Authorization: authHeader },
        body: form,
      });
    } catch (err) {
      throw new MessagingClientError("network", "zulip file upload request failed", { cause: err });
    }
    if (!res.ok) throw await errorFromResponse(res, "/user_uploads");
    const data = (await res.json()) as { url?: string; uri?: string; filename?: string };
    const path = data.url ?? data.uri;
    if (!path) throw new MessagingClientError("unknown", "zulip file upload returned no url");
    // Markdown-breaking brackets in the label would corrupt the link.
    const label = (data.filename ?? file.name).replaceAll("[", "(").replaceAll("]", ")");
    return { path, name: label };
  }

  // -- the client ------------------------------------------------------------------

  return {
    backend: "zulip",

    connect(): Promise<void> {
      if (stopped) {
        return Promise.reject(
          new MessagingClientError("invalid_request", "client was disconnected — create a new one")
        );
      }
      if (started) return Promise.resolve();
      started = true;
      return new Promise((resolve, reject) => {
        // Resolve on the first successful register; the loop then owns
        // reconnects. A first-register failure keeps retrying like the
        // sibling adapters, so surface only fatal loop exits.
        void pollLoop(resolve).catch(reject);
      });
    },

    async disconnect(): Promise<void> {
      stopped = true;
      pollAbort?.abort();
      if (queueId) {
        // Best-effort queue cleanup; the server expires it anyway.
        await api("/events", { method: "DELETE", query: { queue_id: queueId } }).catch(() => {});
        queueId = null;
      }
      emit("disconnected", { willReconnect: false });
    },

    on,

    self,

    async sendMessage(channelId: ChannelId, message: OutgoingMessage): Promise<Message> {
      let text = message.text;
      for (const file of message.files ?? []) {
        const uploaded = await uploadFile(file);
        text += `\n[${uploaded.name}](${uploaded.path})`;
      }

      const parsed = parseChannelId(channelId);
      let form: Record<string, string>;
      if (parsed.kind === "stream") {
        form = {
          type: "stream",
          to: String(parsed.streamId),
          // Topics are the thread mapping; "" lands in the default topic.
          topic: message.threadId ?? "",
          content: text,
        };
      } else {
        const me = await self();
        const others = parsed.userIds.filter((id) => String(id) !== me.id);
        form = {
          type: "direct",
          // Self-DMs send to yourself; everything else omits self.
          to: JSON.stringify(others.length > 0 ? others : parsed.userIds),
          content: text,
        };
      }
      const sent = await apiJson<{ id: number }>("/messages", { form });
      const me = await self();
      return {
        id: String(sent.id),
        channelId,
        senderId: me.id,
        text,
        createdAt: Date.now(),
        ...(parsed.kind === "stream" && message.threadId ? { threadId: message.threadId } : {}),
      };
    },

    async editMessage(channelId: ChannelId, messageId: MessageId, text: string): Promise<Message> {
      await api(`/messages/${messageId}`, { method: "PATCH", form: { content: text } });
      const data = await apiJson<{ message: ZulipMessage }>(`/messages/${messageId}`, {
        query: { apply_markdown: "false" },
      });
      const message = messageFromZulip(data.message);
      if (message.channelId !== channelId) {
        throw new MessagingClientError(
          "not_found",
          `message ${messageId} is not in channel ${channelId}`
        );
      }
      return message;
    },

    async addReaction(_channelId: ChannelId, messageId: MessageId, emoji: string): Promise<void> {
      await api(`/messages/${messageId}/reactions`, { form: { emoji_name: emoji } });
    },

    async removeReaction(_channelId: ChannelId, messageId: MessageId, emoji: string): Promise<void> {
      await api(`/messages/${messageId}/reactions`, {
        method: "DELETE",
        form: { emoji_name: emoji },
      });
    },

    async getMessage(channelId: ChannelId, messageId: MessageId): Promise<Message> {
      const data = await apiJson<{ message: ZulipMessage }>(`/messages/${messageId}`, {
        query: { apply_markdown: "false" },
      });
      const message = messageFromZulip(data.message);
      if (message.channelId !== channelId) {
        throw new MessagingClientError(
          "not_found",
          `message ${messageId} is not in channel ${channelId}`
        );
      }
      return message;
    },

    async fetchMessages(channelId: ChannelId, options?: FetchMessagesOptions): Promise<Message[]> {
      const { limit, since, threadId } = options ?? {};
      const fetchLimit = since !== undefined ? Math.max(limit ?? 50, 100) : (limit ?? 50);
      const wire = await getMessagesWindow(channelId, { topic: threadId, limit: fetchLimit });
      let messages = wire.map(messageFromZulip);
      if (since !== undefined) {
        // Zulip timestamps are whole seconds; floor the cutoff to the second
        // so a message sent later within the cutoff's second isn't dropped.
        // Over-delivery is fine — catch-up consumers dedup (bot core does).
        const cutoff = since - (since % 1000);
        messages = messages.filter((m) => Math.max(m.createdAt, m.editedAt ?? 0) >= cutoff);
      }
      return limit !== undefined && messages.length > limit ? messages.slice(-limit) : messages;
    },

    async getUser(userId: UserId): Promise<User> {
      const cached = userCache.get(userId);
      if (cached) return cached;
      const data = await apiJson<{ user: ZulipUser }>(`/users/${userId}`);
      const user = userFromZulip(data.user);
      cappedSet(userCache, userId, user, CACHE_CAP);
      return user;
    },

    async getChannel(channelId: ChannelId): Promise<Channel> {
      const cached = channelCache.get(channelId);
      if (cached) return cached;
      const parsed = parseChannelId(channelId);
      const channel =
        parsed.kind === "stream"
          ? channelFromStream(
              (await apiJson<{ stream: ZulipStream }>(`/streams/${parsed.streamId}`)).stream
            )
          : channelFromDmId(channelId);
      cappedSet(channelCache, channelId, channel, CACHE_CAP);
      return channel;
    },

    async listChannels(): Promise<Channel[]> {
      // Streams the bot is subscribed to, plus DM conversations synthesized
      // from the newest DM window — Zulip has no DM-conversation listing.
      const subs = await apiJson<{ subscriptions: ZulipStream[] }>("/users/me/subscriptions");
      const channels = new Map<ChannelId, Channel>();
      for (const stream of subs.subscriptions) {
        const channel = channelFromStream(stream);
        channels.set(channel.id, channel);
      }
      const dms = await apiJson<{ messages: ZulipMessage[] }>("/messages", {
        query: {
          anchor: "newest",
          num_before: "100",
          num_after: "0",
          narrow: JSON.stringify([{ operator: "is", operand: "dm" }]),
          apply_markdown: "false",
        },
      });
      for (const msg of dms.messages) {
        try {
          const id = messageFromZulip(msg).channelId;
          if (!channels.has(id)) channels.set(id, channelFromDmId(id));
        } catch {}
      }
      return [...channels.values()];
    },

    async markRead(channelId: ChannelId): Promise<void> {
      await api("/messages/flags/narrow", {
        form: {
          anchor: "newest",
          num_before: String(READ_WINDOW),
          num_after: "0",
          include_anchor: "true",
          narrow: JSON.stringify(narrowFor(channelId)),
          op: "add",
          flag: "read",
        },
      });
    },

    async getReadState(channelId: ChannelId): Promise<ChannelReadState> {
      // No channel-level read pointer in Zulip: derive one from the newest
      // window — the newest message carrying the "read" flag.
      const messages = await getMessagesWindow(channelId, { limit: READ_WINDOW });
      let lastViewedAt = 0;
      let unreadCount = 0;
      for (const msg of messages) {
        if (msg.flags?.includes("read")) {
          lastViewedAt = Math.max(lastViewedAt, msg.timestamp * 1000);
        } else {
          unreadCount += 1;
        }
      }
      return { lastViewedAt, unreadCount };
    },

    async getAttachment(attachmentId: string): Promise<Attachment> {
      // The id is a /user_uploads/... path; Zulip has no metadata endpoint,
      // so probe the signed URL for size/type (best-effort).
      const name = sanitizeFilename(attachmentId.split("/").pop() ?? "file");
      try {
        const signed = await apiJson<{ url: string }>(
          `/user_uploads/${attachmentId.replace(/^\/user_uploads\//, "")}`
        );
        const head = await fetch(`${url}${signed.url}`, { method: "HEAD" });
        const size = head.headers.get("Content-Length");
        const mimeType = head.headers.get("Content-Type");
        return {
          id: attachmentId,
          name,
          ...(size ? { size: Number(size) } : {}),
          ...(mimeType ? { mimeType } : {}),
        };
      } catch {
        return { id: attachmentId, name };
      }
    },

    async downloadAttachment(attachmentId: string): Promise<Uint8Array> {
      // Exchange the path for a temporary signed URL (API auth doesn't work
      // on the raw /user_uploads path itself), then fetch that.
      const signed = await apiJson<{ url: string }>(
        `/user_uploads/${attachmentId.replace(/^\/user_uploads\//, "")}`
      );
      let res: Response;
      try {
        res = await fetch(`${url}${signed.url}`);
      } catch (err) {
        throw new MessagingClientError("network", "zulip attachment download failed", {
          cause: err,
        });
      }
      if (!res.ok) throw await errorFromResponse(res, signed.url);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
});
