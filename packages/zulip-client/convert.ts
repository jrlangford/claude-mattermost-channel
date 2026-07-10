// Pure wire-format mapping for the Zulip adapter — no I/O, unit-testable.
//
// Zulip's model differs from Mattermost/Matrix in two load-bearing ways:
//
// - DM conversations have no server-side channel id: a direct-message
//   "channel" is just the set of participant user ids. We encode channel ids
//   as `stream:<stream_id>` and `dm:<sorted,comma-joined user ids>` (all
//   participants, self included) so every message can be routed back.
// - Streams have no threads; they have TOPICS, and every stream message
//   carries one. Topics map onto the contract's threadId (opaque string):
//   Message.threadId is the topic, and sendMessage({threadId}) posts to that
//   topic. DMs have no topics, so DM messages are unthreaded.

import { MessagingClientError, sanitizeFilename } from "messaging-client";
import type { Attachment, Channel, ChannelId, Message, User } from "messaging-client";

// ---- wire types (the fields we read; everything else rides in `raw`) ------

export type ZulipUser = {
  user_id: number;
  full_name?: string;
  delivery_email?: string;
  email?: string;
  is_bot?: boolean;
};

export type ZulipStream = {
  stream_id: number;
  name?: string;
  invite_only?: boolean;
};

export type ZulipMessage = {
  id: number;
  type: "stream" | "private";
  content: string;
  timestamp: number; // UTC seconds
  sender_id: number;
  /** Topic name; "" for direct messages. */
  subject?: string;
  stream_id?: number;
  /** Stream name (string) for stream messages; participant list for DMs. */
  display_recipient?: string | { id: number }[];
  last_edit_timestamp?: number;
};

// ---- channel-id scheme ------------------------------------------------------

export function dmChannelId(userIds: number[]): ChannelId {
  return `dm:${[...new Set(userIds)].sort((a, b) => a - b).join(",")}`;
}

export function streamChannelId(streamId: number): ChannelId {
  return `stream:${streamId}`;
}

export type ParsedChannelId =
  | { kind: "stream"; streamId: number }
  | { kind: "dm"; userIds: number[] };

export function parseChannelId(channelId: ChannelId): ParsedChannelId {
  const stream = /^stream:(\d+)$/.exec(channelId);
  if (stream) return { kind: "stream", streamId: Number(stream[1]) };
  const dm = /^dm:(\d+(?:,\d+)*)$/.exec(channelId);
  if (dm) return { kind: "dm", userIds: dm[1]!.split(",").map(Number) };
  throw new MessagingClientError(
    "invalid_request",
    `zulip channel ids look like "stream:<id>" or "dm:<id,id,...>" (got "${channelId}")`
  );
}

export function channelIdForMessage(msg: ZulipMessage): ChannelId {
  if (msg.type === "stream") {
    if (msg.stream_id === undefined) {
      throw new MessagingClientError("unknown", `zulip stream message ${msg.id} has no stream_id`);
    }
    return streamChannelId(msg.stream_id);
  }
  const recipients = Array.isArray(msg.display_recipient) ? msg.display_recipient : [];
  if (recipients.length === 0) {
    throw new MessagingClientError("unknown", `zulip dm ${msg.id} has no display_recipient list`);
  }
  return dmChannelId(recipients.map((r) => r.id));
}

// ---- attachments ------------------------------------------------------------

// Zulip has no attachment objects on messages: uploads are markdown links to
// /user_uploads/... paths inside the content. The path IS the attachment id.
const UPLOAD_LINK = /\[([^\]]*)\]\((\/user_uploads\/[^)\s]+)\)/g;

export function attachmentsFromContent(content: string): Attachment[] | undefined {
  const found: Attachment[] = [];
  for (const match of content.matchAll(UPLOAD_LINK)) {
    const path = match[2]!;
    const label = match[1] || path.split("/").pop() || "file";
    // Names are remote-sender input — sanitize like every other adapter.
    found.push({ id: path, name: sanitizeFilename(label) });
  }
  return found.length > 0 ? found : undefined;
}

// ---- conversions ------------------------------------------------------------

export function messageFromZulip(msg: ZulipMessage): Message {
  return {
    id: String(msg.id),
    channelId: channelIdForMessage(msg),
    senderId: String(msg.sender_id),
    text: msg.content,
    createdAt: msg.timestamp * 1000,
    ...(msg.last_edit_timestamp ? { editedAt: msg.last_edit_timestamp * 1000 } : {}),
    // Topics are Zulip's threads; "" (DMs / general chat) means unthreaded.
    ...(msg.type === "stream" && msg.subject ? { threadId: msg.subject } : {}),
    ...(attachmentsFromContent(msg.content) ? { attachments: attachmentsFromContent(msg.content) } : {}),
    raw: msg,
  };
}

export function userFromZulip(user: ZulipUser): User {
  const email = user.delivery_email ?? user.email;
  return {
    id: String(user.user_id),
    // Zulip mentions are @**Full Name**, not handles; the email localpart is
    // the closest stable handle the API offers.
    ...(email ? { username: email.split("@")[0] } : {}),
    ...(user.full_name ? { displayName: user.full_name } : {}),
    ...(user.is_bot !== undefined ? { isBot: user.is_bot } : {}),
  };
}

export function channelFromStream(stream: ZulipStream): Channel {
  return {
    id: streamChannelId(stream.stream_id),
    kind: stream.invite_only ? "private" : "public",
    ...(stream.name ? { name: stream.name } : {}),
  };
}

export function channelFromDmId(channelId: ChannelId): Channel {
  const parsed = parseChannelId(channelId);
  if (parsed.kind !== "dm") {
    throw new MessagingClientError("invalid_request", `${channelId} is not a dm channel id`);
  }
  // 1:1 DMs have two participants (self + other); more is a group DM. A
  // self-DM (single participant) is still "dm".
  return { id: channelId, kind: parsed.userIds.length > 2 ? "group_dm" : "dm" };
}

/** Narrow filter selecting a channel (and optionally a topic) for the API. */
export function narrowFor(
  channelId: ChannelId,
  topic?: string
): { operator: string; operand: string | number | number[] }[] {
  const parsed = parseChannelId(channelId);
  if (parsed.kind === "stream") {
    const narrow: { operator: string; operand: string | number | number[] }[] = [
      { operator: "channel", operand: parsed.streamId },
    ];
    if (topic !== undefined) narrow.push({ operator: "topic", operand: topic });
    return narrow;
  }
  // The dm operand is the participant set; the server normalizes self out.
  return [{ operator: "dm", operand: parsed.userIds }];
}
