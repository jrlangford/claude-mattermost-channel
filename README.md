# Mattermost Channel for Claude Code

> **Status: Experimental** — This plugin is under active development. APIs, access control behavior, and configuration may change without notice.

A [Claude Code channel](https://code.claude.com/docs/en/channels) plugin that bridges Mattermost to Claude Code. Messages sent in Mattermost arrive in your Claude Code session, and Claude's replies are posted back.

Based on the official [Discord channel plugin](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/discord) by Anthropic, adapted for Mattermost's REST API and WebSocket protocol.

## Prerequisites

- [Bun](https://bun.sh) runtime
- A Mattermost server with a bot account and personal access token
- [Claude Code](https://code.claude.com) CLI

## Setup

### 1. Create a Mattermost bot

In your Mattermost instance, create a bot account with a personal access token. You'll need:

- **Bot token** — the personal access token
- **Bot user ID** — the bot's user ID (found in the bot's profile or API response)
- **Server URL** — your Mattermost server URL (e.g. `https://mattermost.example.com`)

Bot account creation and user access tokens must be enabled by a server admin:

- System Console > Integrations > Bot Accounts > Enable Bot Account Creation
- System Console > Integrations > Integration Management > Enable Personal Access Tokens

### 2. Install the plugin

```bash
/plugin marketplace add jrlangford/jrlangford-marketplace
/plugin install mattermost@jrlangford-marketplace
```

### 3. Configure

```bash
claude
# Then in the Claude Code session:
/mattermost:configure <server-url> <bot-token> <bot-user-id>
```

This saves credentials to `~/.claude/channels/mattermost/.env` with `600` permissions.

### 4. Launch

```bash
claude --dangerously-load-development-channels plugin:mattermost@jrlangford-marketplace
```

DM your bot on Mattermost — the message arrives in Claude's session and Claude replies back.

## Access Control

The plugin includes built-in access gating so not everyone on your Mattermost server can talk to Claude.

### DM Policy

Controlled via `/mattermost:access policy <mode>`:

| Mode | Behavior |
|------|----------|
| `pairing` (default) | Unknown senders get a 6-character pairing code. Approve with `/mattermost:access pair <code>` in your terminal. |
| `allowlist` | Only pre-approved senders can reach Claude. Others are silently ignored. |
| `disabled` | All DMs are forwarded (not recommended). |

### Group Channels

Opt in specific channels with `/mattermost:access group add <channelId>`. By default, Claude only responds when @mentioned in group channels.

### Managing Access

```bash
/mattermost:access                    # Show current status
/mattermost:access pair <code>        # Approve a pairing request
/mattermost:access deny <code>        # Reject a pairing request
/mattermost:access allow <userId>     # Directly add a user
/mattermost:access remove <userId>    # Remove a user
/mattermost:access policy allowlist   # Lock down after pairing
```

## MCP Tools

The plugin exposes these tools to Claude:

| Tool | Description |
|------|-------------|
| `reply` | Send a message to a channel (optional `reply_to` for threading, `files` to attach local files) |
| `edit_message` | Edit a previously sent message |
| `react` | Add an emoji reaction |
| `fetch_messages` | Fetch recent messages from a channel (lists attachments per message) |
| `download_attachment` | Save a message attachment to a local file and return its path |

### File attachments

Inbound messages with uploads carry an `attachments` attribute in the envelope
(JSON: `id`, `name`, `size`, `mime_type` per file). Claude calls
`download_attachment` with a file id; the file is saved under
`<channels dir>/downloads/` with an id-prefixed, sanitized filename and the
local path is returned — PDFs and images can then be read directly. Outbound,
`reply` accepts a `files` array of local paths (max 5 per message).

Both directions enforce a size cap (`MM_MAX_FILE_MB`, default 50). Downloads
are gated by the same channel allowlist as every other tool, and attachment
contents are flagged to the model as untrusted sender input.

## Codex SDK Bridge

This repo also includes an experimental Codex version that runs as a standalone
Mattermost bot bridge. It lives in [`codex-bridge/`](codex-bridge/) as a
self-contained package, so its `@openai/codex-sdk` dependency is never
installed by the Claude plugin:

```bash
cd codex-bridge
bun install
bun codex-server.ts
```

See [`codex-bridge/README.md`](codex-bridge/README.md) for setup, pairing, and
configuration.

## Environment Variables

The plugin reads from `~/.claude/channels/mattermost/.env` or from the MCP server environment:

| Variable | Required | Description |
|----------|----------|-------------|
| `MM_URL` | No | Mattermost server URL (default: `http://localhost:8065`) |
| `MM_BOT_TOKEN` | Yes | Bot personal access token |
| `MM_BOT_USER_ID` | Yes | Bot user ID |
| `MM_HEARTBEAT_INTERVAL` | No | WebSocket heartbeat interval in seconds (default: `0` = disabled) |
| `MM_MAX_FILE_MB` | No | Attachment size cap in MB for download/upload (default: `50`) |

### Heartbeat (remote agents)

When a host sleeps, Docker suspends the container and the Mattermost WebSocket enters a half-open state: the server closes its side, but the client never receives the FIN. On wake, the existing reconnect logic doesn't fire because no `close` event is delivered — and messages sent during the gap are silently dropped.

Set `MM_HEARTBEAT_INTERVAL=30` to enable a protocol-level WebSocket ping every 30 seconds. If no pong is received within 60 seconds (2× the interval), the plugin force-closes the socket and the existing exponential-backoff reconnect runs.

**Local agents** (same host as Mattermost) don't need this — leave it unset.
**Remote agents** (running in a separate container or VM) should set it in their Docker recipe:

```
-e MM_HEARTBEAT_INTERVAL=30
```

## License

Apache License 2.0 — see [LICENSE.md](LICENSE.md) and [NOTICE](NOTICE).
