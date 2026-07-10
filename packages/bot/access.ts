// Access control — ported from the legacy bridge servers. The access.json
// shape is unchanged (access-cli.ts in this package edits it); gate() is a
// pure function over it so policy is unit-testable without a filesystem.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import { dirname } from "path";

export type GroupPolicy = {
  requireMention: boolean;
  allowFrom: string[];
};

export type PendingEntry = {
  senderId: string;
  chatId: string;
  createdAt: number;
  expiresAt: number;
  replies: number;
};

export type Access = {
  dmPolicy: "pairing" | "allowlist" | "disabled";
  allowFrom: string[];
  groups: Record<string, GroupPolicy>;
  pending: Record<string, PendingEntry>;
};

export type GateResult =
  | { action: "deliver" }
  | { action: "drop" }
  | { action: "pair"; code: string; isResend: boolean };

export const MAX_PENDING = 3;
export const MAX_PAIR_REPLIES = 2;
export const PAIR_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

const DEFAULT_ACCESS: Access = { dmPolicy: "pairing", allowFrom: [], groups: {}, pending: {} };

export function readAccess(file: string): Access {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<Access>;
    return {
      dmPolicy: parsed.dmPolicy ?? "pairing",
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
    };
  } catch {
    return structuredClone(DEFAULT_ACCESS);
  }
}

export function saveAccess(file: string, access: Access): void {
  if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // Atomic + 0600: the file is policy state and the CLI edits it too.
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(access, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

/** Drop expired pairing codes. Returns true when the access object changed. */
export function pruneExpired(access: Access, now = Date.now()): boolean {
  let changed = false;
  for (const [code, entry] of Object.entries(access.pending)) {
    if (entry.expiresAt < now) {
      delete access.pending[code];
      changed = true;
    }
  }
  return changed;
}

export type GateParams = {
  senderId: string;
  channelId: string;
  isDM: boolean;
  /** True when the bot was mentioned or the message replies to a bot post
   *  (implicit mention) — the group requireMention policy input. */
  mentioned: boolean;
};

/**
 * Decide what to do with an inbound message. May mutate `access` (pairing
 * bookkeeping) — the caller persists when `true` is returned as `mutated`.
 */
export function gate(
  access: Access,
  params: GateParams
): { result: GateResult; mutated: boolean } {
  const { senderId, channelId, isDM } = params;

  if (isDM) {
    if (access.dmPolicy === "disabled") return { result: { action: "drop" }, mutated: false };
    if (access.allowFrom.includes(senderId)) {
      return { result: { action: "deliver" }, mutated: false };
    }
    if (access.dmPolicy === "allowlist") return { result: { action: "drop" }, mutated: false };

    // Pairing mode: resend the existing code a bounded number of times.
    for (const [code, entry] of Object.entries(access.pending)) {
      if (entry.senderId === senderId) {
        if (entry.replies < MAX_PAIR_REPLIES) {
          entry.replies++;
          return { result: { action: "pair", code, isResend: true }, mutated: true };
        }
        return { result: { action: "drop" }, mutated: false };
      }
    }

    // A stranger can seed at most MAX_PENDING codes — cap the surface.
    if (Object.keys(access.pending).length >= MAX_PENDING) {
      return { result: { action: "drop" }, mutated: false };
    }

    const code = randomBytes(8).toString("hex");
    access.pending[code] = {
      senderId,
      chatId: channelId,
      createdAt: Date.now(),
      expiresAt: Date.now() + PAIR_EXPIRY_MS,
      replies: 1,
    };
    return { result: { action: "pair", code, isResend: false }, mutated: true };
  }

  // Group channels: opt-in only.
  const policy = access.groups[channelId];
  if (!policy) return { result: { action: "drop" }, mutated: false };
  if (policy.allowFrom.length > 0 && !policy.allowFrom.includes(senderId)) {
    return { result: { action: "drop" }, mutated: false };
  }
  if (policy.requireMention && !params.mentioned) {
    return { result: { action: "drop" }, mutated: false };
  }
  return { result: { action: "deliver" }, mutated: false };
}

// -- outbound guard ------------------------------------------------------------

/**
 * Gate for channels the AGENT chooses to act on (its tools / replies to
 * places that didn't originate a gated message) — the prompt-injection
 * boundary. Re-reads access.json every call; never trusts ephemeral state
 * alone. DM channels are vouched for by the sender cache the bot fills on
 * gated inbound delivery — without a known allowlisted correspondent, deny.
 */
export type OutboundGuard = {
  allow(channelId: string): Promise<void>;
  /** Fed by the bot on every delivered DM so the guard can vouch later. */
  noteSender(channelId: string, senderId: string): void;
};

export function createOutboundGuard(opts: {
  accessFile: string;
  cacheCap?: number;
}): OutboundGuard {
  const dmSenders = new Map<string, string>();
  const cap = opts.cacheCap ?? 500;

  return {
    noteSender(channelId, senderId) {
      dmSenders.set(channelId, senderId);
      if (dmSenders.size > cap) {
        const first = dmSenders.keys().next().value;
        if (first !== undefined) dmSenders.delete(first);
      }
    },
    async allow(channelId) {
      const access = readAccess(opts.accessFile);
      if (access.groups[channelId]) return;
      const sender = dmSenders.get(channelId);
      if (sender && access.allowFrom.includes(sender)) return;
      throw new Error(`channel ${channelId} is not allowlisted for outbound`);
    },
  };
}
