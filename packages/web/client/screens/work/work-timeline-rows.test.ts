import type { WorkDetail } from "../../lib/types.ts";
import { describe, expect, test } from "bun:test";
import { splitAskRef, workTimelineRows } from "./work-timeline-rows.ts";

function ev(id: string, kind: string, at: number, summary: string | null, detailKind: string | null = null) {
  return { id, kind, at, summary, detailKind, actorId: null, actorName: null, title: null, flightId: null, messageId: null, conversationId: null } as WorkDetail["timeline"][number];
}

describe("workTimelineRows", () => {
  test("folds same-moment text echoes but keeps distinct flight markers", () => {
    const rows = workTimelineRows([
      ev("a", "message", 5000, "[ask:f-1] Done with it."),
      ev("b", "collaboration_event", 5000, "[ask:f-1] Done with it.", "review_requested"),
      ev("c", "flight_completed", 5000, "agent replied."),
      ev("d", "message", 3000, "Different text."),
      ev("e", "collaboration_event", 1000, "Bring the thing.", "created"),
      ev("f", "message", 1000, "User correction: more."),
      ev("g", "flight_started", 1100, "agent replied."),
    ]);
    expect(rows.map((r) => r.item.id)).toEqual(["b", "c", "d", "g", "e", "f"]);
    expect(rows[0]!.folded.map((f) => f.item.id)).toEqual(["a"]);
    expect(rows[0]!.ref).toBe("f-1");
    expect(rows[0]!.body).toBe("Done with it.");
    expect(rows[3]!.body).toBe("agent replied.");
  });

  test("leaves text without a handle alone", () => {
    expect(splitAskRef("plain")).toEqual({ body: "plain", ref: null });
  });
});

describe("clipped echoes", () => {
  test("an event's clipped copy folds with the full message and keeps the full text", () => {
    const full = "[ask:f-9] " + "The edge companion is implemented and verified end to end. ".repeat(4);
    const rows = workTimelineRows([
      ev("m", "message", 9000, full),
      ev("e", "collaboration_event", 9000, full.slice(0, 120) + "...", "review_requested"),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.item.id).toBe("e");
    expect(rows[0]!.body).toBe(full.replace("[ask:f-9] ", ""));
  });
});

test("simultaneous flights keep their failure explanations and separate identities", () => {
  const rows = workTimelineRows([
    { ...ev("a", "collaboration_event", 5000, "Build the page"), flightId: "flight-a" },
    { ...ev("b", "flight_completed", 5100, "Permission denied while writing output", "failed"), flightId: "flight-b" },
    { ...ev("c", "message", 5200, "Build the page"), flightId: "flight-c" },
  ]);
  expect(rows).toHaveLength(3);
  expect(rows.map((row) => row.body)).toContain("Permission denied while writing output");
  expect(rows.every((row) => row.folded.length === 0)).toBe(true);
});
