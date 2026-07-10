# Channel Bot Monorepo

> **Status: Experimental** — APIs, access-control behavior, and configuration
> may change without notice.

A [bun](https://bun.sh) + [Turborepo](https://turborepo.com) monorepo for
building messaging bots out of lego pieces: two contracts — **messaging**
(how to talk to a chat network) and **agent** (something you can converse
with) — snapped together by a write-once **bot** core. Any backend × any
agent mode is configuration, not code.

## Layout

```
apps/
  bot/                         THE bot: polymorphic composition — pick a
                               messaging backend + an agent mode in config

packages/                      the lego pieces
  messaging-client/            contract: "how to talk to a chat network"
  mattermost-client/             impl: Mattermost (REST + WS)
  matrix-client/                 impl: Matrix (matrix-js-sdk)
  agent/                       contract: "something you can converse with"
  codex-agent/                   impl: turn-based on @openai/codex-sdk
  claude-code-sdk-agent/         impl: turn-based on the Claude Agent SDK
  claude-channels-agent/         impl: session mode (MCP notifications into
                                 a live Claude Code session; replies via tools)
  bot/                         the write-once bot core: gate/pairing, dedup,
                               catch-up, per-conversation queues,
                               delivery-gated read receipts — plus the
                               access CLI (access-cli.ts)
```

## Getting started

```bash
bun install            # installs the whole workspace (one root lockfile)
bun run check          # smoke-build every package, via turbo
bun run test           # all unit tests, via turbo
```

Run a bot:

```bash
cp apps/bot/bot.config.example.json bot.config.json   # edit it
bun run start:bot -- bot.config.json
```

See [`apps/bot/README.md`](apps/bot/README.md) for the config shape (pick
`messaging.backend`: mattermost | matrix, and `agent.mode`: codex |
claude-code-sdk | claude-channels) and
[`packages/bot/access-cli.ts`](packages/bot/access-cli.ts) for managing
pairing/allowlists (`just access`).

`apps/bot` also doubles as a **Claude Code channel plugin** (claude-channels
mode): `just claude-channel` loads it via `--plugin-dir`, with
`/channel:configure` and `/channel:access` skills in-session.

## Integration tests

The transport adapters are verified against real servers via docker compose
(host needs docker only — tests run in an `oven/bun` container on the
compose network):

```bash
cd packages/mattermost-client && bun run test:integration   # real Mattermost
cd packages/matrix-client && bun run test:integration       # real Synapse
```

## Development

The [`justfile`](justfile) wraps the common loops:

```bash
just check             # turbo check + test across the workspace
just bot <config>      # run the polymorphic bot
just access <args>     # access-control CLI (BOT_STATE_DIR-aware)
```

## History

This repo began as a Mattermost channel plugin for Claude Code (based on
Anthropic's Discord channel plugin) plus a hand-written Codex bridge; both
were decomposed into the packages above and retired. Their delivery
semantics — at-least-once with dedup, delivery-gated channel-settled read
receipts, unread catch-up with create-time cutoffs — live on in the `bot`
core, test-covered.

## License

Apache License 2.0 — see [LICENSE.md](LICENSE.md) and [NOTICE](NOTICE).
