// Matrix wire format → messaging-client domain types. Pure functions,
// unit-tested in convert.test.ts; all network I/O lives in matrix.ts.

import {
  sanitizeFilename,
  type Attachment,
  type ChannelKind,
  type Message,
} from "messaging-client";

// -- Matrix wire types (the fields we consume) --

export type MatrixRawEvent = {
  event_id?: string;
  room_id?: string;
  sender?: string;
  type?: string;
  origin_server_ts?: number;
  content?: MatrixMessageContent;
};

export type MatrixMessageContent = {
  msgtype?: string;
  body?: string;
  url?: string; // mxc:// for media messages
  info?: { size?: number; mimetype?: string };
  "m.relates_to"?: { rel_type?: string; event_id?: string; key?: string };
  "m.new_content"?: { msgtype?: string; body?: string };
  "m.mentions"?: { user_ids?: string[] };
};

const MEDIA_MSGTYPES = new Set(["m.image", "m.file", "m.video", "m.audio"]);

// -- ids ---------------------------------------------------------------------

/** "@itbot:it.local" → "itbot". Mention-stable handle per the contract. */
export function localpart(mxid: string): string {
  const at = mxid.startsWith("@") ? mxid.slice(1) : mxid;
  const colon = at.indexOf(":");
  return colon === -1 ? at : at.slice(0, colon);
}

// -- emoji -------------------------------------------------------------------

// The contract speaks shortcodes ("eyes"); Matrix annotation keys are the
// unicode glyphs themselves. Common shortcodes are mapped; anything already
// non-ASCII passes through untouched (caller sent a real emoji); unknown
// shortcodes fall back to the raw name — Matrix accepts any key string, so
// the reaction still round-trips (add/remove agree), it just renders as text.
const SHORTCODE_TO_EMOJI: Record<string, string> = {
  eyes: "👀",
  "+1": "👍",
  thumbsup: "👍",
  "-1": "👎",
  thumbsdown: "👎",
  heart: "❤️",
  white_check_mark: "✅",
  heavy_check_mark: "✔️",
  x: "❌",
  tada: "🎉",
  rocket: "🚀",
  fire: "🔥",
  smile: "😄",
  laughing: "😆",
  joy: "😂",
  thinking_face: "🤔",
  thinking: "🤔",
  wave: "👋",
  pray: "🙏",
  clap: "👏",
  ok_hand: "👌",
  warning: "⚠️",
  hourglass: "⏳",
  question: "❓",
  exclamation: "❗",
  robot_face: "🤖",
  robot: "🤖",
};

export function emojiFromShortcode(name: string): string {
  const bare = name.replace(/^:|:$/g, "");
  const mapped = SHORTCODE_TO_EMOJI[bare];
  if (mapped) return mapped;
  // Already unicode (or anything non-ASCII) — pass through.
  if (/[^\x20-\x7e]/.test(bare)) return bare;
  return bare;
}

// -- events ------------------------------------------------------------------

/** m.replace relations are edits of an existing message, not new messages. */
export function isEditEvent(event: MatrixRawEvent): boolean {
  return event.content?.["m.relates_to"]?.rel_type === "m.replace";
}

export function isMessageEvent(event: MatrixRawEvent): boolean {
  return event.type === "m.room.message" && !isEditEvent(event);
}

function attachmentsFrom(content: MatrixMessageContent): Attachment[] | undefined {
  if (!MEDIA_MSGTYPES.has(content.msgtype ?? "") || !content.url) return undefined;
  return [
    {
      id: content.url, // AttachmentId for Matrix IS the mxc:// URL
      // For media messages `body` is the filename — remote input, sanitize.
      name: content.body ? sanitizeFilename(content.body) : undefined,
      size: content.info?.size,
      mimeType: content.info?.mimetype,
    },
  ];
}

export function eventToMessage(event: MatrixRawEvent): Message {
  const content = event.content ?? {};
  const attachments = attachmentsFrom(content);
  const relatesTo = content["m.relates_to"];
  const mentions = content["m.mentions"]?.user_ids;
  return {
    id: event.event_id ?? "",
    channelId: event.room_id ?? "",
    senderId: event.sender ?? "",
    // For media messages `body` is the filename, not prose — surface it via
    // the attachment, not as message text.
    text: attachments ? "" : (content.body ?? ""),
    createdAt: event.origin_server_ts ?? 0,
    editedAt: undefined, // edits are separate m.replace events in Matrix
    threadId: relatesTo?.rel_type === "m.thread" ? relatesTo.event_id : undefined,
    attachments,
    mentions: mentions && mentions.length > 0 ? [...mentions] : undefined,
    raw: event,
  };
}

/** Oldest-first Messages from raw events; non-message events skipped. */
export function eventsToMessages(events: MatrixRawEvent[]): Message[] {
  return events
    .filter(isMessageEvent)
    .sort((a, b) => (a.origin_server_ts ?? 0) - (b.origin_server_ts ?? 0))
    .map(eventToMessage);
}

// -- rooms -------------------------------------------------------------------

/**
 * DM-ness is a client convention in Matrix (the m.direct account-data map),
 * not a room property — the adapter passes isDirect from there. group_dm is
 * not modeled (a "DM" with 3+ people is just a private room).
 */
export function kindFromRoom(opts: { isDirect: boolean; joinRule?: string }): ChannelKind {
  if (opts.isDirect) return "dm";
  return opts.joinRule === "public" ? "public" : "private";
}

/** msgtype for an outbound upload, from its mime type. */
export function msgtypeForMime(mimeType: string | undefined): string {
  if (mimeType?.startsWith("image/")) return "m.image";
  if (mimeType?.startsWith("video/")) return "m.video";
  if (mimeType?.startsWith("audio/")) return "m.audio";
  return "m.file";
}

/** "mxc://server/mediaId" → {server, mediaId} (for media download URLs). */
export function parseMxc(mxcUrl: string): { server: string; mediaId: string } | null {
  const match = /^mxc:\/\/([^/]+)\/([^/]+)$/.exec(mxcUrl);
  return match ? { server: match[1]!, mediaId: match[2]! } : null;
}
