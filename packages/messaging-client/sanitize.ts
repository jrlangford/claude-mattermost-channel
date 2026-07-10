// Attachment filenames come from remote users — never trust them as paths.
// Every adapter sanitizes names at its boundary with this. Keep only a
// conservative character set, drop any directory structure, forbid dotfiles
// and empty results, and cap length so an id-prefixed result stays well
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
