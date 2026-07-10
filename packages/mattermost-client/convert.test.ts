import { describe, expect, test } from "bun:test";
import {
  channelFromMM,
  channelKindFromType,
  describeAttachments,
  flattenPostList,
  postToMessage,
  userFromMM,
} from "./convert.ts";

// Ported from mattermost-shared's files.test.ts when describeAttachments
// moved here.
describe("describeAttachments", () => {
  test("uses embedded metadata when present", () => {
    expect(
      describeAttachments({
        file_ids: ["f1"],
        metadata: { files: [{ id: "f1", name: "a.pdf", size: 9, mime_type: "application/pdf" }] },
      })
    ).toEqual([{ id: "f1", name: "a.pdf", size: 9, mime_type: "application/pdf" }]);
  });

  test("falls back to bare ids without metadata", () => {
    expect(describeAttachments({ file_ids: ["f1"] })).toEqual([{ id: "f1", name: "f1" }]);
  });

  test("sanitizes hostile names from metadata", () => {
    const [a] = describeAttachments({
      file_ids: ["f1"],
      metadata: { files: [{ id: "f1", name: "../../evil.sh" }] },
    });
    expect(a!.name).toBe("evil.sh");
  });

  test("derives ids from metadata when file_ids is absent", () => {
    expect(describeAttachments({ metadata: { files: [{ id: "f2", name: "b.txt" }] } })).toEqual([
      { id: "f2", name: "b.txt" },
    ]);
  });

  test("empty post yields empty list", () => {
    expect(describeAttachments({})).toEqual([]);
  });
});

describe("channelKindFromType", () => {
  test("maps all four Mattermost types", () => {
    expect(channelKindFromType("D")).toBe("dm");
    expect(channelKindFromType("G")).toBe("group_dm");
    expect(channelKindFromType("P")).toBe("private");
    expect(channelKindFromType("O")).toBe("public");
  });

  test("unknown/missing types default to public (safe non-DM gating path)", () => {
    expect(channelKindFromType(undefined)).toBe("public");
    expect(channelKindFromType("X")).toBe("public");
  });
});

describe("postToMessage", () => {
  const base = { id: "p1", channel_id: "c1", user_id: "u1", message: "hi", create_at: 100 };

  test("maps core fields and keeps the raw post", () => {
    const msg = postToMessage(base);
    expect(msg).toMatchObject({
      id: "p1",
      channelId: "c1",
      senderId: "u1",
      text: "hi",
      createdAt: 100,
    });
    expect(msg.raw).toBe(base);
  });

  test("empty root_id and zero edit_at become undefined", () => {
    const msg = postToMessage({ ...base, root_id: "", edit_at: 0 });
    expect(msg.threadId).toBeUndefined();
    expect(msg.editedAt).toBeUndefined();
  });

  test("threaded, edited posts carry threadId and editedAt", () => {
    const msg = postToMessage({ ...base, root_id: "root1", edit_at: 200 });
    expect(msg.threadId).toBe("root1");
    expect(msg.editedAt).toBe(200);
  });

  test("attachments come from metadata with mime_type mapped and names sanitized", () => {
    const msg = postToMessage({
      ...base,
      file_ids: ["f1"],
      metadata: {
        files: [{ id: "f1", name: "../../evil.pdf", size: 42, mime_type: "application/pdf" }],
      },
    });
    expect(msg.attachments).toEqual([
      { id: "f1", name: "evil.pdf", size: 42, mimeType: "application/pdf" },
    ]);
  });

  test("no attachments/mentions yield undefined, not empty arrays", () => {
    const msg = postToMessage(base, []);
    expect(msg.attachments).toBeUndefined();
    expect(msg.mentions).toBeUndefined();
  });

  test("mentions pass through when present", () => {
    expect(postToMessage(base, ["u2", "u3"]).mentions).toEqual(["u2", "u3"]);
  });
});

describe("flattenPostList", () => {
  const posts = {
    a: { id: "a", channel_id: "c1", create_at: 300 },
    b: { id: "b", channel_id: "c1", create_at: 100 },
    c: { id: "c", channel_id: "c1", create_at: 200 },
  };

  test("returns oldest-first regardless of order (Mattermost sends newest-first)", () => {
    const msgs = flattenPostList({ order: ["a", "c", "b"], posts });
    expect(msgs.map((m) => m.id)).toEqual(["b", "c", "a"]);
  });

  test("ids missing from posts are skipped", () => {
    const msgs = flattenPostList({ order: ["a", "ghost"], posts });
    expect(msgs.map((m) => m.id)).toEqual(["a"]);
  });

  test("missing order falls back to the posts map", () => {
    const msgs = flattenPostList({ posts });
    expect(msgs.map((m) => m.id)).toEqual(["b", "c", "a"]);
  });

  test("empty list yields no messages", () => {
    expect(flattenPostList({})).toEqual([]);
  });
});

describe("userFromMM / channelFromMM", () => {
  test("nickname becomes displayName; empty nickname is dropped", () => {
    expect(userFromMM({ id: "u1", username: "amelia", nickname: "Amelia" })).toEqual({
      id: "u1",
      username: "amelia",
      displayName: "Amelia",
      isBot: undefined,
    });
    expect(userFromMM({ id: "u1", nickname: "" }).displayName).toBeUndefined();
  });

  test("display_name preferred over name; both empty drops name", () => {
    expect(channelFromMM({ id: "c1", type: "O", display_name: "Town", name: "town" }).name).toBe(
      "Town"
    );
    expect(channelFromMM({ id: "c1", type: "D", display_name: "", name: "" }).name).toBeUndefined();
  });
});
