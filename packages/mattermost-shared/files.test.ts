import { describe, expect, test } from "bun:test";
import { describeAttachments, sanitizeFilename } from "./files.ts";

describe("sanitizeFilename", () => {
  test("keeps ordinary names intact", () => {
    expect(sanitizeFilename("report-2026_final.v2.pdf")).toBe("report-2026_final.v2.pdf");
  });

  test("strips directory traversal", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("..\\..\\windows\\system32\\cmd.exe")).toBe("cmd.exe");
  });

  test("never produces a dotfile or empty name", () => {
    expect(sanitizeFilename("...")).toBe("file");
    expect(sanitizeFilename(".bashrc")).toBe("bashrc");
    expect(sanitizeFilename("")).toBe("file");
    expect(sanitizeFilename(undefined)).toBe("file");
    expect(sanitizeFilename("///")).toBe("file");
  });

  test("replaces shell/unicode characters", () => {
    expect(sanitizeFilename("my file (1) €.pdf")).toBe("my_file__1___.pdf");
    expect(sanitizeFilename("a;rm -rf ~.txt")).toBe("a_rm_-rf__.txt");
  });

  test("caps length at 100", () => {
    expect(sanitizeFilename("x".repeat(300) + ".pdf")).toHaveLength(100);
  });
});

describe("describeAttachments", () => {
  const id1 = "a".repeat(26);
  const id2 = "b".repeat(26);

  test("uses embedded metadata when present", () => {
    const out = describeAttachments({
      file_ids: [id1],
      metadata: { files: [{ id: id1, name: "spec.pdf", size: 1234, mime_type: "application/pdf" }] },
    });
    expect(out).toEqual([{ id: id1, name: "spec.pdf", size: 1234, mime_type: "application/pdf" }]);
  });

  test("falls back to bare ids without metadata", () => {
    const out = describeAttachments({ file_ids: [id1, id2] });
    expect(out).toEqual([
      { id: id1, name: id1 },
      { id: id2, name: id2 },
    ]);
  });

  test("sanitizes hostile names from metadata", () => {
    const out = describeAttachments({
      file_ids: [id1],
      metadata: { files: [{ id: id1, name: "../../.ssh/authorized_keys" }] },
    });
    expect(out[0]!.name).toBe("authorized_keys");
  });

  test("derives ids from metadata when file_ids is absent", () => {
    const out = describeAttachments({
      metadata: { files: [{ id: id2, name: "notes.txt" }] },
    });
    expect(out).toEqual([{ id: id2, name: "notes.txt" }]);
  });

  test("empty post yields empty list", () => {
    expect(describeAttachments({})).toEqual([]);
  });
});
