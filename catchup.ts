// Selects which posts from a catch-up fetch are genuinely NEW messages.
//
// The fetch behind this is GET /channels/{id}/posts?since=<last_viewed_at>,
// and Mattermost's `since` filters on update_at (modified-since — it exists
// for client cache sync), NOT create_at. Any mutation of an old post bumps
// its update_at past the read pointer: edits, and — critically — our own
// read-receipt reactions (👀 added on delivery, removed again when the agent
// replies). Without a create_at cutoff, every answered post comes back from
// the since-fetch on every reconnect and gets redelivered as soon as the
// in-process dedup set is gone — i.e. after every restart (beads-ie1xz:
// agents re-answering already-answered questions).
//
// A post created at or before last_viewed_at was already handled when the
// read pointer was set: the view call only ever runs after a successful
// delivery, and delivery failures deliberately skip it, leaving the pointer
// behind that post's create_at. So `create_at > lastViewedAt` is exactly
// "arrived while nobody was looking" — the set catch-up owes at-least-once
// redelivery to.

export type CatchUpPost = {
  id: string;
  create_at: number;
};

export type CatchUpPostList<P extends CatchUpPost> = {
  order?: string[];
  posts: Record<string, P>;
};

export function selectCatchUpPosts<P extends CatchUpPost>(
  data: CatchUpPostList<P>,
  lastViewedAt: number,
): P[] {
  return (data.order ?? [])
    .map((id) => data.posts[id])
    .filter((p): p is P => !!p && !!p.create_at && p.create_at > lastViewedAt)
    .sort((a, b) => a.create_at - b.create_at);
}

// ---------------------------------------------------------------------------
// Catch-up CAPS (beads-vrp11). The since-fetch returns EVERYTHING that arrived
// while the bot was down, and every post is delivered into the session's first
// turn. An agent asleep for three weeks in a busy channel woke into 2,949
// posts / 11 MB and its first turn was rejected ("Prompt is too long") — alive
// but inference-dead, every later message eaten by a dead turn (zeph 09-01,
// themis 09-02). Caps make catch-up bounded and make the truncation VISIBLE:
// the first delivered envelope of a truncated channel carries
// catchup_skipped="K" catchup_cap="N", never a silent drop.
//
// Order of service: DMs (D), group DMs (G), private/pairwise (P), public (O) —
// conversations first, so a busy public channel can never starve real work.
// The total budget is soft for conversations: once exhausted, a D/G/P channel
// still surfaces its NEWEST post (with the skipped count); public channels
// get nothing and are flushed.

export type CatchUpCaps = { maxPerChannel: number; maxTotal: number };
export const CATCHUP_DEFAULTS: CatchUpCaps = { maxPerChannel: 25, maxTotal: 100 };

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

/** MM_CATCHUP_MAX_PER_CHANNEL / MM_CATCHUP_MAX_TOTAL — minimum 1 each. */
export function catchUpCapsFromEnv(env: Record<string, string | undefined> = process.env): CatchUpCaps {
  return {
    maxPerChannel: positiveInt(env.MM_CATCHUP_MAX_PER_CHANNEL, CATCHUP_DEFAULTS.maxPerChannel),
    maxTotal: positiveInt(env.MM_CATCHUP_MAX_TOTAL, CATCHUP_DEFAULTS.maxTotal),
  };
}

const CHANNEL_RANK: Record<string, number> = { D: 0, G: 1, P: 2, O: 3 };

/** Conversations first (D, G, P), public channels last; stable within a rank. */
export function orderCatchUpChannels<C extends { type?: string }>(channels: C[]): C[] {
  return [...channels].sort(
    (a, b) => (CHANNEL_RANK[a.type ?? ""] ?? 4) - (CHANNEL_RANK[b.type ?? ""] ?? 4),
  );
}

export function isConversationChannel(type: string | undefined): boolean {
  return type === "D" || type === "G" || type === "P";
}

/** Per-connect budget. Call plan() once per channel, in service order, with the
 *  channel's genuinely-new posts sorted OLDEST→NEWEST (selectCatchUpPosts).
 *  Returns the posts to deliver (still oldest→newest) and how many older ones
 *  are skipped. */
export class CatchUpBudget {
  private used = 0;
  constructor(private readonly caps: CatchUpCaps) {}

  plan<P>(channelType: string | undefined, posts: P[]): { deliver: P[]; skipped: number } {
    const n = posts.length;
    if (n === 0) return { deliver: [], skipped: 0 };
    const remaining = Math.max(0, this.caps.maxTotal - this.used);
    let allow = Math.min(n, this.caps.maxPerChannel, remaining);
    if (allow === 0 && isConversationChannel(channelType)) allow = 1;
    this.used += allow;
    return { deliver: posts.slice(n - allow), skipped: n - allow };
  }

  get delivered(): number {
    return this.used;
  }
}
