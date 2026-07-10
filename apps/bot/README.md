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
  Claude Code session (the channel-plugin shape): launch it *from* Claude
  Code; inbound messages surface as channel notifications and the session
  replies through the exposed tools. All logging goes to stderr.

## As a Claude Code plugin

This app doubles as a Claude Code channel plugin (`.claude-plugin/`,
`.mcp.json`, `skills/`): the plugin launches `main.ts` with
`BOT_CONFIG=~/.channel-bot/bot.config.json`, which must set
`agent.mode: "claude-channels"`. In-session skills:

- `/channel:configure` — save Mattermost/Matrix credentials into
  `bot.config.json` (0600), show status.
- `/channel:access` — approve pairings, edit allowlists, set DM/group
  policy (edits `<stateDir>/access.json`; the bot re-reads it live).

Dev loop from this repo: `just claude-channel` (loads the plugin via
`--plugin-dir apps/bot`). Note the plugin depends on `workspace:*`
packages, so it must run from a full checkout — a marketplace-installable
bundle needs a publish/bundling step that doesn't exist yet.

Access control is the same in every combination: pairing codes for unknown
DM senders, allowlists, opt-in group channels. Manage it with the CLI:

```bash
BOT_STATE_DIR=~/.channel-bot bun ../../packages/bot/access-cli.ts            # status
BOT_STATE_DIR=~/.channel-bot bun ../../packages/bot/access-cli.ts pair <code>
```

Delivery semantics are the legacy bridges' battle-tested ones: at-least-once
with in-process dedup, delivery-gated channel-settled read receipts, and
unread catch-up on every connect.
