import { expect, test } from "bun:test";
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
