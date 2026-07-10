#!/usr/bin/env bun
/**
 * CLI for managing bot access control. Operates on <state-dir>/access.json —
 * the same file the running bot reads (ported from the legacy bridges'
 * access-cli, now backend-neutral: ids can be Mattermost ids or Matrix
 * MXIDs/room ids).
 *
 * State dir: BOT_STATE_DIR || MATTERMOST_ACCESS_HOME (legacy) || ~/.channel-bot
 *
 * Usage:
 *   bun access-cli.ts                       # show status
 *   bun access-cli.ts pair <code>           # approve a pairing
 *   bun access-cli.ts deny <code>           # deny a pairing
 *   bun access-cli.ts allow <userId>        # add user to allowlist
 *   bun access-cli.ts remove <userId>       # remove user from allowlist
 *   bun access-cli.ts policy <mode>         # set DM policy (pairing|allowlist|disabled)
 *   bun access-cli.ts group add <channelId> [--no-mention] [--allow id1,id2]
 *   bun access-cli.ts group rm <channelId>  # remove channel from groups
 */

import { mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { pruneExpired, readAccess, saveAccess, type Access } from "./access.ts";

const STATE_DIR =
  process.env.BOT_STATE_DIR ||
  process.env.MATTERMOST_ACCESS_HOME ||
  join(homedir(), ".channel-bot");
const ACCESS_FILE = join(STATE_DIR, "access.json");
const APPROVED_DIR = join(STATE_DIR, "approved");

const read = (): Access => readAccess(ACCESS_FILE);
const save = (access: Access): void => saveAccess(ACCESS_FILE, access);

// Backend-neutral id check: Mattermost ids are 26-char alphanumerics, Matrix
// user ids look like "@user:server" and room ids like "!room:server". Reject
// whitespace and path-hostile characters; the bot re-validates on its side.
const ID_RE = /^[A-Za-z0-9@:!._=-]+$/;

function requireValidId(value: string | undefined, name: string): string {
  if (!value || value.length > 255 || !ID_RE.test(value)) {
    console.error(`Invalid ${name}: got "${value ?? ""}"`);
    process.exit(1);
  }
  return value;
}

const args = process.argv.slice(2);
const cmd = args[0];

if (!cmd) {
  // Status
  const access = read();
  pruneExpired(access);

  console.log(`Bot Access Status (${ACCESS_FILE})`);
  console.log("=".repeat(32));
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
      policy.allowFrom.length > 0 ? `allowFrom: ${policy.allowFrom.join(", ")}` : "all users";
    console.log(`  - ${channelId}: ${mention}, ${allow}`);
  }
} else if (cmd === "pair") {
  const code = args[1];
  if (!code) {
    console.error("Usage: pair <code>");
    process.exit(1);
  }

  const access = read();
  pruneExpired(access);

  const entry = access.pending[code];
  if (!entry) {
    console.error(`No pending pairing with code "${code}" (may have expired)`);
    process.exit(1);
  }
  if (entry.expiresAt < Date.now()) {
    delete access.pending[code];
    save(access);
    console.error("Pairing code has expired");
    process.exit(1);
  }

  const { senderId, chatId } = entry;
  if (!access.allowFrom.includes(senderId)) access.allowFrom.push(senderId);
  delete access.pending[code];
  save(access);

  // Approval marker: the running bot polls this dir and sends "Paired!".
  mkdirSync(APPROVED_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(join(APPROVED_DIR, senderId), chatId, { mode: 0o600 });

  console.log(`Approved sender ${senderId}. They'll receive a confirmation message.`);
} else if (cmd === "deny") {
  const code = args[1];
  if (!code) {
    console.error("Usage: deny <code>");
    process.exit(1);
  }

  const access = read();
  if (access.pending[code]) {
    delete access.pending[code];
    save(access);
    console.log(`Denied and removed pairing code "${code}"`);
  } else {
    console.error(`No pending pairing with code "${code}"`);
  }
} else if (cmd === "allow") {
  const userId = requireValidId(args[1], "userId");
  const access = read();
  if (!access.allowFrom.includes(userId)) {
    access.allowFrom.push(userId);
    save(access);
    console.log(`Added ${userId} to allowlist`);
  } else {
    console.log(`${userId} is already in allowlist`);
  }
} else if (cmd === "remove") {
  const userId = requireValidId(args[1], "userId");
  const access = read();
  const before = access.allowFrom.length;
  access.allowFrom = access.allowFrom.filter((id) => id !== userId);
  if (access.allowFrom.length < before) {
    save(access);
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
  const access = read();
  access.dmPolicy = mode as Access["dmPolicy"];
  save(access);
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

    const access = read();
    access.groups[channelId] = { requireMention: !noMention, allowFrom };
    save(access);
    console.log(
      `Added channel ${channelId} (mention: ${!noMention}, allowFrom: ${allowFrom.length > 0 ? allowFrom.join(", ") : "all"})`
    );
  } else if (subcmd === "rm") {
    const channelId = requireValidId(args[2], "channelId");
    const access = read();
    if (access.groups[channelId]) {
      delete access.groups[channelId];
      save(access);
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
  console.error("Commands: pair, deny, allow, remove, policy, group add, group rm");
  process.exit(1);
}
