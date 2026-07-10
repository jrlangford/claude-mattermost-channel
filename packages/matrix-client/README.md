# matrix-client

Matrix adapter for the [`messaging-client`](../messaging-client/README.md)
contract, built on [`matrix-js-sdk`](https://github.com/matrix-org/matrix-js-sdk).
The sdk's sync loop is the event stream (it owns reconnect backoff
internally); everything else is REST. **E2E encryption is out of scope** —
rooms must be unencrypted for the bot to read them.

```ts
import { createMatrixClient } from "matrix-client";

const client = createMatrixClient({
  baseUrl: "https://matrix.example.com",
  accessToken: "<bot access token>",
  userId: "@bot:example.com",
});

client.on("message", (msg) => console.log(msg.senderId, msg.text));
await client.connect(); // resolves on first successful sync

await client.sendMessage(roomId, { text: "hello", threadId });
```

## Contract mapping

| Contract concept | Matrix realization |
|------------------|--------------------|
| ChannelId / UserId / MessageId | room id / MXID / event id |
| AttachmentId | the `mxc://` URL |
| `threadId` | `m.thread` relation |
| `editMessage` | `m.replace` event, but the returned Message keeps the **original** id |
| Reactions | `m.annotation` with a unicode key — shortcodes ("eyes") map via a built-in table, unicode passes through, unknown names fall back to the raw string (round-trips, renders as text) |
| `kind: "dm"` | the `m.direct` account-data map (client convention; `group_dm` is not modeled) |
| `markRead` / `getReadState` | `m.read` receipt on the latest event; the receipt's `ts` is `lastViewedAt`, `unreadCount` from sync notification counts |
| `fetchMessages({since})` | backward pagination until the timestamp is crossed (bounded at 5×100 events — `/messages` has no timestamp filter) |
| Media | authenticated media endpoints (Synapse 1.11+ defaults); `getAttachment` HEADs for type/size — the filename lives on the message event, not the media |
| `sendMessage` with files | one media event per file (Matrix has no multi-attachment messages), then the text event; the returned Message is the text event when text is non-empty |

- **Live events only**: history replayed during initial sync / pagination is
  never emitted as `message` (the documented `liveEvent` recipe); `m.replace`
  edit events are filtered out.
- **Errors** normalize to `MessagingClientError` (`M_LIMIT_EXCEEDED` →
  `rate_limited` with `retryAfterMs`, `M_UNKNOWN_TOKEN`/`M_FORBIDDEN` →
  `forbidden`, 404/`M_NOT_FOUND` → `not_found`).
- **Files**: `convert.ts` (pure wire-format mapping, unit-tested) and
  `matrix.ts` (sdk wiring + I/O).

## Testing

- `bun test` — unit tests over the pure conversion layer (no network).
- `bun run test:integration` — full contract surface against a **real
  Synapse** via docker compose (`integration/`). Host needs docker only:
  synapse (sqlite, tmpfs, config generated at startup with open registration
  and rate limits disabled) + an `oven/bun` container running
  `integration.test.ts` on the compose network. Bootstrap is pure REST
  (register users, DM + public rooms, `m.direct`). Ephemeral (`down -v`
  around each run); `KEEP=1` keeps the stack up. Tests auto-skip unless
  `MX_IT_URL` is set.
