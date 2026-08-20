import { describe, expect, test } from "bun:test";

import type { ObserveData, ObserveEvent } from "../../lib/types.ts";
import type { AgentLanePreviewModel } from "./agent-lane-preview.ts";
import { echoesHeadline, missionRailNow } from "./mission-rail-model.ts";

function preview(overrides: Partial<AgentLanePreviewModel>): AgentLanePreviewModel {
  return {
    headline: "",
    headFull: "",
    headlineFrom: null,
    detail: null,
    model: null,
    branch: null,
    harness: null,
    stats: { tools: 0, edits: 0, reads: 0, thinks: 0, files: 0 },
    files: [],
    ...overrides,
  };
}

function observe(events: Array<Partial<ObserveEvent> & { kind: ObserveEvent["kind"] }>): ObserveData {
  return {
    events: events.map((event, index) => ({
      id: `e${index}`,
      t: index,
      text: "",
      ...event,
    })) as ObserveEvent[],
    files: [],
    live: false,
  };
}

describe("echoesHeadline", () => {
  test("a longer clip of the same sentence is an echo", () => {
    expect(echoesHeadline(
      "Done — and I corrected the link claim rather than leaving it…",
      "Done — and I corrected the link claim rather than leaving it standing. Study is on disk.",
    )).toBe(true);
  });

  test("the identical line is an echo", () => {
    expect(echoesHeadline("[assistant]", "[assistant]")).toBe(true);
  });

  test("a genuinely different second line is kept", () => {
    expect(echoesHeadline("bash · bun test packages/web", "exit 0 · 149 pass")).toBe(false);
  });
});

describe("missionRailNow", () => {
  test("a real headline passes through with its distinct detail", () => {
    const now = missionRailNow(
      preview({ headline: "bash · bun test", headFull: "bash · bun test packages/web", detail: "exit 0" }),
      null,
    );
    expect(now).toEqual({
      headline: "bash · bun test",
      full: "bash · bun test packages/web",
      detail: "exit 0",
    });
  });

  test("an echoed detail collapses into the longer cut, printed once", () => {
    const now = missionRailNow(
      preview({
        headline: "Reviewed the diff and pushed the…",
        headFull: "Reviewed the diff and pushed the branch",
        detail: "Reviewed the diff and pushed the branch",
      }),
      null,
    );
    expect(now?.headline).toBe("Reviewed the diff and pushed the branch");
    expect(now?.detail).toBeNull();
  });

  test("a bare turn marker falls back to the last tool call", () => {
    const now = missionRailNow(
      preview({ headline: "[assistant]", headFull: "[assistant]", detail: "[assistant]" }),
      observe([
        { kind: "tool", tool: "read", arg: "README.md" },
        { kind: "tool", tool: "bash", arg: "cd ~/dev/openscout && bun test" },
        { kind: "message", text: "[assistant]" },
      ]),
    );
    // The `cd …&&` boilerplate is dropped the same way the trace drops it.
    expect(now).toEqual({ headline: "bash · bun test", full: "bash · bun test", detail: null });
  });

  test("a turn marker with no tool to fall back on keeps the marker", () => {
    const now = missionRailNow(
      preview({ headline: "[system]", headFull: "[system]" }),
      observe([{ kind: "message", text: "[system]" }]),
    );
    expect(now).toEqual({ headline: "[system]", full: "[system]", detail: null });
  });

  test("no preview and no trace reads as nothing rather than an empty line", () => {
    expect(missionRailNow(null, null)).toBeNull();
    expect(missionRailNow(null, observe([]))).toBeNull();
  });

  test("no preview but a live trace still names the last tool", () => {
    const now = missionRailNow(null, observe([{ kind: "tool", tool: "edit", arg: "mission-wall.ts" }]));
    expect(now?.headline).toBe("edit · mission-wall.ts");
  });
});
