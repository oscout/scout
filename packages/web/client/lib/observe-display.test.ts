import { describe, expect, test } from "bun:test";

import type { ObserveEvent } from "./types.ts";
import {
  collapseObserveDisplayRows,
  collapseTechnicalObserveDisplayRows,
  isSimpleLaneToolEvent,
  observeEventSignature,
} from "./observe-display.ts";

function observe(overrides: Partial<ObserveEvent> & Pick<ObserveEvent, "id">): ObserveEvent {
  return {
    t: 0,
    kind: "system",
    text: "",
    ...overrides,
  };
}

describe("isSimpleLaneToolEvent", () => {
  test("treats native single-token commands as simple", () => {
    expect(isSimpleLaneToolEvent(observe({
      id: "a",
      kind: "tool",
      tool: "node",
      text: "node",
    }))).toBe(true);
    expect(isSimpleLaneToolEvent(observe({
      id: "b",
      kind: "tool",
      tool: "pgrep",
      text: "pgrep",
    }))).toBe(true);
    expect(isSimpleLaneToolEvent(observe({
      id: "c",
      kind: "tool",
      tool: "/usr/bin/log",
      text: "/usr/bin/log",
    }))).toBe(true);
  });

  test("treats single-token shell commands as simple", () => {
    expect(isSimpleLaneToolEvent(observe({
      id: "a",
      kind: "tool",
      tool: "Shell",
      arg: "ps",
      text: "Shell · ps",
    }))).toBe(true);
  });

  test("rejects multi-arg commands and rich tool rows", () => {
    expect(isSimpleLaneToolEvent(observe({
      id: "a",
      kind: "tool",
      tool: "Shell",
      arg: "rg LaneFacts packages/web",
      text: "Shell · rg LaneFacts packages/web",
    }))).toBe(false);
    expect(isSimpleLaneToolEvent(observe({
      id: "b",
      kind: "tool",
      tool: "Read",
      arg: "README.md",
      text: "Read · README.md",
    }))).toBe(false);
    expect(isSimpleLaneToolEvent(observe({
      id: "c",
      kind: "tool",
      tool: "Shell",
      arg: "node",
      text: "Shell · node",
      diff: { add: 1, del: 0, preview: "+line" },
    }))).toBe(false);
  });
});

describe("collapseObserveDisplayRows", () => {
  test("merges consecutive think runs into the latest reasoning snippet", () => {
    const rows = collapseObserveDisplayRows([
      observe({ id: "a", t: 1, kind: "think", text: "First pass on the lane trace." }),
      observe({ id: "b", t: 2, kind: "think", text: "Need to collapse reasoning before expanding tools." }),
      observe({ id: "c", t: 3, kind: "tool", tool: "Read", arg: "README.md", text: "Read · README.md" }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.repeatCount).toBe(2);
    expect(rows[0]?.event.text).toContain("Need to collapse reasoning");
    expect(rows[0]?.event.text).toContain("(2 reasoning updates)");
  });

  test("never merges consecutive identical messages — authored turns stand alone", () => {
    const rows = collapseObserveDisplayRows([
      observe({ id: "a", t: 1, kind: "message", text: "Committed and pushed." }),
      observe({ id: "b", t: 2, kind: "message", text: "Committed and pushed." }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.repeatCount).toBe(1);
    expect(rows[1]?.repeatCount).toBe(1);
  });

  test("never merges consecutive identical asks", () => {
    const rows = collapseObserveDisplayRows([
      observe({ id: "a", t: 1, kind: "ask", text: "Proceed?" }),
      observe({ id: "b", t: 2, kind: "ask", text: "Proceed?" }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.repeatCount).toBe(1);
  });

  test("collapses repeated identical shell commands", () => {
    const rows = collapseObserveDisplayRows([
      observe({ id: "a", t: 1, kind: "tool", tool: "Shell", arg: "rg LaneFacts packages/web", text: "Shell · rg LaneFacts packages/web" }),
      observe({ id: "b", t: 2, kind: "tool", tool: "Shell", arg: "rg LaneFacts packages/web", text: "Shell · rg LaneFacts packages/web" }),
      observe({ id: "c", t: 3, kind: "message", text: "done" }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.repeatCount).toBe(2);
    expect(rows[0]?.event.id).toBe("b");
  });

  test("merges grok tool started/completed pairs", () => {
    const rows = collapseObserveDisplayRows([
      observe({ id: "a", t: 1, kind: "tool", tool: "Read", arg: "started", text: "Read started" }),
      observe({
        id: "b",
        t: 2,
        kind: "tool",
        tool: "Read",
        arg: "completed",
        text: "Read completed · success",
        result: { outcome: "success" },
      }),
      observe({ id: "c", t: 3, kind: "tool", tool: "Shell", arg: "started", text: "Shell started" }),
      observe({
        id: "d",
        t: 4,
        kind: "tool",
        tool: "Shell",
        arg: "completed",
        text: "Shell completed · success",
        result: { outcome: "success" },
      }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.event.tool).toBe("Read");
    expect(rows[0]?.event.arg).toBe("completed");
    expect(rows[1]?.event.tool).toBe("Shell");
  });

  test("merges shell invocations with following result previews", () => {
    const rows = collapseObserveDisplayRows([
      observe({
        id: "a",
        t: 1,
        kind: "tool",
        tool: "bash",
        arg: "sed -n '1,70p' crates/scoutd/src/main.rs",
        text: "bash · sed -n '1,70p' crates/scoutd/src/main.rs",
      }),
      observe({
        id: "b",
        t: 2,
        kind: "tool",
        tool: "bash",
        arg: "sed -n '1,70p' crates/scoutd/src/main.rs",
        text: "bash · sed -n '1,70p' crates/scoutd/src/main.rs -> res: use std::env; (5 lines)",
        stream: ["use std::env; (5 lines)"],
        result: { outcome: "success" },
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.event.arg).toBe("sed -n '1,70p' crates/scoutd/src/main.rs");
    expect(rows[0]?.event.stream).toEqual(["use std::env; (5 lines)"]);
  });

  test("merges grok StrReplace lifecycle pairs and keeps the diff preview", () => {
    const rows = collapseObserveDisplayRows([
      observe({
        id: "a",
        t: 1,
        kind: "tool",
        tool: "StrReplace",
        arg: "packages/web/client/lib/tail-display.ts",
        text: "StrReplace · packages/web/client/lib/tail-display.ts",
        detail: "file: packages/web/client/lib/tail-display.ts\n\nold:\nconst max = 96;\n\nnew:\nconst max = 120;",
        diff: { add: 1, del: 1, preview: "-const max = 96;\n+const max = 120;" },
      }),
      observe({
        id: "b",
        t: 2,
        kind: "tool",
        tool: "StrReplace",
        arg: "completed",
        text: "StrReplace completed · success",
        result: { outcome: "success" },
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.event.arg).toBe("packages/web/client/lib/tail-display.ts");
    expect(rows[0]?.event.diff?.preview).toContain("+const max = 120;");
  });

  test("merges claude bash calls with separate res rows", () => {
    const rows = collapseObserveDisplayRows([
      observe({
        id: "a",
        t: 1,
        kind: "tool",
        tool: "bash",
        arg: "git status --short",
        text: "git status --short",
      }),
      observe({
        id: "b",
        t: 2,
        kind: "tool",
        tool: "res",
        arg: " M packages/web/client/lib/tail-display.ts",
        stream: [" M packages/web/client/lib/tail-display.ts"],
        result: { outcome: "success" },
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.event.tool).toBe("bash");
    expect(rows[0]?.event.stream).toEqual([" M packages/web/client/lib/tail-display.ts"]);
  });

  test("preserves shell commands when merging grok lifecycle pairs", () => {
    const rows = collapseObserveDisplayRows([
      observe({
        id: "a",
        t: 1,
        kind: "tool",
        tool: "Shell",
        arg: "curl -s http://127.0.0.1:43122/api/session-ref/test",
        text: "Shell · curl -s http://127.0.0.1:43122/api/session-ref/test",
      }),
      observe({
        id: "b",
        t: 2,
        kind: "tool",
        tool: "Shell",
        arg: "curl -s http://127.0.0.1:43122/api/session-ref/test",
        text: "Shell · curl -s http://127.0.0.1:43122/api/session-ref/test · success",
        result: { outcome: "success" },
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.event.arg).toBe("curl -s http://127.0.0.1:43122/api/session-ref/test");
    expect(rows[0]?.event.result).toEqual({ outcome: "success" });
  });

  test("collapses consecutive identical notes and permissions", () => {
    const rows = collapseObserveDisplayRows([
      observe({ id: "a", t: 1, kind: "note", text: "[turn_ended]" }),
      observe({ id: "b", t: 2, kind: "note", text: "[turn_ended]" }),
      observe({ id: "c", t: 3, kind: "system", text: "permission allow · Read" }),
      observe({ id: "d", t: 4, kind: "system", text: "permission allow · Read" }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.repeatCount).toBe(2);
    expect(rows[1]?.repeatCount).toBe(2);
  });

  test("does not merge different tools or non-adjacent lifecycle pairs", () => {
    const rows = collapseObserveDisplayRows([
      observe({ id: "a", t: 1, kind: "tool", tool: "Read", arg: "started", text: "Read started" }),
      observe({ id: "b", t: 2, kind: "tool", tool: "Shell", arg: "completed", text: "Shell completed · success" }),
      observe({ id: "c", t: 3, kind: "system", text: "turn 24 · grok" }),
      observe({ id: "d", t: 4, kind: "system", text: "turn 25 · grok" }),
    ]);

    expect(rows).toHaveLength(4);
    expect(observeEventSignature(rows[2]!.event)).not.toBe(observeEventSignature(rows[3]!.event));
  });

  test("merges permission requested/resolved pairs for the same tool", () => {
    const rows = collapseObserveDisplayRows([
      observe({ id: "a", t: 1, kind: "system", text: "permission requested · Read" }),
      observe({ id: "b", t: 2, kind: "system", text: "permission allow · Read" }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.event.text).toBe("permission allow · Read");
  });

  test("collapses repeated merged tool pairs", () => {
    const rows = collapseObserveDisplayRows([
      observe({ id: "a1", t: 1, kind: "tool", tool: "Read", arg: "started", text: "Read started" }),
      observe({
        id: "a2",
        t: 2,
        kind: "tool",
        tool: "Read",
        arg: "completed",
        text: "Read completed · success",
        result: { outcome: "success" },
      }),
      observe({ id: "b1", t: 3, kind: "tool", tool: "Read", arg: "started", text: "Read started" }),
      observe({
        id: "b2",
        t: 4,
        kind: "tool",
        tool: "Read",
        arg: "completed",
        text: "Read completed · success",
        result: { outcome: "success" },
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.repeatCount).toBe(2);
    expect(rows[0]?.event.id).toBe("b2");
  });
});

describe("collapseTechnicalObserveDisplayRows", () => {
  test("rolls up technical rows between authored turns", () => {
    const rows = collapseTechnicalObserveDisplayRows(collapseObserveDisplayRows([
      observe({ id: "ask", t: 1, kind: "ask", text: "Please improve lanes." }),
      observe({ id: "turn", t: 2, kind: "note", text: "Turn started" }),
      observe({ id: "read", t: 3, kind: "tool", tool: "Read", arg: "AgentLanesView.tsx", text: "Read · AgentLanesView.tsx" }),
      observe({ id: "think-a", t: 4, kind: "think", text: "Find the display layer." }),
      observe({ id: "think-b", t: 5, kind: "think", text: "Patch the render path." }),
      observe({ id: "msg", t: 6, kind: "message", text: "I found the lane UI." }),
    ]));

    expect(rows).toHaveLength(4);
    expect(rows[0]?.event.kind).toBe("ask");
    expect(rows[1]?.event.text).toBe("Turn started");
    expect(rows[2]?.technicalSummary?.totalCount).toBe(3);
    expect(rows[2]?.technicalSummary?.toolCount).toBe(1);
    expect(rows[2]?.technicalSummary?.thinkCount).toBe(2);
    expect(rows[2]?.technicalSourceRows).toHaveLength(2);
    expect(rows[2]?.event.text).toBe("1 tool · 2 reasoning updates");
    expect(rows[3]?.event.kind).toBe("message");
  });

  test("rolls up single routine technical rows", () => {
    const rows = collapseTechnicalObserveDisplayRows(collapseObserveDisplayRows([
      observe({ id: "ask", t: 1, kind: "ask", text: "Status?" }),
      observe({ id: "read", t: 2, kind: "tool", tool: "Read", arg: "README.md", text: "Read · README.md" }),
      observe({ id: "msg", t: 3, kind: "message", text: "Done." }),
    ]));

    expect(rows).toHaveLength(3);
    expect(rows[1]?.technicalSummary?.totalCount).toBe(1);
    expect(rows[1]?.event.text).toBe("1 tool");
  });

  test("does not hide permission or failure events", () => {
    const rows = collapseTechnicalObserveDisplayRows(collapseObserveDisplayRows([
      observe({ id: "ask", t: 1, kind: "ask", text: "Run the check." }),
      observe({ id: "permission", t: 2, kind: "system", text: "permission requested · Shell" }),
      observe({
        id: "failed",
        t: 3,
        kind: "tool",
        tool: "Shell",
        arg: "npm test",
        text: "Shell · npm test",
        result: { outcome: "failed" },
      }),
      observe({ id: "note", t: 4, kind: "note", text: "Turn complete" }),
      observe({ id: "system", t: 5, kind: "system", text: "tokens · 1200" }),
      observe({ id: "read", t: 6, kind: "tool", tool: "Read", arg: "package.json", text: "Read · package.json" }),
    ]));

    expect(rows).toHaveLength(5);
    expect(rows[1]?.event.id).toBe("permission");
    expect(rows[2]?.event.id).toBe("failed");
    expect(rows[3]?.event.id).toBe("note");
    expect(rows[4]?.technicalSummary?.totalCount).toBe(2);
  });

  test("keeps file-changing tool rows visible", () => {
    const rows = collapseTechnicalObserveDisplayRows(collapseObserveDisplayRows([
      observe({ id: "ask", t: 1, kind: "ask", text: "Patch the lane." }),
      observe({
        id: "edit",
        t: 2,
        kind: "tool",
        tool: "Edit",
        arg: "SessionObserve.tsx",
        text: "Edit · SessionObserve.tsx",
        diff: { add: 2, del: 1, preview: "+next" },
      }),
      observe({ id: "read", t: 3, kind: "tool", tool: "Read", arg: "SessionObserve.tsx", text: "Read · SessionObserve.tsx" }),
      observe({ id: "system", t: 4, kind: "system", text: "tokens · 1200" }),
    ]));

    expect(rows).toHaveLength(3);
    expect(rows[1]?.event.id).toBe("edit");
    expect(rows[2]?.technicalSummary?.totalCount).toBe(2);
  });
});
