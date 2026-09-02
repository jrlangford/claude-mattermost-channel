import { describe, expect, test } from "bun:test";
import { selectCatchUpPosts } from "./catchup.ts";

// Timeline distilled from the 2026-07-06 incident (beads-ie1xz):
// a message was delivered and the channel viewed (read pointer = 1000);
// the agent's reply then removed the 👀 reaction, bumping the answered
// post's update_at past the pointer, so MM's since-fetch returns it on
// the next reconnect alongside anything genuinely new.
const LAST_VIEWED = 1000;

test("post created before the read pointer is NOT redelivered even when the since-fetch returns it (👀-bump, beads-ie1xz)", () => {
  const data = {
    order: ["answered", "fresh"],
    posts: {
      // created 900 < viewed 1000: only present because it was *modified*
      answered: { id: "answered", create_at: 900 },
      // created 1500 > viewed 1000: arrived while disconnected
      fresh: { id: "fresh", create_at: 1500 },
    },
  };
  expect(selectCatchUpPosts(data, LAST_VIEWED).map((p) => p.id)).toEqual([
    "fresh",
  ]);
});

test("post created in the same millisecond as the view is treated as already seen (boundary)", () => {
  const data = {
    order: ["boundary"],
    posts: { boundary: { id: "boundary", create_at: LAST_VIEWED } },
  };
  expect(selectCatchUpPosts(data, LAST_VIEWED)).toEqual([]);
});

test("posts created while disconnected are all kept, oldest first", () => {
  const data = {
    order: ["b", "a", "c"],
    posts: {
      a: { id: "a", create_at: 1100 },
      b: { id: "b", create_at: 1300 },
      c: { id: "c", create_at: 1200 },
    },
  };
  expect(selectCatchUpPosts(data, LAST_VIEWED).map((p) => p.id)).toEqual([
    "a",
    "c",
    "b",
  ]);
});

test("order ids missing from posts, and posts without create_at, are skipped", () => {
  const data = {
    order: ["ghost", "zero", "ok"],
    posts: {
      zero: { id: "zero", create_at: 0 },
      ok: { id: "ok", create_at: 2000 },
    },
  };
  expect(selectCatchUpPosts(data, LAST_VIEWED).map((p) => p.id)).toEqual([
    "ok",
  ]);
});

test("missing order yields no posts", () => {
  expect(selectCatchUpPosts({ posts: {} }, LAST_VIEWED)).toEqual([]);
});

// ---------------------------------------------------------------------------
// beads-vrp11: catch-up caps
import { CATCHUP_DEFAULTS, CatchUpBudget, catchUpCapsFromEnv, orderCatchUpChannels } from "./catchup.ts";

const posts = (n: number, prefix = "p") => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}`, create_at: 1000 + i }));

describe("catch-up caps (vrp11)", () => {
  test("REGRESSION vrp11: 2,949 unread posts in one public channel deliver only the newest 25 and report the rest as skipped", () => {
    const b = new CatchUpBudget(CATCHUP_DEFAULTS);
    const r = b.plan("O", posts(2949));
    expect(r.deliver.length).toBe(25);
    expect(r.skipped).toBe(2924);
    expect(r.deliver[0]!.id).toBe("p2925"); // oldest of the newest 25
    expect(r.deliver[24]!.id).toBe("p2949"); // the newest post, delivered last (chronological)
    expect(b.delivered).toBe(25);
  });

  test("per-channel cap keeps chronological order and never delivers more than the channel has", () => {
    const b = new CatchUpBudget({ maxPerChannel: 3, maxTotal: 100 });
    expect(b.plan("P", posts(2)).deliver.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(b.plan("P", posts(5)).deliver.map((p) => p.id)).toEqual(["p3", "p4", "p5"]);
    expect(b.plan("P", [])).toEqual({ deliver: [], skipped: 0 });
  });

  test("total budget: public channels get nothing once exhausted; DM/pairwise channels still surface their newest post with the skipped count", () => {
    const b = new CatchUpBudget({ maxPerChannel: 25, maxTotal: 30 });
    expect(b.plan("O", posts(40)).deliver.length).toBe(25); // 25 used
    expect(b.plan("O", posts(40)).deliver.length).toBe(5); // budget → 30
    expect(b.plan("O", posts(9))).toEqual({ deliver: [], skipped: 9 }); // public: flushed, nothing delivered
    const dm = b.plan("D", posts(4));
    expect(dm.deliver.map((p) => p.id)).toEqual(["p4"]); // conversation: newest survives
    expect(dm.skipped).toBe(3);
    expect(b.plan("P", posts(1))).toEqual({ deliver: [{ id: "p1", create_at: 1000 }], skipped: 0 });
  });

  test("service order: DMs, group DMs, pairwise, then public — so a busy public channel cannot starve conversations", () => {
    const order = orderCatchUpChannels([
      { id: "pub", type: "O" }, { id: "pair", type: "P" }, { id: "dm", type: "D" }, { id: "grp", type: "G" }, { id: "unknown" },
    ]).map((c) => c.id);
    expect(order).toEqual(["dm", "grp", "pair", "pub", "unknown"]);
  });

  test("themis 2026-09-02 shape end to end: a DM and a 2,946-post public channel → the DM is fully delivered first, the public channel is capped", () => {
    const b = new CatchUpBudget(CATCHUP_DEFAULTS);
    const channels = orderCatchUpChannels([{ id: "prs", type: "O", posts: posts(2946, "prs") }, { id: "jonnie", type: "D", posts: posts(4, "dm") }]);
    const out = channels.map((c) => ({ id: c.id, ...b.plan(c.type, c.posts) }));
    expect(out[0]!.id).toBe("jonnie");
    expect(out[0]!.deliver.length).toBe(4);
    expect(out[0]!.skipped).toBe(0);
    expect(out[1]!).toMatchObject({ id: "prs", skipped: 2921 });
    expect(out[1]!.deliver.length).toBe(25);
    expect(b.delivered).toBe(29);
  });

  test("env knobs: defaults 25/100, parsed when set, garbage or <1 falls back", () => {
    expect(catchUpCapsFromEnv({})).toEqual({ maxPerChannel: 25, maxTotal: 100 });
    expect(catchUpCapsFromEnv({ MM_CATCHUP_MAX_PER_CHANNEL: "5", MM_CATCHUP_MAX_TOTAL: "12" })).toEqual({ maxPerChannel: 5, maxTotal: 12 });
    expect(catchUpCapsFromEnv({ MM_CATCHUP_MAX_PER_CHANNEL: "0", MM_CATCHUP_MAX_TOTAL: "abc" })).toEqual({ maxPerChannel: 25, maxTotal: 100 });
  });
});
