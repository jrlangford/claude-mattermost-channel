# bot-app

The polymorphic bot: pick one messaging backend and one agent mode in
config, and the [`bot`](../../packages/bot/README.md) core does the rest —
any combination works (codex × mattermost, claude-channels × matrix, ...).

```bash
bun main.ts bot.config.json
```

## Config

```jsonc
{
  "stateDir": "~/.channel-bot",     // access.json, approved/, downloads/, agent state
  "botName": "amelia",             // optional; shown in envelopes (multi-bot)
  "maxFileBytes": 52428800,        // optional attachment cap
  "pairingMessage": "Run `access-cli pair {code}` to approve me.", // optional
  "messaging": {
    "backend": "mattermost",       // or "matrix"
    "url": "https://mm.example.com",
    "token": "..."
    // matrix: { "backend": "matrix", "baseUrl": "...", "accessToken": "...", "userId": "@bot:..." }
  },
  "agent": {
    "mode": "codex"                // or "claude-code-sdk" | "claude-channels"
    // codex:            codexOptions / threadOptions / threadMaxIdleHours
    // claude-code-sdk:  queryOptions / sessionMaxIdleHours
    // claude-channels:  connectGraceMs
  }
}
```

## Modes

- **codex** / **claude-code-sdk** — standalone turn-based bots: run the
  process anywhere; each gated message runs a turn and the final response is
  posted back (threaded in group channels).
- **claude-channels** — this process is an MCP server on stdio for a live
  Claude Code session (the current channel-plugin shape): launch it *from*
  Claude Code; inbound messages surface as channel notifications and the
  session replies through the exposed tools. All logging goes to stderr.

Access control is the same in every combination: pairing codes for unknown
DM senders (approve by writing `<stateDir>/approved/<senderId>` with the
chat id — the access CLI does this), allowlists, opt-in group channels.
Delivery semantics are the bridges' battle-tested ones: at-least-once with
in-process dedup, delivery-gated channel-settled read receipts, and unread
catch-up on every connect.

This app replaces the hand-written `claude-mattermost-channel` and
`codex-mattermost-bridge` servers once it reaches feature parity; both stay
in the repo until then.
