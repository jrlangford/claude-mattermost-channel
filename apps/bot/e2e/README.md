# claude-channels E2E harness

Turn-mode agents (codex, claude-code-sdk) can be E2E-tested by just running
`main.ts` as a daemon. claude-channels mode can't: the bot process is an MCP
channel server that must be **spawned and hosted by a live interactive Claude
Code session**, and the replies come from that session. This harness drives
the real `claude` CLI headlessly inside an [rmux](https://rmux.io) pane
(via `@rmux/sdk`) so the whole loop can run unattended on a test box:

```
chat backend ──▶ bot (MCP channel server, spawned by claude)
                   │ notifications/claude/channel
                   ▼
             live Claude Code session ── reply tool ──▶ chat backend
```

## Prerequisites

- `rmux` + `rmux-daemon` 0.6.x binaries on PATH (must match `@rmux/sdk` 0.6.x)
- `claude` CLI installed and already authenticated (the harness aborts on
  login screens rather than typing credentials)
- `bun`, and a chat backend to point the bot at (the integration
  docker-compose stacks under `packages/*/integration/` work; their
  `bootstrap-cli.ts` prints the tokens)

## Setup

The harness starts `claude` with `--mcp-config` pointing at a config that
runs this app. Redirect the bot's **stderr to a file** — Claude Code owns the
MCP server's stdio, and that file is both your only log and the harness's
readiness signal:

```json
// ~/e2e-mcp.json
{
  "mcpServers": {
    "channel": {
      "command": "sh",
      "args": ["-c", "exec bun /path/to/apps/bot/main.ts /path/to/bot.config.json 2>>$HOME/bot.log"]
    }
  }
}
```

`bot.config.json` is a normal bot config (see `../bot.config.example.json`)
with `"agent": { "mode": "claude-channels" }`.

## Run

```bash
bun harness.ts launch     # start claude, auto-answer startup dialogs,
                          # wait for bot.log to say "bot-app: running"
bun harness.ts capture    # dump the pane (debugging)
bun harness.ts send <t>   # type into the session (rarely needed)
bun harness.ts enter      # confirm a dialog manually
bun harness.ts kill       # tear down the session + rmux server
```

Knobs (env): `CLAUDE_E2E_SESSION`, `CLAUDE_E2E_CWD`, `CLAUDE_E2E_MCP_CONFIG`,
`CLAUDE_E2E_BOT_LOG`, `CLAUDE_E2E_PATH_PREFIX` — see `harness.ts` header.

After `launch` reports READY, run the actual test from outside: DM the bot
on the backend, approve the pairing code with
`bun packages/bot/access-cli.ts pair <code>` (set `BOT_STATE_DIR` to the
bot's state dir), then send a message and watch the reply land.

## Pitfalls

- **`--dangerously-load-development-channels server:channel` is mandatory**
  (the harness passes it). An MCP server not named there — or in
  `--channels` — has its notifications *silently dropped*: the transport
  accepts them, the bot's 👀 receipt still fires, but nothing ever reaches
  the session. If you see receipts without replies, check this first.
- The same silent drop happens if the server doesn't declare
  `capabilities.experimental["claude/channel"]` (claude-channels-agent does;
  there's a regression test pinning it).
- Startup dialog wordings change across Claude Code versions. `launch`
  pattern-matches known dialogs and confirms defaults; if it times out,
  `capture` shows the screen it's stuck on — add the new wording to
  `ENTER_DIALOGS`.
