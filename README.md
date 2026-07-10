# Mattermost Channel Monorepo

> **Status: Experimental** — APIs, access-control behavior, and configuration
> may change without notice.

A [bun](https://bun.sh) + [Turborepo](https://turborepo.com) monorepo housing
two Mattermost ↔ agent bridges that share a small set of dependency-free
modules.

## Layout

```
apps/
  bot/                         THE bot: polymorphic composition — pick a
                               messaging backend + an agent mode in config
  claude-mattermost-channel/   (legacy) hand-written Claude channel plugin
  codex-mattermost-bridge/     (legacy) hand-written Codex bridge

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
                               delivery-gated read receipts
  mattermost-shared/           legacy shared modules + the access CLI
```

Each app owns its runtime dependency — `@modelcontextprotocol/sdk` for the
Claude plugin, `@openai/codex-sdk` for the Codex bridge — so a pure-Claude
install never pulls the Codex SDK, and vice versa. The shared package holds only
the pieces both bridges genuinely reuse; it is consumed via the `workspace:*`
protocol and imported as `mattermost-shared` (with the access CLI exposed at the
`mattermost-shared/access-cli` subpath).

## Getting started

```bash
bun install            # installs the whole workspace (one root lockfile)
bun run check          # smoke-build every app + typecheck-equivalent, via turbo
bun run test           # runs the shared package's unit tests, via turbo
```

Run an individual bridge:

```bash
bun run start:claude   # Claude channel plugin
bun run start:codex    # Codex bridge
```

## Apps

- **[`apps/claude-mattermost-channel`](apps/claude-mattermost-channel/README.md)**
  — the Claude Code channel plugin: MCP tools (`reply`, `edit_message`,
  `react`, `fetch_messages`, `download_attachment`), the `/mattermost:configure`
  and `/mattermost:access` skills, and built-in DM/group access control.
- **[`apps/codex-mattermost-bridge`](apps/codex-mattermost-bridge/README.md)**
  — a standalone bot bridge that maps each Mattermost DM/thread to a Codex SDK
  thread. State lives under `~/.codex/mattermost`.

## Development

The [`justfile`](justfile) wraps the common dev loops:

```bash
just claude-channel    # launch Claude Code with the plugin loaded from source
just access <args>     # Claude access-control CLI
just codex-access <a>  # Codex access-control CLI
just check             # turbo check + test across the workspace
```

## License

Apache License 2.0 — see [LICENSE.md](LICENSE.md) and [NOTICE](NOTICE).
