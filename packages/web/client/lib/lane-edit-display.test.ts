import { describe, expect, test } from "bun:test";

import {
  isStrReplaceTool,
  laneDisplayPath,
  strReplaceDetailText,
  strReplaceDiffFromEdit,
  strReplaceEditFromObserveEvent,
  strReplaceFromGrokSummary,
  strReplaceFromObject,
  strReplaceSnippet,
} from "./lane-edit-display.ts";
import type { ObserveEvent } from "./types.ts";

describe("isStrReplaceTool", () => {
  test("recognises Grok and codex replace tool names", () => {
    expect(isStrReplaceTool("StrReplace")).toBe(true);
    expect(isStrReplaceTool("str_replace")).toBe(true);
    expect(isStrReplaceTool("Edit")).toBe(false);
  });
});

describe("strReplaceFromGrokSummary", () => {
  test("parses edit previews embedded in grok tail summaries", () => {
    expect(strReplaceFromGrokSummary(
      "StrReplace · packages/web/client/lib/tail-display.test.ts · edit: -const max = 96; · +const max = 120; · success",
    )).toEqual({
      path: "packages/web/client/lib/tail-display.test.ts",
      oldText: "const max = 96;",
      newText: "const max = 120;",
      outcome: "success",
    });
  });
});

describe("laneDisplayPath", () => {
  test("shortens absolute home paths for lane display", () => {
    expect(laneDisplayPath("/Users/art/dev/openscout/packages/web/client/lib/foo.ts"))
      .toBe("~/dev/openscout/packages/web/client/lib/foo.ts");
  });
});

describe("strReplaceFromObject", () => {
  test("extracts path and old/new strings from structured payloads", () => {
    expect(strReplaceFromObject({
      path: "packages/web/client/lib/tail-display.ts",
      old_string: "const max = 96;",
      new_string: "const max = 120;",
    })).toEqual({
      path: "packages/web/client/lib/tail-display.ts",
      oldText: "const max = 96;",
      newText: "const max = 120;",
    });
  });
});

describe("strReplaceDiffFromEdit", () => {
  test("builds a compact +/- preview for lane and detail views", () => {
    const diff = strReplaceDiffFromEdit({
      path: "foo.ts",
      oldText: "alpha\nbeta",
      newText: "alpha\ngamma",
    });

    expect(diff?.add).toBe(2);
    expect(diff?.del).toBe(2);
    expect(diff?.preview).toContain("-beta");
    expect(diff?.preview).toContain("+gamma");
  });
});

describe("strReplaceDetailText", () => {
  test("formats detail sheet copy with file and both sides", () => {
    const detail = strReplaceDetailText({
      path: "foo.ts",
      oldText: "old line",
      newText: "new line",
    });

    expect(detail).toContain("file: foo.ts");
    expect(detail).toContain("old:\nold line");
    expect(detail).toContain("new:\nnew line");
  });
});

describe("strReplaceSnippet", () => {
  test("clips long single-line replacements", () => {
    const long = "x".repeat(120);
    expect(strReplaceSnippet(long, 40).endsWith("…")).toBe(true);
  });
});

describe("strReplaceEditFromObserveEvent", () => {
  test("reconstructs edit metadata from observe detail text", () => {
    const event: ObserveEvent = {
      id: "e1",
      t: 1,
      kind: "tool",
      text: "StrReplace · foo.ts",
      tool: "StrReplace",
      arg: "packages/foo.ts",
      detail: "file: packages/foo.ts\n\nold:\nconst a = 1;\n\nnew:\nconst a = 2;",
    };

    expect(strReplaceEditFromObserveEvent(event)).toEqual({
      path: "packages/foo.ts",
      oldText: "const a = 1;",
      newText: "const a = 2;",
    });
  });
});