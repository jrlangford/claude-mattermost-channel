// Matrix adapter for the messaging-client contract, on matrix-js-sdk.
//
// Transport only: the sdk's sync loop is the event stream (it owns reconnect
// backoff internally), REST for everything else. E2E encryption is out of
// scope — rooms must be unencrypted for the bot to read them.
//
// Contract mapping notes:
// - AttachmentId is the mxc:// URL; downloads go through the authenticated
//   media endpoint (required by Synapse 1.11+ defaults).
// - editMessage sends an m.replace event but returns the Message under its
//   ORIGINAL id — consumers keep referring to the id they know, matching how
//   the other backends behave.
// - markRead/getReadState use m.read receipts; a receipt's ts is "when the
//   bot marked it read", which is exactly the contract's lastViewedAt.
// - DM detection reads the m.direct account-data map (client convention).

import {
  ClientEvent,
  Direction,
  EventType,
  MatrixError,
  MatrixEvent,
  NotificationCountType,
  RoomEvent,
  SyncState,
  createClient,
  type IEvent,
  type MatrixClient,
  type Room,
} from "matrix-js-sdk";
import {
  MessagingClientError,
  defineMessagingClient,
  type Attachment,
  type Channel,
  type ChannelId,
  type ChannelReadState,
  type FetchMessagesOptions,
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
  emojiFromShortcode,
  eventToMessage,
  eventsToMessages,
  isMessageEvent,
  kindFromRoom,
  localpart,
  msgtypeForMime,
  parseMxc,
  type MatrixRawEvent,
} from "./convert.ts";

export type MatrixConfig = {
  /** Homeserver base URL, e.g. https://matrix.example.com */
  baseUrl: string;
  accessToken: string;
  /** The bot's full MXID, e.g. @bot:example.com */
  userId: string;
  deviceId?: string;
};

// The sdk logs every sync tick at info via loglevel; keep only errors. The
// runtime logger has setLevel (loglevel) even though the type doesn't.
import { logger as sdkLogger } from "matrix-js-sdk/lib/logger.js";
(sdkLogger as unknown as { setLevel?: (level: string) => void }).setLevel?.("error");

// How far back a `since` fetch will paginate before giving up (pages × 100).
const SINCE_MAX_PAGES = 5;

function toClientError(err: unknown, what: string): MessagingClientError {
  if (err instanceof MessagingClientError) return err;
  if (err instanceof MatrixError) {
    let code: MessagingErrorCode = "unknown";
    if (err.isRateLimitError()) code = "rate_limited";
    else if (err.httpStatus === 404 || err.errcode === "M_NOT_FOUND") code = "not_found";
    else if (
      err.httpStatus === 401 ||
      err.httpStatus === 403 ||
      err.errcode === "M_FORBIDDEN" ||
      err.errcode === "M_UNKNOWN_TOKEN"
    ) {
      code = "forbidden";
    } else if (err.httpStatus === 400) code = "invalid_request";
    return new MessagingClientError(code, `matrix ${what} failed: ${err.message}`, {
      cause: err,
      retryAfterMs: err.getRetryAfterMs() ?? undefined,
    });
  }
  if (err instanceof TypeError || (err as Error)?.name === "ConnectionError") {
    return new MessagingClientError("network", `matrix ${what} request failed`, { cause: err });
  }
  return new MessagingClientError("unknown", `matrix ${what} failed: ${err}`, { cause: err });
}

export const createMatrixClient = defineMessagingClient<MatrixConfig>((config) => {
  const client: MatrixClient = createClient({
    baseUrl: config.baseUrl.replace(/\/+$/, ""),
    accessToken: config.accessToken,
    userId: config.userId,
    deviceId: config.deviceId,
  });

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
        console.error("matrix-client: event handler threw:", err);
      }
    }
  }

  const wrap = async <T>(what: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw toClientError(err, what);
    }
  };

  // -- lifecycle --------------------------------------------------------------

  let started = false;
  let stopped = false;

  client.on(RoomEvent.Timeline, (event, _room, toStartOfTimeline, _removed, data) => {
    // The documented live-event recipe: skip pagination and non-live sync
    // catch-up so history is never replayed as fresh messages. Local echoes
    // of our own sends (status != null) are skipped too — they carry a
    // temporary id; the reconciled copy surfaces via LocalEchoUpdated below.
    if (toStartOfTimeline || !data?.liveEvent) return;
    if (event.status !== null) return;
    const raw = event.getEffectiveEvent() as MatrixRawEvent;
    if (!isMessageEvent(raw)) return;
    emit("message", eventToMessage(raw));
  });

  client.on(RoomEvent.LocalEchoUpdated, (event, _room, _oldEventId, oldStatus) => {
    // Own sends never re-fire Timeline with their final id — the sdk
    // reconciles the server copy into the local echo in place. Emit exactly
    // once, when reconciliation completes (status → null): the event then
    // has its real id and server timestamp. Keeps the contract's
    // "own messages are emitted too; consumers filter" true on Matrix.
    if (event.status !== null || oldStatus == null) return;
    const raw = event.getEffectiveEvent() as MatrixRawEvent;
    if (!isMessageEvent(raw)) return;
    emit("message", eventToMessage(raw));
  });

  client.on(ClientEvent.Sync, (state, prevState) => {
    if (state === SyncState.Error) {
      emit("disconnected", { willReconnect: true });
    } else if (
      (state === SyncState.Syncing || state === SyncState.Catchup) &&
      (prevState === SyncState.Error || prevState === SyncState.Reconnecting)
    ) {
      emit("connected", undefined); // recovered — mirror reconnect semantics
    }
  });

  function connect(): Promise<void> {
    if (stopped) {
      return Promise.reject(
        new MessagingClientError("invalid_request", "client was disconnected — create a new one")
      );
    }
    if (started) return Promise.resolve();
    started = true;
    return wrap("connect", async () => {
      const prepared = new Promise<void>((resolve, reject) => {
        const onSync = (state: SyncState) => {
          if (state === SyncState.Prepared) {
            client.removeListener(ClientEvent.Sync, onSync);
            resolve();
          } else if (state === SyncState.Error && !client.isInitialSyncComplete()) {
            // Initial sync failing usually means bad token/URL — surface it
            // instead of retrying forever behind a pending promise.
            client.removeListener(ClientEvent.Sync, onSync);
            reject(new Error("initial sync failed"));
          }
        };
        client.on(ClientEvent.Sync, onSync);
      });
      await client.startClient({ initialSyncLimit: 0 });
      await prepared;
      emit("connected", undefined);
    });
  }

  async function disconnect(): Promise<void> {
    stopped = true;
    client.stopClient();
    emit("disconnected", { willReconnect: false });
  }

  // -- helpers ----------------------------------------------------------------

  async function fetchRaw(roomId: ChannelId, eventId: MessageId): Promise<MatrixRawEvent> {
    return (await client.fetchRoomEvent(roomId, eventId)) as MatrixRawEvent;
  }

  function directRoomIds(): Set<string> {
    const content = client.getAccountData(EventType.Direct)?.getContent() as
      | Record<string, string[]>
      | undefined;
    return new Set(Object.values(content ?? {}).flat());
  }

  function roomToChannel(room: Room): Channel {
    return {
      id: room.roomId,
      kind: kindFromRoom({
        isDirect: directRoomIds().has(room.roomId),
        joinRule: room.getJoinRule(),
      }),
      name: room.name || undefined,
    };
  }

  function mediaUrl(attachmentId: string): string {
    const mxc = parseMxc(attachmentId);
    if (!mxc) {
      throw new MessagingClientError(
        "invalid_request",
        `matrix attachment id must be an mxc:// URL (got ${attachmentId})`
      );
    }
    return `${config.baseUrl.replace(/\/+$/, "")}/_matrix/client/v1/media/download/${mxc.server}/${mxc.mediaId}`;
  }

  async function fetchMedia(attachmentId: string, method: "GET" | "HEAD"): Promise<Response> {
    const res = await fetch(mediaUrl(attachmentId), {
      method,
      headers: { Authorization: `Bearer ${config.accessToken}` },
    });
    if (!res.ok) {
      throw new MessagingClientError(
        res.status === 404 ? "not_found" : res.status === 403 ? "forbidden" : "unknown",
        `matrix media ${method} failed (${res.status})`
      );
    }
    return res;
  }

  const threadRelation = (threadId: MessageId) => ({
    "m.relates_to": { rel_type: "m.thread", event_id: threadId },
  });

  // -- the client -------------------------------------------------------------

  return {
    backend: "matrix",

    connect,
    disconnect,
    on,

    async self(): Promise<User> {
      const profile = await wrap("self", () =>
        client.getProfileInfo(config.userId).catch(() => ({}) as { displayname?: string })
      );
      return {
        id: config.userId,
        username: localpart(config.userId),
        displayName: profile.displayname || undefined,
      };
    },

    async sendMessage(channelId: ChannelId, message: OutgoingMessage): Promise<Message> {
      return wrap("sendMessage", async () => {
        // Matrix has no multi-attachment messages: each file is its own
        // media event, sent before the text. The returned Message is the
        // text event when there is text, else the last media event.
        let lastEventId: string | null = null;
        const relates = message.threadId ? threadRelation(message.threadId) : {};
        for (const file of message.files ?? []) {
          const upload = await client.uploadContent(file.data, {
            name: file.name,
            type: file.mimeType,
          });
          const res = await client.sendEvent(channelId, "m.room.message" as any, {
            msgtype: msgtypeForMime(file.mimeType),
            body: file.name,
            url: upload.content_uri,
            info: { mimetype: file.mimeType, size: file.data.byteLength },
            ...relates,
          } as any);
          lastEventId = res.event_id;
        }
        if (message.text || !lastEventId) {
          const res = await client.sendEvent(channelId, "m.room.message" as any, {
            msgtype: "m.text",
            body: message.text,
            ...relates,
          } as any);
          lastEventId = res.event_id;
        }
        return eventToMessage(await fetchRaw(channelId, lastEventId));
      });
    },

    async editMessage(channelId: ChannelId, messageId: MessageId, text: string): Promise<Message> {
      return wrap("editMessage", async () => {
        const res = await client.sendEvent(channelId, "m.room.message" as any, {
          msgtype: "m.text",
          body: `* ${text}`,
          "m.new_content": { msgtype: "m.text", body: text },
          "m.relates_to": { rel_type: "m.replace", event_id: messageId },
        } as any);
        const [original, replacement] = await Promise.all([
          fetchRaw(channelId, messageId),
          fetchRaw(channelId, res.event_id),
        ]);
        // The logical message keeps its original id; only text/editedAt move.
        return {
          ...eventToMessage(original),
          text,
          editedAt: replacement.origin_server_ts,
        };
      });
    },

    async addReaction(channelId: ChannelId, messageId: MessageId, emoji: string): Promise<void> {
      await wrap("addReaction", () =>
        client.sendEvent(channelId, "m.reaction" as any, {
          "m.relates_to": {
            rel_type: "m.annotation",
            event_id: messageId,
            key: emojiFromShortcode(emoji),
          },
        } as any)
      );
    },

    async removeReaction(channelId: ChannelId, messageId: MessageId, emoji: string): Promise<void> {
      await wrap("removeReaction", async () => {
        const key = emojiFromShortcode(emoji);
        const { events } = await client.relations(channelId, messageId, "m.annotation", "m.reaction");
        const mine = events.find(
          (ev) =>
            ev.getSender() === config.userId &&
            (ev.getContent() as any)["m.relates_to"]?.key === key
        );
        if (!mine?.getId()) {
          throw new MessagingClientError(
            "not_found",
            `no ${emoji} reaction by ${config.userId} on ${messageId}`
          );
        }
        await client.redactEvent(channelId, mine.getId()!);
      });
    },

    async sendTyping(channelId: ChannelId): Promise<void> {
      await wrap("sendTyping", () => client.sendTyping(channelId, true, 10_000));
    },

    async getMessage(channelId: ChannelId, messageId: MessageId): Promise<Message> {
      return wrap("getMessage", async () => eventToMessage(await fetchRaw(channelId, messageId)));
    },

    async fetchMessages(
      channelId: ChannelId,
      options?: FetchMessagesOptions
    ): Promise<Message[]> {
      return wrap("fetchMessages", async () => {
        const { limit, since, threadId } = options ?? {};
        if (threadId) {
          const { events } = await client.relations(channelId, threadId, "m.thread", null, {
            dir: Direction.Forward,
          });
          const raws = events.map((ev) => ev.getEffectiveEvent() as MatrixRawEvent);
          const root = await fetchRaw(channelId, threadId);
          const messages = eventsToMessages([root, ...raws]);
          return limit !== undefined && messages.length > limit ? messages.slice(-limit) : messages;
        }
        if (since !== undefined) {
          // /messages has no timestamp filter — paginate backward until we
          // cross `since` (bounded), keep what's newer.
          const collected: MatrixRawEvent[] = [];
          let from: string | null = null;
          for (let page = 0; page < SINCE_MAX_PAGES; page++) {
            const res = await client.createMessagesRequest(
              channelId,
              from,
              100,
              Direction.Backward
            );
            const chunk = (res.chunk ?? []) as unknown as MatrixRawEvent[];
            collected.push(...chunk.filter((ev) => (ev.origin_server_ts ?? 0) > since));
            const crossed = chunk.some((ev) => (ev.origin_server_ts ?? 0) <= since);
            if (crossed || !res.end || chunk.length === 0) break;
            from = res.end;
          }
          const messages = eventsToMessages(collected);
          return limit !== undefined && messages.length > limit ? messages.slice(-limit) : messages;
        }
        const res = await client.createMessagesRequest(
          channelId,
          null,
          limit ?? 50,
          Direction.Backward
        );
        return eventsToMessages((res.chunk ?? []) as unknown as MatrixRawEvent[]);
      });
    },

    async getUser(userId: UserId): Promise<User> {
      return wrap("getUser", async () => {
        const profile = await client.getProfileInfo(userId);
        return {
          id: userId,
          username: localpart(userId),
          displayName: profile.displayname || undefined,
        };
      });
    },

    async getChannel(channelId: ChannelId): Promise<Channel> {
      return wrap("getChannel", async () => {
        const room = client.getRoom(channelId);
        if (!room) {
          throw new MessagingClientError("not_found", `matrix room ${channelId} not in sync store`);
        }
        return roomToChannel(room);
      });
    },

    async listChannels(): Promise<Channel[]> {
      return wrap("listChannels", async () =>
        client
          .getRooms()
          .filter((room) => room.getMyMembership() === "join")
          .map(roomToChannel)
      );
    },

    async markRead(channelId: ChannelId): Promise<void> {
      await wrap("markRead", async () => {
        const room = client.getRoom(channelId);
        let latest: MatrixEvent | undefined = room
          ?.getLiveTimeline()
          .getEvents()
          .at(-1);
        if (!latest) {
          const res = await client.createMessagesRequest(channelId, null, 1, Direction.Backward);
          const raw = res.chunk?.[0];
          if (!raw) return; // empty room — nothing to mark
          latest = new MatrixEvent(raw as Partial<IEvent>);
        }
        // Both the receipt AND the m.fully_read marker: receipts only reach
        // a client through /sync, so a freshly restarted bot can't see its
        // own receipt yet — the marker is room account data it can always
        // read back (see getReadState), which is what keeps a restart from
        // replaying already-answered history.
        await client.setRoomReadMarkers(channelId, latest.getId()!, latest);
      });
    },

    async getReadState(channelId: ChannelId): Promise<ChannelReadState> {
      return wrap("getReadState", async () => {
        const room = client.getRoom(channelId);
        const receipt = room?.getReadReceiptForUserId(config.userId);
        let lastViewedAt = receipt?.data?.ts ?? 0;
        if (lastViewedAt <= 0) {
          // Fresh client: the receipt isn't in the sync store yet. Fall back
          // to the m.fully_read marker (store first, then REST) and use the
          // marked event's server timestamp as the read cutoff.
          let markerEventId = (
            room?.getAccountData("m.fully_read" as never)?.getContent() as
              | { event_id?: string }
              | undefined
          )?.event_id;
          if (!markerEventId) {
            const res = await fetch(
              `${config.baseUrl.replace(/\/+$/, "")}/_matrix/client/v3/user/${encodeURIComponent(
                config.userId
              )}/rooms/${encodeURIComponent(channelId)}/account_data/m.fully_read`,
              { headers: { Authorization: `Bearer ${config.accessToken}` } }
            );
            if (res.ok) {
              markerEventId = ((await res.json()) as { event_id?: string }).event_id;
            }
          }
          if (markerEventId) {
            try {
              lastViewedAt = (await fetchRaw(channelId, markerEventId)).origin_server_ts ?? 0;
            } catch {
              // marker points at an event we can't fetch — treat as unread
            }
          }
        }
        return {
          lastViewedAt,
          unreadCount: room?.getUnreadNotificationCount(NotificationCountType.Total),
        };
      });
    },

    async getAttachment(attachmentId: string): Promise<Attachment> {
      return wrap("getAttachment", async () => {
        // mxc URLs carry no metadata; HEAD the media for type/size. The
        // filename lives on the message event, not the media — undefined here.
        const res = await fetchMedia(attachmentId, "HEAD");
        const length = res.headers.get("Content-Length");
        return {
          id: attachmentId,
          mimeType: res.headers.get("Content-Type") ?? undefined,
          size: length ? parseInt(length) : undefined,
        };
      });
    },

    async downloadAttachment(attachmentId: string): Promise<Uint8Array> {
      return wrap("downloadAttachment", async () => {
        const res = await fetchMedia(attachmentId, "GET");
        return new Uint8Array(await res.arrayBuffer());
      });
    },
  };
});
