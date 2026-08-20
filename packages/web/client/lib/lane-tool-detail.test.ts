import { describe, expect, test } from "bun:test";

import {
  buildLaneToolDetailModel,
  laneToolCommandLine,
  laneToolHoverPreview,
} from "./lane-tool-detail.ts";
import type { ObserveEvent } from "./types.ts";

function tool(overrides: Partial<ObserveEvent> & Pick<ObserveEvent, "id">): ObserveEvent {
  return {
    t: 0,
    kind: "tool",
    text: "",
    ...overrides,
  };
}

describe("laneToolCommandLine", () => {
  test("shows bare shell commands without a tool prefix", () => {
    expect(laneToolCommandLine({ tool: "Shell", arg: "node -v", text: "Shell · node -v" }))
      .toBe("node -v");
  });

  test("prefers tool + arg for non-shell tools", () => {
    expect(laneToolCommandLine({ tool: "Read", arg: "README.md", text: "Read · README.md" }))
      .toBe("Read · README.md");
  });

  test("uses bare native command names", () => {
    expect(laneToolCommandLine({ tool: "pgrep", text: "pgrep" })).toBe("pgrep");
  });
});

describe("buildLaneToolDetailModel", () => {
  test("builds hover fields and sections for simple native commands", () => {
    const model = buildLaneToolDetailModel(
      tool({
        id: "a",
        tool: "node",
        text: "node",
        detail: "pid 12345 · exit 0",
        result: { outcome: "success" },
      }),
      { wallLabel: "46s ago", wallTitle: "2026-06-27 12:00:00", sessionOffset: "+12s" },
    );

    expect(model?.command).toBe("node");
    expect(model?.hoverFields.some((field) => field.label === "when")).toBe(true);
    expect(model?.hoverFields.some((field) => field.label === "outcome")).toBe(true);
    expect(model?.sections.some((section) => section.title === "detail")).toBe(true);
    expect(model?.copyText).toContain("pid 12345");
  });

  test("surfaces merged shell output in an output section", () => {
    const model = buildLaneToolDetailModel(tool({
      id: "sed",
      tool: "bash",
      arg: "sed -n '1,70p' crates/scoutd/src/main.rs",
      text: "sed -n '1,70p' crates/scoutd/src/main.rs",
      stream: ["use std::env; use std::fs; fn main() { println!(\"scoutd\"); (5 lines)"],
      result: { outcome: "success" },
    }));

    expect(model?.command).toBe("sed -n '1,70p' crates/scoutd/src/main.rs");
    expect(model?.sections.some((section) => (
      section.title === "output"
      && section.content.includes("use std::env;")
    ))).toBe(true);
  });

  test("returns null for non-tool events", () => {
    expect(buildLaneToolDetailModel({
      id: "a",
      t: 0,
      kind: "message",
      text: "hello",
    })).toBeNull();
  });
});

describe("laneToolHoverPreview", () => {
  test("keeps hover text compact", () => {
    const model = buildLaneToolDetailModel(tool({
      id: "a",
      tool: "ps",
      text: "ps",
      detail: "line one\nline two\nline three\nline four\nline five",
    }));
    expect(model).not.toBeNull();
    const preview = laneToolHoverPreview(model!, 3);
    expect(preview.length).toBeLessThanOrEqual(3);
    expect(preview[0]).toBe("ps");
  });
});