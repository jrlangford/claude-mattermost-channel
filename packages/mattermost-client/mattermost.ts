// Mattermost adapter for the messaging-client contract.
//
// Transport only: REST calls, the WebSocket event stream, reconnect backoff,
// and heartbeat. Delivery policy — dedup, catch-up cutoffs, read-receipt
// sequencing, retry-on-view — stays with consumers; this file's job is to be
// a faithful, thin mapping onto Mattermost's API. Ported from the transport
// layer of the Claude/Codex bridge servers.

import {
  MessagingClientError,
  defineMessagingClient,
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
  attachmentFromMM,
  type MMFileInfo,
  channelFromMM,
  flattenPostList,
  postToMessage,
  userFromMM,
  type MMChannel,
  type MMPost,
  type MMPostList,
  type MMUser,
} from "./convert.ts";

export type MattermostConfig = {
  /** Server base URL, e.g. https://mattermost.example.com */
  url: string;
  /** Bot personal access token. */
  token: string;
  /**
   * Protocol-level WebSocket ping interval, ms. 0/undefined disables. Needed
   * for remote agents: when a host sleeps, the socket goes half-open (server
   * FIN never arrives) and only a missed pong reveals it. If no pong arrives
   * within 2× the interval, the socket is force-closed and the normal
   * reconnect backoff runs.
   */
  heartbeatIntervalMs?: number;
};

const INITIAL_RECONNECT_MS = 5_000;
const MAX_RECONNECT_MS = 5 * 60_000;
const CACHE_CAP = 500;
// Mattermost rejects posts with more than 5 attachments.
const MAX_FILES_PER_POST = 5;

// Simple capped map — evicts oldest entry when cap is reached.
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

export const createMattermostClient = defineMessagingClient<MattermostConfig>((config) => {
  const url = config.url.replace(/\/+$/, "");

  // -- event emitter -------------------------------------------------------

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
        console.error("mattermost-client: event handler threw:", err);
      }
    }
  }

  // -- REST ------------------------------------------------------------------

  async function errorFromResponse(res: Response, path: string): Promise<MessagingClientError> {
    let detail = "";
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) detail = `: ${body.message}`;
    } catch {}
    const retryAfterHeader = res.headers.get("Retry-After");
    const retryAfterMs = retryAfterHeader ? parseInt(retryAfterHeader) * 1000 : undefined;
    return new MessagingClientError(
      codeFromStatus(res.status),
      `mattermost ${path} failed (${res.status})${detail}`,
      { retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : undefined }
    );
  }

  async function api(path: string, init?: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${url}/api/v4${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${config.token}`,
          "Content-Type": "application/json",
          ...init?.headers,
        },
      });
    } catch (err) {
      throw new MessagingClientError("network", `mattermost ${path} request failed`, {
        cause: err,
      });
    }
    if (!res.ok) throw await errorFromResponse(res, path);
    return res;
  }

  const apiJson = async <T>(path: string, init?: RequestInit): Promise<T> =>
    (await api(path, init)).json() as Promise<T>;

  // Multipart upload — raw fetch, not api(): the JSON Content-Type default
  // would clobber the multipart boundary fetch sets from the FormData body.
  async function uploadFile(channelId: ChannelId, file: FileUpload): Promise<string> {
    const form = new FormData();
    form.append("channel_id", channelId);
    form.append("files", new Blob([file.data], { type: file.mimeType }), file.name);
    let res: Response;
    try {
      res = await fetch(`${url}/api/v4/files`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.token}` },
        body: form,
      });
    } catch (err) {
      throw new MessagingClientError("network", "mattermost file upload request failed", {
        cause: err,
      });
    }
    if (!res.ok) throw await errorFromResponse(res, "/files");
    const data = (await res.json()) as { file_infos?: MMFileInfo[] };
    const id = data.file_infos?.[0]?.id;
    if (!id) throw new MessagingClientError("unknown", "mattermost file upload returned no file id");
    return id;
  }

  // -- caches ----------------------------------------------------------------

  const userCache = new Map<UserId, User>();
  const channelCache = new Map<ChannelId, Channel>();
  let selfUser: User | null = null;

  async function self(): Promise<User> {
    if (!selfUser) selfUser = userFromMM(await apiJson<MMUser>("/users/me"));
    return selfUser;
  }

  // -- WebSocket lifecycle -----------------------------------------------------

  let ws: WebSocket | null = null;
  let stopped = false;
  let started = false;
  let reconnectDelay = INITIAL_RECONNECT_MS;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function clearHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function openSocket(onFirstOpen?: () => void): void {
    const socket = new WebSocket(url.replace(/^http/, "ws") + "/api/v4/websocket");
    ws = socket;

    socket.addEventListener("open", () => {
      reconnectDelay = INITIAL_RECONNECT_MS; // reset backoff on successful connection
      socket.send(
        JSON.stringify({
          seq: 1,
          action: "authentication_challenge",
          data: { token: config.token },
        })
      );

      const interval = config.heartbeatIntervalMs ?? 0;
      if (interval > 0) {
        clearHeartbeat();
        let lastPong = Date.now();
        // "pong" is a Bun-specific WebSocket event (protocol-level pong
        // frames), paired with the ws.ping() extension below.
        socket.addEventListener("pong", () => {
          lastPong = Date.now();
        });
        heartbeatTimer = setInterval(() => {
          if (Date.now() - lastPong > interval * 2) {
            console.error("mattermost-client: heartbeat timeout — forcing reconnect");
            socket.close();
            return;
          }
          // ws.ping() is a Bun-specific extension (not in the standard
          // WebSocket API). The server responds with a pong frame.
          if (socket.readyState === WebSocket.OPEN) (socket as any).ping();
        }, interval);
      }

      onFirstOpen?.();
      onFirstOpen = undefined;
      emit("connected", undefined);
    });

    socket.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(
          typeof event.data === "string" ? event.data : String(event.data)
        );
        if (msg.event !== "posted") return;
        const post = JSON.parse(msg.data.post) as MMPost;
        // The posted broadcast carries structured mentions as a JSON-encoded
        // array of user ids — surface them instead of text-matching.
        let mentions: string[] | undefined;
        if (typeof msg.data.mentions === "string") {
          try {
            const parsed = JSON.parse(msg.data.mentions);
            if (Array.isArray(parsed)) mentions = parsed.filter((m) => typeof m === "string");
          } catch {}
        }
        emit("message", postToMessage(post, mentions));
      } catch (err) {
        emit("error", err);
      }
    });

    socket.addEventListener("close", () => {
      clearHeartbeat();
      if (stopped) {
        emit("disconnected", { willReconnect: false });
        return;
      }
      console.error(
        `mattermost-client: WebSocket closed, reconnecting in ${reconnectDelay / 1000}s...`
      );
      emit("disconnected", { willReconnect: true });
      reconnectTimer = setTimeout(() => openSocket(onFirstOpen), reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_MS);
    });

    socket.addEventListener("error", (err) => {
      emit("error", err);
    });
  }

  // -- the client -------------------------------------------------------------

  return {
    backend: "mattermost",

    connect(): Promise<void> {
      if (stopped) {
        return Promise.reject(
          new MessagingClientError("invalid_request", "client was disconnected — create a new one")
        );
      }
      if (started) return Promise.resolve();
      started = true;
      // Resolves on the first successful open; reconnect attempts continue
      // behind the scenes on the normal backoff if the first try fails.
      return new Promise((resolve) => openSocket(resolve));
    },

    async disconnect(): Promise<void> {
      stopped = true;
      clearHeartbeat();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      try {
        ws?.close();
      } catch {}
      ws = null;
    },

    on,

    self,

    async sendMessage(channelId: ChannelId, message: OutgoingMessage): Promise<Message> {
      const files = message.files ?? [];
      if (files.length > MAX_FILES_PER_POST) {
        throw new MessagingClientError(
          "invalid_request",
          `mattermost allows at most ${MAX_FILES_PER_POST} files per message (got ${files.length})`
        );
      }
      const fileIds: string[] = [];
      for (const file of files) fileIds.push(await uploadFile(channelId, file));

      const body: Record<string, string | string[]> = {
        channel_id: channelId,
        message: message.text,
      };
      if (message.threadId) body.root_id = message.threadId;
      if (fileIds.length > 0) body.file_ids = fileIds;
      const post = await apiJson<MMPost>("/posts", {
        method: "POST",
        body: JSON.stringify(body),
      });
      return postToMessage(post);
    },

    async editMessage(_channelId: ChannelId, messageId: MessageId, text: string): Promise<Message> {
      const post = await apiJson<MMPost>(`/posts/${messageId}/patch`, {
        method: "PUT",
        body: JSON.stringify({ message: text }),
      });
      return postToMessage(post);
    },

    async addReaction(_channelId: ChannelId, messageId: MessageId, emoji: string): Promise<void> {
      const me = await self();
      await api("/reactions", {
        method: "POST",
        body: JSON.stringify({ user_id: me.id, post_id: messageId, emoji_name: emoji }),
      });
    },

    async removeReaction(_channelId: ChannelId, messageId: MessageId, emoji: string): Promise<void> {
      await api(`/users/me/posts/${messageId}/reactions/${emoji}`, { method: "DELETE" });
    },

    async sendTyping(channelId: ChannelId): Promise<void> {
      await api("/users/me/typing", {
        method: "POST",
        body: JSON.stringify({ channel_id: channelId }),
      });
    },

    async getMessage(channelId: ChannelId, messageId: MessageId): Promise<Message> {
      const post = await apiJson<MMPost>(`/posts/${messageId}`);
      // Portable semantics: on backends that key messages by (channel, id),
      // a wrong channel is simply not found — mirror that here.
      if (post.channel_id !== channelId) {
        throw new MessagingClientError(
          "not_found",
          `message ${messageId} is not in channel ${channelId}`
        );
      }
      return postToMessage(post);
    },

    async fetchMessages(
      channelId: ChannelId,
      options?: FetchMessagesOptions
    ): Promise<Message[]> {
      const { limit, since, threadId } = options ?? {};
      let list: MMPostList;
      if (threadId) {
        list = await apiJson<MMPostList>(`/posts/${threadId}/thread`);
      } else if (since !== undefined) {
        // Reminder: Mattermost's `since` filters on update_at, not create_at
        // (documented on FetchMessagesOptions) — cutoffs are consumer policy.
        list = await apiJson<MMPostList>(`/channels/${channelId}/posts?since=${since}`);
      } else {
        list = await apiJson<MMPostList>(`/channels/${channelId}/posts?per_page=${limit ?? 50}`);
      }
      const messages = flattenPostList(list);
      // Newest window, returned oldest-first.
      return limit !== undefined && messages.length > limit ? messages.slice(-limit) : messages;
    },

    async getUser(userId: UserId): Promise<User> {
      const cached = userCache.get(userId);
      if (cached) return cached;
      const user = userFromMM(await apiJson<MMUser>(`/users/${userId}`));
      cappedSet(userCache, userId, user, CACHE_CAP);
      return user;
    },

    async getChannel(channelId: ChannelId): Promise<Channel> {
      const cached = channelCache.get(channelId);
      if (cached) return cached;
      const channel = channelFromMM(await apiJson<MMChannel>(`/channels/${channelId}`));
      cappedSet(channelCache, channelId, channel, CACHE_CAP);
      return channel;
    },

    async listChannels(): Promise<Channel[]> {
      // Teams are Mattermost-internal grouping (flattened per the contract).
      // DMs/group DMs come back in every team's listing — dedupe by id.
      const teams = await apiJson<{ id: string }[]>("/users/me/teams");
      const seen = new Map<ChannelId, Channel>();
      for (const team of teams) {
        const channels = await apiJson<MMChannel[]>(`/users/me/teams/${team.id}/channels`);
        for (const ch of channels) {
          if (!seen.has(ch.id)) seen.set(ch.id, channelFromMM(ch));
        }
      }
      return [...seen.values()];
    },

    async markRead(channelId: ChannelId): Promise<void> {
      await api("/channels/members/me/view", {
        method: "POST",
        body: JSON.stringify({ channel_id: channelId }),
      });
    },

    async getReadState(channelId: ChannelId): Promise<ChannelReadState> {
      const [member, unread] = await Promise.all([
        apiJson<{ last_viewed_at: number }>(`/channels/${channelId}/members/me`),
        apiJson<{ msg_count: number }>(`/users/me/channels/${channelId}/unread`).catch(
          () => null
        ),
      ]);
      return {
        lastViewedAt: member.last_viewed_at ?? 0,
        unreadCount: unread?.msg_count,
      };
    },

    async getAttachment(attachmentId: string): Promise<Attachment> {
      return attachmentFromMM(await apiJson<MMFileInfo>(`/files/${attachmentId}/info`));
    },

    async downloadAttachment(attachmentId: string): Promise<Uint8Array> {
      const res = await api(`/files/${attachmentId}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
});
