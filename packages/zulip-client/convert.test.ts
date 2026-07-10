import { describe, expect, test } from "bun:test";
import {
  attachmentsFromContent,
  channelFromDmId,
  channelFromStream,
  channelIdForMessage,
  dmChannelId,
  messageFromZulip,
  narrowFor,
  parseChannelId,
  userFromZulip,
  type ZulipMessage,
} from "./convert.ts";

const streamMsg: ZulipMessage = {
  id: 42,
  type: "stream",
  content: "hello world",
  timestamp: 1_700_000_000,
  sender_id: 7,
  subject: "deploys",
  stream_id: 3,
  display_recipient: "town",
};

const dmMsg: ZulipMessage = {
  id: 43,
  type: "private",
  content: "psst",
  timestamp: 1_700_000_001,
  sender_id: 7,
  subject: "",
  display_recipient: [{ id: 9 }, { id: 7 }],
};

describe("channel id scheme", () => {
  test("dm ids are sorted, deduped, and stable", () => {
    expect(dmChannelId([9, 7, 9])).toBe("dm:7,9");
    expect(dmChannelId([7, 9])).toBe(dmChannelId([9, 7]));
  });

  test("round-trips through parseChannelId", () => {
    expect(parseChannelId("stream:3")).toEqual({ kind: "stream", streamId: 3 });
    expect(parseChannelId("dm:7,9")).toEqual({ kind: "dm", userIds: [7, 9] });
  });

  test("rejects garbage ids", () => {
    expect(() => parseChannelId("nonsense")).toThrow("zulip channel ids");
    expect(() => parseChannelId("dm:")).toThrow();
    expect(() => parseChannelId("stream:abc")).toThrow();
  });

  test("derives channel ids from messages", () => {
    expect(channelIdForMessage(streamMsg)).toBe("stream:3");
    expect(channelIdForMessage(dmMsg)).toBe("dm:7,9");
  });
});

describe("messageFromZulip", () => {
  test("maps a stream message, topic becomes threadId", () => {
    const m = messageFromZulip(streamMsg);
    expect(m.id).toBe("42");
    expect(m.channelId).toBe("stream:3");
    expect(m.senderId).toBe("7");
    expect(m.createdAt).toBe(1_700_000_000_000);
    expect(m.threadId).toBe("deploys");
    expect(m.editedAt).toBeUndefined();
  });

  test("DMs are unthreaded and keyed by participant set", () => {
    const m = messageFromZulip(dmMsg);
    expect(m.channelId).toBe("dm:7,9");
    expect(m.threadId).toBeUndefined();
  });

  test("edits surface as editedAt (seconds → ms)", () => {
    const m = messageFromZulip({ ...streamMsg, last_edit_timestamp: 1_700_000_100 });
    expect(m.editedAt).toBe(1_700_000_100_000);
  });
});

describe("attachmentsFromContent", () => {
  test("extracts upload links; the path is the id", () => {
    const atts = attachmentsFromContent(
      "see [report.pdf](/user_uploads/2/ab/XyZ/report.pdf) and text"
    );
    expect(atts).toEqual([{ id: "/user_uploads/2/ab/XyZ/report.pdf", name: "report.pdf" }]);
  });

  test("sanitizes hostile link labels", () => {
    const atts = attachmentsFromContent("[../../evil.sh](/user_uploads/2/ab/XyZ/f.sh)");
    expect(atts![0]!.name).toBe("evil.sh");
  });

  test("ignores non-upload links and returns undefined when none", () => {
    expect(attachmentsFromContent("[site](https://example.com)")).toBeUndefined();
    expect(attachmentsFromContent("plain text")).toBeUndefined();
  });
});

describe("users and channels", () => {
  test("userFromZulip maps ids and email localpart handle", () => {
    expect(
      userFromZulip({ user_id: 7, full_name: "IT Bot", delivery_email: "itbot@e2e.local", is_bot: true })
    ).toEqual({ id: "7", username: "itbot", displayName: "IT Bot", isBot: true });
  });

  test("streams map to public/private channels", () => {
    expect(channelFromStream({ stream_id: 3, name: "town", invite_only: false })).toEqual({
      id: "stream:3",
      kind: "public",
      name: "town",
    });
    expect(channelFromStream({ stream_id: 4, invite_only: true }).kind).toBe("private");
  });

  test("dm channel kind depends on participant count", () => {
    expect(channelFromDmId("dm:7,9").kind).toBe("dm");
    expect(channelFromDmId("dm:1,7,9").kind).toBe("group_dm");
  });
});

describe("narrowFor", () => {
  test("stream narrow with and without topic", () => {
    expect(narrowFor("stream:3")).toEqual([{ operator: "channel", operand: 3 }]);
    expect(narrowFor("stream:3", "deploys")).toEqual([
      { operator: "channel", operand: 3 },
      { operator: "topic", operand: "deploys" },
    ]);
  });

  test("dm narrow carries the participant set", () => {
    expect(narrowFor("dm:7,9")).toEqual([{ operator: "dm", operand: [7, 9] }]);
  });
});
