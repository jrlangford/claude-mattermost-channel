#!/usr/bin/env bun
/**
 * CLI tool for managing Mattermost channel access control.
 * Operates on ~/.claude/channels/mattermost/access.json
 *
 * Usage:
 *   bun access-cli.ts                      # show status
 *   bun access-cli.ts pair <code>           # approve a pairing
 *   bun access-cli.ts deny <code>           # deny a pairing
 *   bun access-cli.ts allow <userId>        # add user to allowlist
 *   bun access-cli.ts remove <userId>       # remove user from allowlist
 *   bun access-cli.ts policy <mode>         # set DM policy (pairing|allowlist|disabled)
 *   bun access-cli.ts group add <channelId> [--no-mention] [--allow id1,id2]
 *   bun access-cli.ts group rm <channelId>  # remove channel from groups
 */

import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";

// CLAUDE_CONFIG_DIR-aware: isolated profiles get isolated comms credentials.
// MATTERMOST_ACCESS_HOME re-points only this CLI invocation (used by the
// Codex bridge's wrapper); it is deliberately not read by either server so
// one variable can never cross the Claude/Codex state directories.
// Most-specific override wins.
const CONFIG_ROOT = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const CHANNELS_DIR =
  process.env.MATTERMOST_ACCESS_HOME ||
  join(CONFIG_ROOT, "channels", "mattermost");
const ACCESS_FILE = join(CHANNELS_DIR, "access.json");
const APPROVED_DIR = join(CHANNELS_DIR, "approved");

type GroupPolicy = {
  requireMention: boolean;
  allowFrom: string[];
};

type PendingEntry = {
  senderId: string;
  chatId: string;
  createdAt: number;
  expiresAt: number;
  replies: number;
};

type Access = {
  dmPolicy: "pairing" | "allowlist" | "disabled";
  allowFrom: string[];
  groups: Record<string, GroupPolicy>;
  pending: Record<string, PendingEntry>;
};

const DEFAULT_ACCESS: Access = {
  dmPolicy: "pairing",
  allowFrom: [],
  groups: {},
  pending: {},
};

function readAccess(): Access {
  try {
    const raw = readFileSync(ACCESS_FILE, "utf8");
    return { ...DEFAULT_ACCESS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_ACCESS };
  }
}

function saveAccess(access: Access): void {
  mkdirSync(CHANNELS_DIR, { recursive: true });
  const tmp = ACCESS_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(access, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, ACCESS_FILE);
}

function pruneExpired(access: Access): void {
  const now = Date.now();
  for (const [code, entry] of Object.entries(access.pending)) {
    if (entry.expiresAt < now) delete access.pending[code];
  }
}

// Mattermost IDs are 26-char alphanumeric strings.
const MM_ID_RE = /^[a-z0-9]{26}$/i;

function requireValidId(value: string | undefined, name: string): string {
  if (!value || !MM_ID_RE.test(value)) {
    console.error(`Invalid ${name}: expected 26-char alphanumeric Mattermost ID, got "${value ?? ""}"`);
    process.exit(1);
  }
  return value;
}

const args = process.argv.slice(2);
const cmd = args[0];

if (!cmd) {
  // Status
  const access = readAccess();
  pruneExpired(access);

  console.log("Mattermost Channel Access Status");
  console.log("================================");
  console.log(`DM Policy: ${access.dmPolicy}`);
  console.log(`Allowed users (${access.allowFrom.length}):`);
  for (const id of access.allowFrom) console.log(`  - ${id}`);

  const pendingEntries = Object.entries(access.pending);
  console.log(`Pending pairings (${pendingEntries.length}):`);
  for (const [code, entry] of pendingEntries) {
    const age = Math.round((Date.now() - entry.createdAt) / 60000);
    console.log(
      `  - code: ${code}  sender: ${entry.senderId}  age: ${age}m  replies: ${entry.replies}`
    );
  }

  const groupEntries = Object.entries(access.groups);
  console.log(`Groups (${groupEntries.length}):`);
  for (const [channelId, policy] of groupEntries) {
    const mention = policy.requireMention ? "mention required" : "all messages";
    const allow =
      policy.allowFrom.length > 0
        ? `allowFrom: ${policy.allowFrom.join(", ")}`
        : "all users";
    console.log(`  - ${channelId}: ${mention}, ${allow}`);
  }
} else if (cmd === "pair") {
  const code = args[1];
  if (!code) {
    console.error("Usage: pair <code>");
    process.exit(1);
  }

  const access = readAccess();
  pruneExpired(access);

  const entry = access.pending[code];
  if (!entry) {
    console.error(`No pending pairing with code "${code}" (may have expired)`);
    process.exit(1);
  }

  if (entry.expiresAt < Date.now()) {
    delete access.pending[code];
    saveAccess(access);
    console.error("Pairing code has expired");
    process.exit(1);
  }

  const { senderId, chatId } = entry;

  // Add to allowlist (dedupe)
  if (!access.allowFrom.includes(senderId)) {
    access.allowFrom.push(senderId);
  }
  delete access.pending[code];
  saveAccess(access);

  // Write approval marker for the server to pick up
  mkdirSync(APPROVED_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(join(APPROVED_DIR, senderId), chatId, { mode: 0o600 });

  console.log(`Approved sender ${senderId}. They'll receive a confirmation in Mattermost.`);
} else if (cmd === "deny") {
  const code = args[1];
  if (!code) {
    console.error("Usage: deny <code>");
    process.exit(1);
  }

  const access = readAccess();
  if (access.pending[code]) {
    delete access.pending[code];
    saveAccess(access);
    console.log(`Denied and removed pairing code "${code}"`);
  } else {
    console.error(`No pending pairing with code "${code}"`);
  }
} else if (cmd === "allow") {
  const userId = requireValidId(args[1], "userId");

  const access = readAccess();
  if (!access.allowFrom.includes(userId)) {
    access.allowFrom.push(userId);
    saveAccess(access);
    console.log(`Added ${userId} to allowlist`);
  } else {
    console.log(`${userId} is already in allowlist`);
  }
} else if (cmd === "remove") {
  const userId = requireValidId(args[1], "userId");

  const access = readAccess();
  const before = access.allowFrom.length;
  access.allowFrom = access.allowFrom.filter((id) => id !== userId);
  if (access.allowFrom.length < before) {
    saveAccess(access);
    console.log(`Removed ${userId} from allowlist`);
  } else {
    console.log(`${userId} was not in allowlist`);
  }
} else if (cmd === "policy") {
  const mode = args[1];
  if (!mode || !["pairing", "allowlist", "disabled"].includes(mode)) {
    console.error("Usage: policy <pairing|allowlist|disabled>");
    process.exit(1);
  }

  const access = readAccess();
  access.dmPolicy = mode as Access["dmPolicy"];
  saveAccess(access);
  console.log(`DM policy set to "${mode}"`);
} else if (cmd === "group") {
  const subcmd = args[1];

  if (subcmd === "add") {
    const channelId = requireValidId(args[2], "channelId");

    const noMention = args.includes("--no-mention");
    const allowIdx = args.indexOf("--allow");
    const allowArg = allowIdx !== -1 ? args[allowIdx + 1] : undefined;
    const allowFrom = allowArg ? allowArg.split(",") : [];
    for (const id of allowFrom) requireValidId(id, "allowFrom userId");

    const access = readAccess();
    access.groups[channelId] = {
      requireMention: !noMention,
      allowFrom,
    };
    saveAccess(access);
    console.log(
      `Added channel ${channelId} (mention: ${!noMention}, allowFrom: ${allowFrom.length > 0 ? allowFrom.join(", ") : "all"})`
    );
  } else if (subcmd === "rm") {
    const channelId = requireValidId(args[2], "channelId");

    const access = readAccess();
    if (access.groups[channelId]) {
      delete access.groups[channelId];
      saveAccess(access);
      console.log(`Removed channel ${channelId} from groups`);
    } else {
      console.log(`Channel ${channelId} was not in groups`);
    }
  } else {
    console.error("Usage: group <add|rm> <channelId>");
    process.exit(1);
  }
} else {
  console.error(`Unknown command: ${cmd}`);
  console.error(
    "Commands: pair, deny, allow, remove, policy, group add, group rm"
  );
  process.exit(1);
}
