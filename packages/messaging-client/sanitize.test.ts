// Ported from mattermost-shared's files.test.ts when the sanitizer moved here.
import { describe, expect, test } from "bun:test";
import { sanitizeFilename } from "./sanitize.ts";

describe("sanitizeFilename", () => {
  test("keeps ordinary names intact", () => {
    expect(sanitizeFilename("report-v2.final.pdf")).toBe("report-v2.final.pdf");
  });

  test("strips directory traversal", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("..\\..\\windows\\system32")).toBe("system32");
  });

  test("never produces a dotfile or empty name", () => {
    expect(sanitizeFilename(".bashrc")).toBe("bashrc");
    expect(sanitizeFilename("...")).toBe("file");
    expect(sanitizeFilename("")).toBe("file");
    expect(sanitizeFilename(undefined)).toBe("file");
  });

  test("replaces shell/unicode characters", () => {
    expect(sanitizeFilename("a b$(rm -rf).txt")).toBe("a_b__rm_-rf_.txt");
    expect(sanitizeFilename("émoji💥.png")).toBe("_moji__.png");
  });

  test("caps length at 100", () => {
    expect(sanitizeFilename("x".repeat(300)).length).toBe(100);
  });
});
