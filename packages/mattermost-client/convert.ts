// Mattermost wire format → messaging-client domain types. Pure functions,
// unit-tested in convert.test.ts; all network I/O lives in mattermost.ts.

import {
  sanitizeFilename,
  type Attachment,
  type Channel,
  type ChannelKind,
  type Message,
  type User,
} from "messaging-client";

// -- Mattermost wire types (the fields we consume) --

export type MMFileInfo = {
  id: string;
  name?: string;
  size?: number;
  mime_type?: string;
  post_id?: string;
};

export type AttachmentSummary = {
  id: string;
  name: string;
  size?: number;
  mime_type?: string;
};

// Summarize a post's attachments. Prefers the post's embedded
// metadata.files (present on WS events and REST fetches); falls back to
// bare ids when only file_ids is available. Names are sanitized here —
// they end up inside envelope metadata read by a model.
export function describeAttachments(post: {
  file_ids?: string[];
  metadata?: { files?: MMFileInfo[] };
}): AttachmentSummary[] {
  const infos = new Map<string, MMFileInfo>();
  for (const f of post.metadata?.files ?? []) {
    if (f && typeof f.id === "string") infos.set(f.id, f);
  }
  const ids = post.file_ids?.length ? post.file_ids : [...infos.keys()];
  return ids.map((id) => {
    const info = infos.get(id);
    const out: AttachmentSummary = {
      id,
      name: sanitizeFilename(info?.name ?? id),
    };
    if (typeof info?.size === "number") out.size = info.size;
    if (typeof info?.mime_type === "string") out.mime_type = info.mime_type;
    return out;
  });
}

export type MMUser = {
  id: string;
  username?: string;
  nickname?: string;
  is_bot?: boolean;
};

export type MMChannel = {
  id: string;
  type?: string; // D = direct, G = group DM, P = private, O = open
  display_name?: string;
  name?: string;
};

export type MMPost = {
  id: string;
  channel_id: string;
  user_id?: string;
  message?: string;
  create_at: number;
  edit_at?: number;
  root_id?: string;
  file_ids?: string[];
  metadata?: { files?: MMFileInfo[] };
};

export type MMPostList = {
  order?: string[];
  posts?: Record<string, MMPost>;
};

// -- conversions --

export function channelKindFromType(type: string | undefined): ChannelKind {
  switch (type) {
    case "D":
      return "dm";
    case "G":
      return "group_dm";
    case "P":
      return "private";
    default:
      // O (open) and anything unknown. Defaulting unknown to non-DM is the
      // safe direction for access gating (group policy is the stricter path).
      return "public";
  }
}

export function channelFromMM(ch: MMChannel): Channel {
  return {
    id: ch.id,
    kind: channelKindFromType(ch.type),
    name: ch.display_name || ch.name || undefined,
  };
}

export function userFromMM(user: MMUser): User {
  return {
    id: user.id,
    username: user.username,
    displayName: user.nickname || undefined,
    isBot: user.is_bot,
  };
}

export function attachmentFromMM(info: MMFileInfo): Attachment {
  return {
    id: info.id,
    // Filenames come from remote users — sanitize at the boundary, same as
    // describeAttachments does for per-post metadata.
    name: info.name != null ? sanitizeFilename(info.name) : undefined,
    size: info.size,
    mimeType: info.mime_type,
  };
}

export function postToMessage(post: MMPost, mentions?: string[]): Message {
  const attachments = describeAttachments(post).map((a) => ({
    id: a.id,
    name: a.name,
    size: a.size,
    mimeType: a.mime_type,
  }));
  return {
    id: post.id,
    channelId: post.channel_id,
    senderId: post.user_id ?? "",
    text: post.message ?? "",
    createdAt: post.create_at,
    editedAt: post.edit_at && post.edit_at > 0 ? post.edit_at : undefined,
    threadId: post.root_id || undefined,
    attachments: attachments.length > 0 ? attachments : undefined,
    mentions: mentions && mentions.length > 0 ? mentions : undefined,
    raw: post,
  };
}

/**
 * Flatten a Mattermost post list to Messages, oldest-first. Uses `order`
 * when present (it maps ids newest-first), falls back to the posts map, and
 * skips ids with no post body. No create_at cutoff is applied here — that is
 * catch-up policy (the bot core filters on createdAt), not transport.
 */
export function flattenPostList(list: MMPostList): Message[] {
  const posts = list.posts ?? {};
  const ids = list.order ?? Object.keys(posts);
  return ids
    .map((id) => posts[id])
    .filter((post): post is MMPost => post != null)
    .sort((a, b) => a.create_at - b.create_at)
    .map((post) => postToMessage(post));
}
