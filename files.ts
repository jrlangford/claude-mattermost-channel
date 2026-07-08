// Attachment helpers — pure functions, unit-tested in files.test.ts.

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

// Filenames come from remote users — never trust them as paths. Keep only a
// conservative character set, drop any directory structure, forbid dotfiles
// and empty results, and cap length so the id-prefixed result stays well
// under filesystem limits.
export function sanitizeFilename(name: unknown): string {
  const base = String(name ?? "")
    .split(/[/\\]/)
    .pop()!
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 100);
  return base.length > 0 ? base : "file";
}

// Summarize a post's attachments for the inbound envelope / fetch_messages.
// Prefers the post's embedded metadata.files (present on WS events and REST
// fetches); falls back to bare ids when only file_ids is available. Names are
// sanitized here too — they end up inside envelope metadata read by a model.
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
