import { describe, expect, test } from "bun:test";
import { outlineRequest, outlineSentenceCount, splitSentences, toLine } from "./work-request-outline.ts";

const TASK = "User correction: 'nice but i thought we'd move to implement :)'. NOW implement the approved Round II edge-character design into actual Scout native desktop companion, not more studio-only work. Own production changes end-to-end; parent will independently review/build/install with canonical scout:up when ready. Read AGENTS.md/DEV_INSTRUCTIONS/docs desktop-companion + operator-attention. Preserve very dirty shared checkout and existing stack fallback. 24px bottom characters, no underline, resting head peek, 5 visible states with exact detail retained, bounded attention hop, reduced motion. Don't pretend Codex window integration exists. Tests for important state/bridge/placement/click-through boundaries; native+web meaningful builds. No commits/PR/dependency updates. Provide changed files, test evidence and limitations. This is authorization to implement, install locally coordinated by parent, and demonstrate working real-data behavior. No new agents.";

describe("outlineRequest", () => {
  test("slots every sentence verbatim", () => {
    const outline = outlineRequest(TASK);
    expect(outlineSentenceCount(outline)).toBe(splitSentences(TASK).length);
    expect(outline.context).toEqual(["User correction: 'nice but i thought we'd move to implement :)'."]);
    expect(outline.ask.startsWith("NOW implement the approved Round II")).toBe(true);
    expect(outline.readFirst).toEqual(["AGENTS.md", "DEV_INSTRUCTIONS", "docs desktop-companion", "operator-attention"]);
    expect(outline.spec).toHaveLength(6);
    expect(outline.authorized).toBe("This is authorization to implement, install locally coordinated by parent, and demonstrate working real-data behavior.");
  });

  test("buckets by leading words", () => {
    const outline = outlineRequest(TASK);
    expect(outline.guard.map((l) => `${l.lead ?? ""}${l.rest}`.slice(0, 8))).toEqual(["Preserve", "Don't pr", "No commi", "No new a"]);
    expect(outline.deliver.map((l) => (l.lead ?? l.rest).split(" ")[0])).toEqual(["Tests", "Provide"]);
    expect(outline.build).toHaveLength(1);
  });

  test("negative and conditional authorization retain their full meaning", () => {
    for (const sentence of ["No authorization to deploy.", "Ask for authorization to deploy.", "Only after approval is there authorization to deploy."]) {
      const outline = outlineRequest(`Update the page. Keep the current layout. ${sentence} Return the diff.`);
      expect(outline.authorized).toBeNull();
      expect([...outline.guard, ...outline.build].map((line) => [line.lead, line.rest].filter(Boolean).join(" "))).toContain(sentence);
    }
  });

  test("short tasks stay unstructured", () => {
    const outline = outlineRequest("Fix the flaky test. It fails on CI.");
    expect(outline.structured).toBe(false);
    expect(outline.ask).toBe("Fix the flaky test.");
  });

  test("leads only short clauses", () => {
    expect(toLine("Own production changes end-to-end; parent reviews.")).toEqual({ lead: "Own production changes end-to-end;", rest: "parent reviews." });
    expect(toLine("A very long opening clause that goes on and on without a break, then more.").lead).toBeNull();
  });
});
