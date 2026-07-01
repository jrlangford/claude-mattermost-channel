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
| `reply` | Send a message to a channel (with optional `reply_to` for threading) |
| `edit_message` | Edit a previously sent message |
| `react` | Add an emoji reaction |
| `fetch_messages` | Fetch recent messages from a channel |

## Codex SDK Bridge

This repo also includes an experimental Codex version that runs as a standalone
Mattermost bot bridge. It uses `@openai/codex-sdk` to create or resume one
Codex thread per Mattermost DM or group thread, then posts Codex's final
response back to Mattermost.

### Codex setup

Create `~/.codex/mattermost/bots.json`:

```json
[
  {
    "name": "default",
    "url": "https://mattermost.example.com",
    "token": "abc123...",
    "userId": "def456..."
  }
]
```

Then run:

```bash
bun install
bun codex-server.ts
```

You can also use the same `MM_URL`, `MM_BOT_TOKEN`, and `MM_BOT_USER_ID`
environment variables instead of `bots.json`.

Pairing and access control use `~/.codex/mattermost/access.json`:

```bash
bun codex-access-cli.ts
bun codex-access-cli.ts pair <code>
bun codex-access-cli.ts policy allowlist
```

Useful Codex bridge environment variables:

| Variable | Description |
|----------|-------------|
| `CODEX_MODEL` | Model override passed to the Codex SDK thread |
| `CODEX_WORKING_DIRECTORY` | Working directory for Codex turns |
| `CODEX_SANDBOX_MODE` | `read-only`, `workspace-write`, or `danger-full-access` |
| `CODEX_APPROVAL_POLICY` | `never`, `on-request`, `on-failure`, or `untrusted` |
| `CODEX_MODEL_REASONING_EFFORT` | `minimal`, `low`, `medium`, `high`, or `xhigh` |
| `CODEX_WEB_SEARCH_MODE` | `disabled`, `cached`, or `live` |
| `CODEX_NETWORK_ACCESS` | Set to `1` to enable network access for Codex |
| `CODEX_MATTERMOST_HOME` | Override the default `~/.codex/mattermost` state directory |
| `CODEX_PATH` | Path to a specific Codex CLI binary |
| `CODEX_MCP_CONFIG_JSON` | JSON object of Codex MCP servers passed as `config.mcp_servers` |

The Codex bridge preserves the original DM pairing, allowlist, group opt-in,
multi-bot, unread catch-up, and heartbeat behavior. It does not use Claude
Code's `notifications/claude/channel` MCP extension.

## Environment Variables

The plugin reads from `~/.claude/channels/mattermost/.env` or from the MCP server environment:

| Variable | Required | Description |
|----------|----------|-------------|
| `MM_URL` | No | Mattermost server URL (default: `http://localhost:8065`) |
| `MM_BOT_TOKEN` | Yes | Bot personal access token |
| `MM_BOT_USER_ID` | Yes | Bot user ID |
| `MM_HEARTBEAT_INTERVAL` | No | WebSocket heartbeat interval in seconds (default: `0` = disabled) |

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
