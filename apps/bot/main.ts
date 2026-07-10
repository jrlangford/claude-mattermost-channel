#!/usr/bin/env bun
// The polymorphic bot: snap one messaging backend to one agent mode via
// config — codex-on-mattermost, claude-channels-on-matrix, any combination.
// All bot logic lives in the `bot` package; this file only composes.
//
//   bun main.ts <config.json>      (or BOT_CONFIG=<path> bun main.ts)
//
// All logging goes to stderr: in claude-channels mode this process IS an
// MCP server on stdio.

import { readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import type { Agent } from "agent";
import { createBot, type Bot, type OutboundGuard } from "bot";
import { createOutboundGuard } from "bot";
import { createClaudeChannelsAgent } from "claude-channels-agent";
import { createClaudeCodeSdkAgent } from "claude-code-sdk-agent";
import { createCodexAgent } from "codex-agent";
import { createMatrixClient } from "matrix-client";
import { createMattermostClient } from "mattermost-client";
import type { MessagingClient } from "messaging-client";

type MessagingConfig =
  | { backend: "mattermost"; url: string; token: string; heartbeatIntervalMs?: number }
  | { backend: "matrix"; baseUrl: string; accessToken: string; userId: string; deviceId?: string };

type AgentConfig =
  | {
      mode: "codex";
      codexOptions?: Record<string, unknown>;
      threadOptions?: Record<string, unknown>;
      threadMaxIdleHours?: number;
    }
  | {
      mode: "claude-code-sdk";
      queryOptions?: Record<string, unknown>;
      sessionMaxIdleHours?: number;
    }
  | { mode: "claude-channels"; connectGraceMs?: number };

type BotFileConfig = {
  stateDir?: string;
  botName?: string;
  maxFileBytes?: number;
  /** Pairing message template; {code} is replaced with the code. */
  pairingMessage?: string;
  errorNotice?: string;
  messaging: MessagingConfig;
  agent: AgentConfig;
};

function fatal(message: string): never {
  console.error(`bot-app: ${message}`);
  process.exit(1);
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(path);
}

function loadConfig(): BotFileConfig {
  const path = process.argv[2] ?? process.env.BOT_CONFIG;
  if (!path) fatal("usage: bun main.ts <config.json> (or set BOT_CONFIG)");
  try {
    return JSON.parse(readFileSync(expandHome(path), "utf-8")) as BotFileConfig;
  } catch (err) {
    fatal(`cannot read config ${path}: ${err}`);
  }
}

function buildClient(config: MessagingConfig): MessagingClient {
  switch (config.backend) {
    case "mattermost":
      if (!config.url || !config.token) fatal("mattermost backend needs url + token");
      return createMattermostClient({
        url: config.url,
        token: config.token,
        heartbeatIntervalMs: config.heartbeatIntervalMs,
      });
    case "matrix":
      if (!config.baseUrl || !config.accessToken || !config.userId) {
        fatal("matrix backend needs baseUrl + accessToken + userId");
      }
      return createMatrixClient({
        baseUrl: config.baseUrl,
        accessToken: config.accessToken,
        userId: config.userId,
        deviceId: config.deviceId,
      });
    default:
      fatal(`unknown messaging backend: ${(config as { backend: string }).backend}`);
  }
}

function buildAgent(
  config: BotFileConfig,
  deps: { client: MessagingClient; guard: OutboundGuard; stateDir: string }
): Agent {
  const agentConfig = config.agent;
  switch (agentConfig.mode) {
    case "codex":
      return createCodexAgent({
        stateDir: deps.stateDir,
        codexOptions: agentConfig.codexOptions,
        threadOptions: agentConfig.threadOptions,
        threadMaxIdleHours: agentConfig.threadMaxIdleHours,
      });
    case "claude-code-sdk":
      return createClaudeCodeSdkAgent({
        stateDir: deps.stateDir,
        queryOptions: agentConfig.queryOptions,
        sessionMaxIdleHours: agentConfig.sessionMaxIdleHours,
      });
    case "claude-channels":
      return createClaudeChannelsAgent({
        client: deps.client,
        allowOutbound: (channelId) => deps.guard.allow(channelId),
        downloadsDir: join(deps.stateDir, "downloads"),
        maxFileBytes: config.maxFileBytes,
        botName: config.botName,
        connectGraceMs: agentConfig.connectGraceMs,
      });
    default:
      fatal(`unknown agent mode: ${(agentConfig as { mode: string }).mode}`);
  }
}

const config = loadConfig();
const stateDir = expandHome(config.stateDir ?? "~/.channel-bot");
const client = buildClient(config.messaging);
// One guard shared by the bot and (in channels mode) the agent's tools.
const guard = createOutboundGuard({ accessFile: join(stateDir, "access.json") });
const agent = buildAgent(config, { client, guard, stateDir });

const bot: Bot = createBot({
  client,
  agent,
  guard,
  stateDir,
  botName: config.botName,
  maxFileBytes: config.maxFileBytes,
  errorNotice:
    config.errorNotice ?? `${agent.mode} failed while handling that message.`,
  pairingInstructions: config.pairingMessage
    ? (code) => config.pairingMessage!.replaceAll("{code}", code)
    : undefined,
});

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error("bot-app: shutting down");
  void bot.stop().finally(() => setTimeout(() => process.exit(0), 500));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// Only in claude-channels mode does the MCP host own our stdio — there,
// stdin closing means the session is gone. Turn-mode daemons often run with
// stdin at /dev/null (immediate EOF), which must NOT trigger shutdown.
if (config.agent.mode === "claude-channels") {
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
}

console.error(
  `bot-app: starting ${config.agent.mode} × ${config.messaging.backend}` +
    (config.botName ? ` as ${config.botName}` : "")
);
await bot.start();
console.error("bot-app: running");
