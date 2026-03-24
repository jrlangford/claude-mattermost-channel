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

## Environment Variables

The plugin reads from `~/.claude/channels/mattermost/.env` or from the MCP server environment:

| Variable | Required | Description |
|----------|----------|-------------|
| `MM_URL` | No | Mattermost server URL (default: `http://localhost:8065`) |
| `MM_BOT_TOKEN` | Yes | Bot personal access token |
| `MM_BOT_USER_ID` | Yes | Bot user ID |

## License

Apache License 2.0 — see [LICENSE.md](LICENSE.md) and [NOTICE](NOTICE).
