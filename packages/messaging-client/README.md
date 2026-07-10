# messaging-client

Backend-neutral contract for messaging tools. Consumers program against
`MessagingClient`; an adapter per backend (Mattermost, Slack, Matrix, ...)
implements it, so swapping the messaging tool is plug-and-play.

```
consumer (bridge/agent)
        │  types.ts + client.ts (this package — no runtime deps)
        ▼
MessagingClient  ◄── defineMessagingClient(config => client)
        ▲
        │ implemented by
   mattermost / slack / matrix adapters (separate packages)
```

## The contract

- **Types** (`types.ts`) — `Message`, `Channel`, `User`, `Attachment`,
  `OutgoingMessage`, `ChannelReadState`, event map. All ids are opaque
  strings; `raw` is the only backend-specific escape hatch.
- **Client** (`client.ts`) — lifecycle (`connect`/`disconnect`/`on`),
  identity (`self`), messaging (`sendMessage`/`editMessage`/reactions/
  `sendTyping?`), reads (`getMessage`/`fetchMessages`/`getUser`/
  `getChannel`/`listChannels`), read state (`markRead`/`getReadState`),
  attachments (`getAttachment`/`downloadAttachment`).
- **Errors** — adapters normalize into `MessagingClientError` with a
  portable `code` (`rate_limited` carries `retryAfterMs`).
- **Defining a client** — an adapter exports
  `defineMessagingClient((config: MyConfig) => client)`; config shapes are
  adapter-specific by design.

## Design decisions

| Decision | Why |
|----------|-----|
| Message ops take `(channelId, messageId)` | Slack keys on `(channel, ts)`, Matrix on `(roomId, eventId)` — bare message-id lookup isn't portable. |
| Emoji as shortcodes (`"eyes"`, no colons) | Native for Mattermost/Slack; Matrix adapter maps to unicode. |
| Adapter owns reconnect/heartbeat | `connect()` once; backoff and pings are transport detail, surfaced via `connected`/`disconnected` events. |
| `listChannels()` is flat | Mattermost teams / Slack workspaces / Matrix spaces are adapter-internal grouping. |
| Optional features = optional methods | `client.sendTyping?.(...)` — presence is the capability check (Slack bots can't type). |
| Uploads are data-based (`Uint8Array`) | Path-based uploads assume a shared filesystem; callers read files themselves. |
| Timestamps are ms epoch | Adapters normalize (Slack's seconds-float `ts`, Matrix `origin_server_ts`). |

## Backend mapping notes

| Concept | Mattermost | Slack | Matrix |
|---------|-----------|-------|--------|
| Channel | channel (via teams) | conversation | room |
| Thread root | `root_id` | `thread_ts` | `m.thread` relation |
| Edit | update post | `chat.update` | `m.replace` |
| Reaction | name | name | unicode annotation |
| Typing | supported | **not for bots** | supported |
| Mark read | view channel | `conversations.mark` | read marker |
| Events | WebSocket | Socket Mode | `/sync` |

## Caveat carried from the Mattermost bridge

`fetchMessages({ since })` is defined as *created-or-updated after* —
Mattermost's `?since=` filters on `update_at`. Catch-up consumers must apply
their own create-time cutoff (the `bot` core filters on `createdAt`) to
avoid redelivering edited/re-touched posts.
