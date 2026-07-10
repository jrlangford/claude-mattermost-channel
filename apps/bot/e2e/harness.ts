#!/usr/bin/env bun
// E2E harness for claude-channels mode: drives the interactive `claude` CLI
// inside an rmux pane so the full loop — chat backend → bot (MCP channel
// server) → live Claude Code session → reply tool → chat backend — can be
// exercised headlessly on a test box. See README.md for the full recipe.
//
//   bun harness.ts launch    start claude with the channel server, walk
//                            startup dialogs, wait for the bot to log
//                            "bot-app: running"
//   bun harness.ts capture   print the current pane text
//   bun harness.ts send <t>  type text into the session + Enter
//   bun harness.ts enter     press Enter (confirm a dialog manually)
//   bun harness.ts kill      kill the session and the rmux server
//
// Requires the `rmux` binary (0.6.x, matching @rmux/sdk) and `claude` on the
// PATH of the shell rmux spawns — or set CLAUDE_E2E_PATH_PREFIX.
//
// Environment knobs (defaults in parentheses):
//   CLAUDE_E2E_SESSION      rmux session name        (claude-e2e)
//   CLAUDE_E2E_CWD          directory claude runs in (~)
//   CLAUDE_E2E_MCP_CONFIG   --mcp-config file        (~/e2e-mcp.json)
//   CLAUDE_E2E_BOT_LOG      file the bot's stderr is redirected to in the
//                           MCP config; readiness signal (~/bot.log)
//   CLAUDE_E2E_PATH_PREFIX  optional PATH prepend for the launch command

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { Rmux } from "@rmux/sdk";

function expandHome(path: string): string {
  return path.startsWith("~/") || path === "~"
    ? join(homedir(), path.slice(1))
    : resolve(path);
}

const SESSION = process.env.CLAUDE_E2E_SESSION ?? "claude-e2e";
const CWD = expandHome(process.env.CLAUDE_E2E_CWD ?? "~");
const MCP_CONFIG = expandHome(process.env.CLAUDE_E2E_MCP_CONFIG ?? "~/e2e-mcp.json");
const BOT_LOG = expandHome(process.env.CLAUDE_E2E_BOT_LOG ?? "~/bot.log");
const PATH_PREFIX = process.env.CLAUDE_E2E_PATH_PREFIX;

const ALLOWED_TOOLS = [
  "mcp__channel__reply",
  "mcp__channel__edit_message",
  "mcp__channel__react",
  "mcp__channel__fetch_messages",
  "mcp__channel__download_attachment",
].join(",");

// --dangerously-load-development-channels is REQUIRED: an MCP server not
// named there (or in --channels) has its notifications silently dropped —
// the transport accepts them, receipts still fire, but nothing reaches the
// session. `server:channel` matches the server key in the MCP config.
const LAUNCH_CMD =
  `cd ${CWD} && ` +
  (PATH_PREFIX ? `export PATH=${PATH_PREFIX}:$PATH && ` : "") +
  `claude --mcp-config ${MCP_CONFIG} --strict-mcp-config ` +
  `--allowedTools "${ALLOWED_TOOLS}" ` +
  `--dangerously-load-development-channels server:channel`;

const rmux = new Rmux();

async function pane() {
  const session = await rmux.ensureSession(SESSION, { detached: true });
  return session.pane(0, 0);
}

function botLog(): string {
  return existsSync(BOT_LOG) ? readFileSync(BOT_LOG, "utf-8") : "";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Startup dialogs we know how to answer; every one is confirmed by Enter
// (the highlighted default is the right choice). Wordings vary across
// Claude Code versions — keep both old and new phrasings.
const ENTER_DIALOGS: RegExp[] = [
  /Do you trust the files in this (folder|directory)\?/i,
  /Is this a project you created or one you trust/i,
  /Yes, I trust this folder/i,
  /Yes, proceed/i,
  /Choose the text style/i,
  /Press Enter to continue/i,
  /Use this and all future/i,
  /New MCP server/i,
  /wants? to (use|connect)/i,
  /Do you want to proceed\?/i,
  /development channels?/i,
  // Catch-all: any selection dialog whose highlighted default is "1. Yes".
  /❯ 1\. Yes/,
];

const ABORT_DIALOGS: RegExp[] = [
  /Select login method/i,
  /Sign in to (Claude|Anthropic)/i,
  /Invalid API key/i,
];

async function launch(): Promise<void> {
  await rmux.startServer();
  // Fresh session with a real terminal size so dialogs render fully.
  await rmux.cmd("kill-session", "-t", SESSION, { check: false });
  const created = await rmux.cmd("new-session", "-d", "-s", SESSION, "-x", "200", "-y", "50");
  if (created.returnCode !== 0) await rmux.ensureSession(SESSION, { detached: true });
  const p = (await rmux.ensureSession(SESSION, { detached: true })).pane(0, 0);

  await p.sendText(LAUNCH_CMD);
  await p.sendKeys("Enter");
  console.log("launched claude, walking dialogs...");

  const deadline = Date.now() + 180_000;
  let lastAction = 0;
  while (Date.now() < deadline) {
    await sleep(1500);

    if (botLog().includes("bot-app: running")) {
      console.log("READY: bot.log reports 'bot-app: running'");
      const screen = await p.captureText();
      console.log(
        /Channels \(experimental\)/i.test(screen)
          ? "CHANNEL REGISTERED: 'Channels (experimental)' notice present"
          : "note: no 'Channels (experimental)' notice visible (may be folded into '+N more')"
      );
      console.log("--- pane ---");
      console.log(screen);
      return;
    }

    const screen = await p.captureText();
    for (const re of ABORT_DIALOGS) {
      if (re.test(screen)) {
        console.log("--- pane ---\n" + screen);
        console.error(`ABORT: login/credentials problem (${re})`);
        process.exit(2);
      }
    }
    const hit = ENTER_DIALOGS.find((re) => re.test(screen));
    // Rate-limit confirmations: never Enter twice within 3s so a single
    // dialog isn't double-confirmed while it animates away.
    if (hit && Date.now() - lastAction > 3000) {
      console.log(`dialog matched ${hit} -> Enter`);
      await p.sendKeys("Enter");
      lastAction = Date.now();
    }
  }

  console.log("--- final pane ---");
  console.log(await p.captureText());
  console.log("--- bot.log ---");
  console.log(botLog() || "(empty)");
  console.error("TIMEOUT: bot never reached 'running'");
  process.exit(2);
}

const cmd = process.argv[2];
switch (cmd) {
  case "launch":
    await launch();
    break;
  case "capture":
    console.log(await (await pane()).captureText());
    break;
  case "send": {
    const p = await pane();
    await p.sendText(process.argv[3] ?? "");
    await p.sendKeys("Enter");
    break;
  }
  case "enter":
    await (await pane()).sendKeys("Enter");
    break;
  case "kill":
    await rmux.cmd("kill-session", "-t", SESSION, { check: false });
    await rmux.killServer();
    break;
  default:
    console.error("usage: harness.ts launch|capture|send <text>|enter|kill");
    process.exit(1);
}
