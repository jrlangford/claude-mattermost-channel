// The bot core — the write-once logic both hand-written bridges shared,
// composed over the two contracts: a MessagingClient (transport) and an
// Agent (the AI side). Ported behaviors, with their original rationale:
//
// - Dedup (capped, in-process): live WS events and catch-up overlap;
//   at-least-once delivery absorbs the rest.
// - Delivery-gated, channel-settled read receipts: mark-read moves the read
//   pointer for the WHOLE channel, so it may only fire when every pending
//   post in the channel has been handled — marking early turns a crash
//   mid-backlog into silent permanent loss.
// - Per-conversation queues: one conversation's multi-minute turn must not
//   starve other channels; ordering is preserved within a conversation.
// - Failed turns leave the channel unread (and undo dedup) so the next
//   connect's catch-up redelivers.
// - Catch-up: unread channels replay via since=lastViewedAt with a
//   create-time cutoff; never-viewed channels get a capped tail so a
//   first-time correspondent's message isn't lost.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { Agent, AgentFile } from "agent";
import { sanitizeFilename } from "mattermost-shared";
import type { Message, MessagingClient, User } from "messaging-client";
import {
  createOutboundGuard,
  gate,
  pruneExpired,
  readAccess,
  saveAccess,
  type OutboundGuard,
} from "./access.ts";
import { conversationFor } from "./conversation.ts";

export type BotConfig = {
  client: MessagingClient;
  agent: Agent;
  /** Directory for bot state: access.json, approved/, downloads/. */
  stateDir: string;
  /** Shown in envelopes for multi-bot deployments. */
  botName?: string;
  /** Share one guard between the bot and a channels-mode agent. */
  guard?: OutboundGuard;
  /** Per-file cap for attachment localization, bytes (default 50 MB). */
  maxFileBytes?: number;
  /** Read-receipt UX delay (default 1500ms; not a delivery gate). */
  receiptDelayMs?: number;
  /** Pairing-approval poll interval (default 5000ms; 0 disables). */
  approvalPollMs?: number;
  /** Catch-up tail for never-viewed channels (default 20). */
  neverViewedTailLimit?: number;
  pairingInstructions?: (code: string, isResend: boolean) => string;
  errorNotice?: string;
  pairedNotice?: string;
  log?: (message: string, err?: unknown) => void;
};

export type Bot = {
  guard: OutboundGuard;
  start(): Promise<void>;
  stop(): Promise<void>;
};

const DELIVERED_CAP = 500;
const RECENT_SENT_CAP = 200;
const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;

const DEFAULT_PAIRING = (code: string, isResend: boolean): string =>
  isResend
    ? `Pairing required — ask the bot owner to approve code ${code}.`
    : `Hi! I need to verify your identity before we can chat.\n\nAsk the bot owner to approve pairing code ${code}.`;

function cappedAdd(set: Set<string>, value: string, cap: number): void {
  set.add(value);
  if (set.size > cap) {
    const first = set.values().next().value;
    if (first !== undefined) set.delete(first);
  }
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function createBot(config: BotConfig): Bot {
  const { client, agent } = config;
  const log = config.log ?? ((message, err) => console.error(`bot: ${message}`, err ?? ""));
  const accessFile = join(config.stateDir, "access.json");
  const approvedDir = join(config.stateDir, "approved");
  const downloadsDir = join(config.stateDir, "downloads");
  const maxFileBytes = config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const guard = config.guard ?? createOutboundGuard({ accessFile });

  let self: User = { id: "" };
  let approvalTimer: ReturnType<typeof setInterval> | null = null;
  const unsubscribes: (() => void)[] = [];

  // -- dedup + own-post tracking --------------------------------------------

  const delivered = new Set<string>();
  const recentSent = new Set<string>();

  // -- channel-settled read receipts (ported from the codex bridge) ---------

  const channelPendingCounts = new Map<string, number>();
  const channelFailedPosts = new Map<string, Set<string>>();

  const channelSettled = (channelId: string): boolean =>
    (channelPendingCounts.get(channelId) ?? 0) === 0 &&
    (channelFailedPosts.get(channelId)?.size ?? 0) === 0;

  const notePending = (channelId: string): void => {
    channelPendingCounts.set(channelId, (channelPendingCounts.get(channelId) ?? 0) + 1);
  };

  function resolvePending(channelId: string, messageId: string, deliveredOk: boolean): void {
    const count = (channelPendingCounts.get(channelId) ?? 1) - 1;
    if (count <= 0) channelPendingCounts.delete(channelId);
    else channelPendingCounts.set(channelId, count);

    const failed = channelFailedPosts.get(channelId);
    if (deliveredOk) {
      // A success for a previously-failed post is its redelivery landing.
      if (failed?.delete(messageId) && failed.size === 0) channelFailedPosts.delete(channelId);
    } else if (failed) {
      failed.add(messageId);
    } else {
      channelFailedPosts.set(channelId, new Set([messageId]));
    }
  }

  async function markReadWithRetry(channelId: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await client.markRead(channelId);
        return;
      } catch (err) {
        log(`mark-read failed for channel ${channelId} (attempt ${attempt})`, err);
        if (attempt >= 2) return; // stays unread; catch-up may redeliver (dedup absorbs it)
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  function scheduleReadReceipt(channelId: string, messageId: string): void {
    setTimeout(() => {
      // Re-check at fire time: a post that arrived during the UX delay
      // reopens the backlog; ITS completion schedules the receipt instead.
      if (!channelSettled(channelId)) return;
      void markReadWithRetry(channelId);
      client.addReaction(channelId, messageId, "eyes").catch(() => {});
    }, config.receiptDelayMs ?? 1500);
  }

  // -- per-conversation serialization ----------------------------------------

  const queues = new Map<string, Promise<void>>();

  function enqueue(key: string, task: () => Promise<void>): void {
    const prior = queues.get(key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(task);
    queues.set(key, next);
    // Prune settled chains so `queues` doesn't grow one entry per conversation forever.
    void next.catch(() => {}).finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    });
  }

  // -- attachment localization (turn modes) ----------------------------------

  async function localizeAttachments(message: Message): Promise<AgentFile[]> {
    const files: AgentFile[] = [];
    for (const attachment of message.attachments ?? []) {
      const name = sanitizeFilename(attachment.name ?? attachment.id);
      if (attachment.size !== undefined && attachment.size > maxFileBytes) {
        files.push({ name, error: `exceeds the ${maxFileBytes}-byte cap` });
        continue;
      }
      try {
        const bytes = await client.downloadAttachment(attachment.id);
        if (bytes.byteLength > maxFileBytes) {
          files.push({ name, error: `exceeds the ${maxFileBytes}-byte cap` });
          continue;
        }
        mkdirSync(downloadsDir, { recursive: true, mode: 0o700 });
        const path = join(
          downloadsDir,
          `${attachment.id.replace(/[^A-Za-z0-9._-]/g, "_").slice(-24)}-${name}`
        );
        writeFileSync(path, bytes, { mode: 0o600 });
        files.push({ name, path, mimeType: attachment.mimeType, size: bytes.byteLength });
      } catch (err) {
        // Report in the prompt without failing the turn.
        files.push({ name, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return files;
  }

  // -- the inbound pipeline ----------------------------------------------------

  async function processMessage(message: Message): Promise<void> {
    if (!message.id || !message.channelId || !message.senderId) return;
    if (message.senderId === self.id) return;

    // Dedup across live/catch-up paths (undone if the turn fails).
    if (delivered.has(message.id)) return;
    cappedAdd(delivered, message.id, DELIVERED_CAP);

    const kind = (await client.getChannel(message.channelId)).kind;
    const isDM = kind === "dm" || kind === "group_dm";

    const mentioned =
      (message.mentions?.includes(self.id) ?? false) ||
      (!!self.username && new RegExp(`@${escapeRegExp(self.username)}\\b`).test(message.text)) ||
      (!!message.threadId && recentSent.has(message.threadId));

    const access = readAccess(accessFile);
    let dirty = pruneExpired(access);
    const { result, mutated } = gate(access, {
      senderId: message.senderId,
      channelId: message.channelId,
      isDM,
      mentioned,
    });
    if (dirty || mutated) saveAccess(accessFile, access);

    if (result.action === "drop") return;
    if (result.action === "pair") {
      const pairing = config.pairingInstructions ?? DEFAULT_PAIRING;
      await client.sendMessage(message.channelId, {
        text: pairing(result.code, result.isResend),
      });
      return;
    }

    if (isDM) guard.noteSender(message.channelId, message.senderId);

    const conversation = conversationFor(message, isDM);
    const username = await client
      .getUser(message.senderId)
      .then((u) => u.username ?? message.senderId)
      .catch(() => message.senderId);

    const meta: Record<string, string> = {
      chat_id: message.channelId,
      message_id: message.id,
      user: username,
      user_id: message.senderId,
      ts: new Date(message.createdAt).toISOString(),
    };
    if (config.botName) meta.bot = config.botName;
    if (message.threadId) meta.thread_id = message.threadId;
    if (message.attachments?.length) {
      meta.attachment_count = String(message.attachments.length);
      meta.attachments = JSON.stringify(message.attachments);
    }

    notePending(message.channelId);
    enqueue(conversation.key, async () => {
      try {
        const files =
          agent.needsLocalFiles && message.attachments?.length
            ? await localizeAttachments(message)
            : undefined;

        const reply = await agent.send(conversation.key, { text: message.text, meta, files });
        if (reply) {
          const sent = await client.sendMessage(conversation.channelId, {
            text: reply.text,
            threadId: conversation.threadId,
          });
          if (sent.id) cappedAdd(recentSent, sent.id, RECENT_SENT_CAP);
        }

        // Only after the agent handled it (and any reply was posted) — and
        // only once nothing else is pending — may the read receipt fire.
        resolvePending(message.channelId, message.id, true);
        if (channelSettled(message.channelId)) {
          scheduleReadReceipt(message.channelId, message.id);
        }
      } catch (err) {
        // Turn or reply post failed: undo dedup and hold the channel's
        // receipt so catch-up redelivers (at-least-once).
        delivered.delete(message.id);
        resolvePending(message.channelId, message.id, false);
        log(`turn failed for message ${message.id}; leaving channel unread for catch-up`, err);
        if (config.errorNotice) {
          await client
            .sendMessage(conversation.channelId, {
              text: config.errorNotice,
              threadId: conversation.threadId,
            })
            .catch(() => {});
        }
      }
    });
  }

  // -- catch-up -----------------------------------------------------------------

  async function catchUp(): Promise<void> {
    const tail = config.neverViewedTailLimit ?? 20;
    let channels;
    try {
      channels = await client.listChannels();
    } catch (err) {
      log("catch-up: listChannels failed", err);
      return;
    }
    for (const channel of channels) {
      try {
        const readState = await client.getReadState(channel.id);
        const neverViewed = readState.lastViewedAt <= 0;
        if (!neverViewed && (readState.unreadCount ?? 0) === 0) continue;

        const messages = neverViewed
          ? await client.fetchMessages(channel.id, { limit: tail })
          : await client.fetchMessages(channel.id, { since: readState.lastViewedAt });
        // Create-time cutoff: since-fetches can match on update time (edits,
        // our own reaction bumps) — never redeliver already-answered posts.
        const fresh = neverViewed
          ? messages
          : messages.filter((m) => m.createdAt > readState.lastViewedAt);
        for (const message of fresh) await processMessage(message);
      } catch (err) {
        log(`catch-up error on channel ${channel.id}`, err);
      }
    }
  }

  // -- pairing approvals (CLI writes approved/<senderId> with the chat id) -----

  async function checkApprovals(): Promise<void> {
    let files: string[];
    try {
      files = readdirSync(approvedDir);
    } catch {
      return;
    }
    for (const senderId of files) {
      if (!/^[A-Za-z0-9@:._-]+$/.test(senderId)) {
        log(`skipping invalid approval file: ${senderId}`);
        continue;
      }
      const file = join(approvedDir, senderId);
      try {
        const chatId = readFileSync(file, "utf-8").trim();
        if (!chatId || /\s/.test(chatId)) {
          rmSync(file, { force: true });
          continue;
        }
        await client.sendMessage(chatId, {
          text: config.pairedNotice ?? "Paired! You can now send messages here.",
        });
        rmSync(file, { force: true });
        log(`approved sender ${senderId}`);
      } catch (err) {
        log(`approval confirmation failed for ${senderId}`, err);
      }
    }
  }

  // -- lifecycle ------------------------------------------------------------------

  return {
    guard,

    async start(): Promise<void> {
      for (const dir of [config.stateDir, approvedDir]) {
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      self = await client.self();
      await agent.start();

      // Handlers before connect: 'connected' fires during connect().
      unsubscribes.push(
        client.on("message", (message) => {
          void processMessage(message).catch((err) => log("message processing failed", err));
        }),
        client.on("connected", () => {
          void catchUp().catch((err) => log("catch-up failed", err));
        })
      );
      await client.connect();

      const pollMs = config.approvalPollMs ?? 5000;
      if (pollMs > 0) {
        approvalTimer = setInterval(() => void checkApprovals(), pollMs);
        approvalTimer.unref?.();
      }
    },

    async stop(): Promise<void> {
      if (approvalTimer) clearInterval(approvalTimer);
      for (const unsubscribe of unsubscribes) unsubscribe();
      await agent.stop();
      await client.disconnect();
    },
  };
}
