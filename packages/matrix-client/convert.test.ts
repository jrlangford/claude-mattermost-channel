import { describe, expect, test } from "bun:test";
import {
  emojiFromShortcode,
  eventToMessage,
  eventsToMessages,
  isEditEvent,
  isMessageEvent,
  kindFromRoom,
  localpart,
  msgtypeForMime,
  parseMxc,
} from "./convert.ts";

describe("localpart", () => {
  test("extracts the mention handle from an MXID", () => {
    expect(localpart("@itbot:it.local")).toBe("itbot");
    expect(localpart("@user:server.example.com")).toBe("user");
  });

  test("tolerates missing @ or domain", () => {
    expect(localpart("itbot:it.local")).toBe("itbot");
    expect(localpart("@bare")).toBe("bare");
  });
});

describe("emojiFromShortcode", () => {
  test("maps common shortcodes to unicode", () => {
    expect(emojiFromShortcode("eyes")).toBe("👀");
    expect(emojiFromShortcode("+1")).toBe("👍");
    expect(emojiFromShortcode("white_check_mark")).toBe("✅");
  });

  test("strips colons", () => {
    expect(emojiFromShortcode(":eyes:")).toBe("👀");
  });

  test("unicode passes through untouched", () => {
    expect(emojiFromShortcode("👀")).toBe("👀");
    expect(emojiFromShortcode("🦄")).toBe("🦄");
  });

  test("unknown shortcodes fall back to the raw name", () => {
    expect(emojiFromShortcode("some_unknown_emoji")).toBe("some_unknown_emoji");
  });
});

describe("event classification", () => {
  const text = {
    event_id: "$e1",
    room_id: "!r1:it.local",
    sender: "@h:it.local",
    type: "m.room.message",
    origin_server_ts: 100,
    content: { msgtype: "m.text", body: "hi" },
  };

  test("plain message is a message event", () => {
    expect(isMessageEvent(text)).toBe(true);
  });

  test("m.replace relations are edits, not messages", () => {
    const edit = {
      ...text,
      content: {
        ...text.content,
        "m.relates_to": { rel_type: "m.replace", event_id: "$e0" },
      },
    };
    expect(isEditEvent(edit)).toBe(true);
    expect(isMessageEvent(edit)).toBe(false);
  });

  test("thread replies ARE messages (m.thread relation)", () => {
    const reply = {
      ...text,
      content: { ...text.content, "m.relates_to": { rel_type: "m.thread", event_id: "$root" } },
    };
    expect(isMessageEvent(reply)).toBe(true);
  });

  test("non-message event types are excluded", () => {
    expect(isMessageEvent({ ...text, type: "m.reaction" })).toBe(false);
  });
});

describe("eventToMessage", () => {
  const base = {
    event_id: "$e1",
    room_id: "!r1:it.local",
    sender: "@h:it.local",
    type: "m.room.message",
    origin_server_ts: 100,
    content: { msgtype: "m.text", body: "hello" },
  };

  test("maps core fields and keeps the raw event", () => {
    const msg = eventToMessage(base);
    expect(msg).toMatchObject({
      id: "$e1",
      channelId: "!r1:it.local",
      senderId: "@h:it.local",
      text: "hello",
      createdAt: 100,
    });
    expect(msg.threadId).toBeUndefined();
    expect(msg.raw).toBe(base);
  });

  test("thread relation becomes threadId", () => {
    const msg = eventToMessage({
      ...base,
      content: { ...base.content, "m.relates_to": { rel_type: "m.thread", event_id: "$root" } },
    });
    expect(msg.threadId).toBe("$root");
  });

  test("media events become attachments with sanitized names and empty text", () => {
    const msg = eventToMessage({
      ...base,
      content: {
        msgtype: "m.file",
        body: "../../evil.pdf",
        url: "mxc://it.local/abc123",
        info: { size: 42, mimetype: "application/pdf" },
      },
    });
    expect(msg.text).toBe("");
    expect(msg.attachments).toEqual([
      { id: "mxc://it.local/abc123", name: "evil.pdf", size: 42, mimeType: "application/pdf" },
    ]);
  });

  test("m.mentions surface as mentions; empty list becomes undefined", () => {
    const withMentions = eventToMessage({
      ...base,
      content: { ...base.content, "m.mentions": { user_ids: ["@itbot:it.local"] } },
    });
    expect(withMentions.mentions).toEqual(["@itbot:it.local"]);

    const empty = eventToMessage({
      ...base,
      content: { ...base.content, "m.mentions": { user_ids: [] } },
    });
    expect(empty.mentions).toBeUndefined();
  });
});

describe("eventsToMessages", () => {
  test("sorts oldest-first and drops non-messages and edits", () => {
    const mk = (id: string, ts: number, extra?: object) => ({
      event_id: id,
      room_id: "!r1:it.local",
      sender: "@h:it.local",
      type: "m.room.message",
      origin_server_ts: ts,
      content: { msgtype: "m.text", body: id, ...extra },
    });
    const messages = eventsToMessages([
      mk("$c", 300),
      mk("$a", 100),
      { ...mk("$x", 250), type: "m.reaction" },
      mk("$edit", 275, { "m.relates_to": { rel_type: "m.replace", event_id: "$a" } }),
      mk("$b", 200),
    ]);
    expect(messages.map((m) => m.id)).toEqual(["$a", "$b", "$c"]);
  });
});

describe("kindFromRoom / msgtypeForMime / parseMxc", () => {
  test("m.direct rooms are dm; join rule decides public vs private", () => {
    expect(kindFromRoom({ isDirect: true, joinRule: "invite" })).toBe("dm");
    expect(kindFromRoom({ isDirect: false, joinRule: "public" })).toBe("public");
    expect(kindFromRoom({ isDirect: false, joinRule: "invite" })).toBe("private");
    expect(kindFromRoom({ isDirect: false })).toBe("private");
  });

  test("msgtype from mime prefix, m.file fallback", () => {
    expect(msgtypeForMime("image/png")).toBe("m.image");
    expect(msgtypeForMime("video/mp4")).toBe("m.video");
    expect(msgtypeForMime("audio/ogg")).toBe("m.audio");
    expect(msgtypeForMime("application/pdf")).toBe("m.file");
    expect(msgtypeForMime(undefined)).toBe("m.file");
  });

  test("parseMxc round-trips well-formed URLs and rejects junk", () => {
    expect(parseMxc("mxc://it.local/abc123")).toEqual({ server: "it.local", mediaId: "abc123" });
    expect(parseMxc("https://example.com/x")).toBeNull();
    expect(parseMxc("mxc://missing-media")).toBeNull();
  });
});
