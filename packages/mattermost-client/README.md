# mattermost-client

Mattermost adapter for the [`messaging-client`](../messaging-client/README.md)
contract. Transport only — REST calls, the WebSocket event stream, reconnect
backoff, and the optional heartbeat. Delivery policy (dedup, catch-up
cutoffs, read-receipt sequencing) stays with consumers.

```ts
import { createMattermostClient } from "mattermost-client";

const client = createMattermostClient({
  url: "https://mattermost.example.com",
  token: "<bot personal access token>",
  heartbeatIntervalMs: 30_000, // optional; for remote agents (half-open sockets)
});

client.on("message", (msg) => console.log(msg.senderId, msg.text));
client.on("connected", () => {/* run unread catch-up here */});
await client.connect();

await client.sendMessage(channelId, { text: "hello", threadId });
```

## Implementation notes

- **Ported from the bridge servers** — auth-challenge WebSocket login,
  exponential reconnect backoff (5s → 5min, reset on success), Bun
  `ws.ping()`-based heartbeat with a 2×-interval pong deadline.
- **`connect()`** resolves on the first successful open and keeps
  reconnecting internally forever after; `disconnect()` is permanent.
- **Mentions** are surfaced from the `posted` broadcast's structured
  `mentions` field (no text matching).
- **Attachment names are sanitized** at the boundary (via
  `mattermost-shared`) — filenames are remote-user input.
- **`listChannels()`** flattens teams and dedupes (DMs appear under every
  team).
- **Errors** are normalized to `MessagingClientError` — HTTP status →
  portable code, `Retry-After` → `retryAfterMs`.
- **Files**: `convert.ts` (pure wire-format mapping, unit-tested) and
  `mattermost.ts` (all I/O).

## Testing

- `bun test` — unit tests over the pure conversion layer (no network).
- `bun run test:integration` — full contract surface against a **real
  Mattermost** via docker compose (`integration/`). Host needs docker only:
  the stack is postgres + mattermost-team-edition + an `oven/bun` container
  that runs `integration.test.ts` on the compose network. The bootstrap
  provisions everything over REST (first user created on a fresh server
  becomes system admin → team, bot + access token, human actor, channels).
  Ephemeral by design (`down -v` around each run); `KEEP=1` keeps the stack
  up for inspection. The tests are auto-skipped unless `MM_IT_URL` is set.
