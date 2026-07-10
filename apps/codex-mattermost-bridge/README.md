# Codex SDK Bridge

An experimental Codex version of the Mattermost channel that runs as a
standalone bot bridge. It uses `@openai/codex-sdk` to create or resume one
Codex thread per Mattermost DM or group thread, then posts Codex's final
response back to Mattermost.

This app is a self-contained package in the dependency sense: its
dependencies (including `@openai/codex-sdk`) are isolated from the Claude
plugin, so pure-Claude installs never pull the Codex SDK.

> **Note:** the bridge imports a few dependency-free modules from the
> `mattermost-shared` workspace package (the access CLI via
> `mattermost-shared/access-cli`, `selectCatchUpPosts` for catch-up post
> selection, and the attachment helpers), so the `bin` entries are not
> standalone-installable — run the bridge from a full checkout of this
> monorepo after `bun install` at the root.

## Setup

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

Then run (from this directory):

```bash
bun install
bun codex-server.ts
```

You can also use the same `MM_URL`, `MM_BOT_TOKEN`, and `MM_BOT_USER_ID`
environment variables instead of `bots.json`.

## Pairing and access control

Pairing and access control use `~/.codex/mattermost/access.json`:

```bash
bun codex-access-cli.ts
bun codex-access-cli.ts pair <code>
bun codex-access-cli.ts policy allowlist
```

The CLI is a thin wrapper around the shared `access-cli` (from the
`mattermost-shared` package), pointed at the Codex state directory via
`MATTERMOST_ACCESS_HOME` — a CLI-only override that neither server reads, so
it can never cross the Claude and Codex trust domains.

## Environment variables

| Variable | Description |
|----------|-------------|
| `CODEX_MODEL` | Model override passed to the Codex SDK thread |
| `CODEX_WORKING_DIRECTORY` | Working directory for Codex turns |
| `CODEX_SANDBOX_MODE` | `read-only`, `workspace-write`, or `danger-full-access` |
| `CODEX_APPROVAL_POLICY` | `never`, `on-request`, `on-failure`, or `untrusted` |
| `CODEX_MODEL_REASONING_EFFORT` | `minimal`, `low`, `medium`, `high`, or `xhigh` |
| `CODEX_WEB_SEARCH_MODE` | `disabled`, `cached`, or `live` |
| `CODEX_NETWORK_ACCESS` | Set to `1` to enable network access for Codex |
| `CODEX_MATTERMOST_HOME` | Override the default `~/.codex/mattermost` state directory (Codex-only; the Claude bridge's `MATTERMOST_CHANNEL_HOME` is deliberately ignored) |
| `CODEX_THREAD_MAX_IDLE_HOURS` | Idle age after which a stored Codex thread is abandoned and the conversation starts fresh (default `72`; `0` disables expiry) |
| `CODEX_PATH` | Path to a specific Codex CLI binary |
| `CODEX_MCP_CONFIG_JSON` | JSON object of Codex MCP servers passed as `config.mcp_servers` |
| `MM_MAX_FILE_MB` | Per-file cap for inbound attachment downloads (default `50`) |

## Attachments

Codex has no tool surface back into the bridge, so inbound attachments are
downloaded eagerly — only for messages that already passed the
pairing/allowlist gate — into `<state-dir>/downloads/<file-id>-<name>`
(names sanitized, files capped at `MM_MAX_FILE_MB`), and Codex receives the
local paths in the prompt, flagged as untrusted sender input. A file that
fails to download or exceeds the cap is reported in the prompt without
failing the turn. Sending attachments back is not supported: Codex's final
response is posted as text only.

## Delivery semantics

A channel is marked read (and the last answered post gets a 👀 reaction) only
*after* Codex's response has been posted back to Mattermost **and** no other
posts are pending in that channel — read receipts are channel-scoped in
Mattermost, so a receipt for one turn must not consume messages still queued
behind it. If a turn or its response post fails — or the process dies
mid-backlog — the channel stays unread and the unread catch-up on the next
connect re-delivers the outstanding messages (at-least-once; in-process dedup
absorbs overlap, and a `create_at` cutoff keeps already-answered posts from
being re-answered after a restart). Never-viewed channels are caught up with
a capped 20-post tail so a first-time correspondent's message isn't lost.
Catch-up enqueues turns per conversation without awaiting them, so one
conversation's backlog never starves other channels. A turn that produces no
final response posts a short notice rather than silently consuming the
message.

The bridge preserves the original DM pairing, allowlist, group opt-in,
multi-bot, unread catch-up, and heartbeat behavior. It does not use Claude
Code's `notifications/claude/channel` MCP extension.
