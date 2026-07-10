// Persisted conversation-id store with idle expiry — common code for turn
// modes that map a conversation key to a backend session/thread id (Codex
// threads, Claude sessions). Long-idle entries expire so a conversation
// starts fresh instead of resuming a stale context.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";

type StoreEntry = { id: string; lastUsedAt: number };
// Legacy entries (from the pre-package codex bridge) are bare id strings
// with no timestamp; treat them as fresh once — they pick up a real
// timestamp on the next set().
type StoreFile = Record<string, StoreEntry | string>;

export type IdleStore = {
  /** The stored id, or undefined when absent or idle-expired. */
  get(key: string): string | undefined;
  /** Store an id and stamp its last-use time. */
  set(key: string, id: string): void;
};

export function createIdleStore(opts: { file: string; maxIdleMs: number }): IdleStore {
  const expired = (lastUsedAt: number): boolean =>
    opts.maxIdleMs > 0 && Date.now() - lastUsedAt > opts.maxIdleMs;

  const read = (): StoreFile => {
    try {
      return JSON.parse(readFileSync(opts.file, "utf-8")) as StoreFile;
    } catch {
      return {};
    }
  };

  return {
    get(key) {
      const entry = read()[key];
      if (entry === undefined) return undefined;
      if (typeof entry === "string") return entry; // legacy: fresh once
      return expired(entry.lastUsedAt) ? undefined : entry.id;
    },
    set(key, id) {
      const store = read();
      store[key] = { id, lastUsedAt: Date.now() };
      // Atomic write: a torn store file would silently reset every
      // conversation. Ids reference private agent state — keep it 0600.
      mkdirSync(dirname(opts.file), { recursive: true, mode: 0o700 });
      const tmp = `${opts.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
      renameSync(tmp, opts.file);
    },
  };
}
