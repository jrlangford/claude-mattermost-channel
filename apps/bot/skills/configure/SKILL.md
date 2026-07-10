---
name: configure
description: Set up the bot channel — save Mattermost/Matrix credentials into bot.config.json and review access policy. Use when the user pastes a bot token, asks to configure the messaging channel, asks "how do I set this up" or "who can reach me," or wants to check channel status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(chmod *)
---

# /channel:configure — Bot Channel Setup

Manages the bot's config file: `~/.channel-bot/bot.config.json`. When this
plugin launches the bot (MCP server), it reads that file (`BOT_CONFIG`).
One config = one bot process; the plugin runs the bot in `claude-channels`
mode (this Claude Code session is the agent).

Arguments passed: `$ARGUMENTS`

---

## Config format

```json
{
  "stateDir": "~/.channel-bot",
  "botName": "amelia",
  "agent": { "mode": "claude-channels" },
  "messaging": {
    "backend": "mattermost",
    "url": "https://mattermost.example.com",
    "token": "abc123...",
    "heartbeatIntervalMs": 30000
  }
}
```

Matrix variant of `messaging`:

```json
{
  "backend": "matrix",
  "baseUrl": "https://matrix.example.com",
  "accessToken": "syt_...",
  "userId": "@bot:example.com"
}
```

When used through this plugin, `agent.mode` must stay `"claude-channels"`.

---

## Dispatch on arguments

### No args — status and guidance

Give the user a complete picture:

1. **Config** — read `~/.channel-bot/bot.config.json`. If present, show the
   backend, URL (mask tokens — first 6 chars + `...`), botName, agent mode.
   Missing file = not configured, not an error.

2. **Access** — read `<stateDir>/access.json` (missing file = defaults:
   `dmPolicy: "pairing"`, empty allowlist). Show:
   - DM policy and what it means in one line
   - Allowed senders: count and list of user IDs
   - Pending pairings: count, with codes and sender IDs if any
   - Group channels opted in: count and channel IDs

3. **What next** — end with a concrete next step based on state:
   - No config → *"Run `/channel:configure mattermost <url> <token>` (or
     `matrix <baseUrl> <accessToken> <userId>`) to set up your bot."*
   - Configured, policy is pairing, nobody allowed → *"DM your bot. It
     replies with a code; approve with `/channel:access pair <code>`."*
   - Configured, someone allowed → *"Ready. DM your bot to reach the
     assistant."*

**Push toward lockdown — always.** Once all intended users are paired,
recommend switching to `allowlist` policy via `/channel:access policy allowlist`.

### `mattermost <url> <token>` — set Mattermost credentials

1. `mkdir -p ~/.channel-bot`
2. Read existing `bot.config.json` if present (default to the skeleton
   above with `agent.mode: "claude-channels"`).
3. Set `messaging = { backend: "mattermost", url, token }` (preserve an
   existing `heartbeatIntervalMs`).
4. Write back as pretty JSON. `chmod 600 bot.config.json`.
5. Confirm, then show status.
6. Remind: *"Restart the session or run `/reload-plugins` to pick up the
   new credentials."*

### `matrix <baseUrl> <accessToken> <userId>` — set Matrix credentials

Same as above with
`messaging = { backend: "matrix", baseUrl, accessToken, userId }`.
Validate `userId` looks like `@user:server`.

### `name <botName>` — set the display name used in envelopes

Read, set `botName`, write, confirm.

### `clear` — remove credentials

Delete `~/.channel-bot/bot.config.json` if it exists. Leave access state
(`access.json`) alone unless the user explicitly asks.

---

## Implementation notes

- The bot reads `bot.config.json` once at boot. Config changes need a
  session restart or `/reload-plugins`. Say so after saving.
- `access.json` is re-read on every inbound message — policy changes via
  `/channel:access` take effect immediately, no restart.
- Set file permissions to `0o600` for `bot.config.json` (contains tokens).
- Never print full tokens back to the user — mask them.
