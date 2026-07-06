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
