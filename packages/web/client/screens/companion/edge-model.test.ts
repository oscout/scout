import { describe, expect, test } from "bun:test";

import {
  EDGE_MARGIN,
  EDGE_REACH,
  EDGE_SLOT,
  detectArrivals,
  edgeVisible,
  exactDiffers,
  exactLabel,
  freeSpans,
  isVisitor,
  nearestFree,
  nextExpiry,
  pruneExpired,
  originGroups,
  popoverLeft,
  solveEdge,
  spreadPins,
  stepTarget,
  type EdgeFigureInput,
} from "./edge-model.ts";

const fig = (id: string, visible: EdgeFigureInput["visible"] = "working", extra: Partial<EdgeFigureInput> = {}): EdgeFigureInput => ({
  id,
  visible,
  arriving: false,
  lastActivityAt: 0,
  ...extra,
});

function noOverlap(pos: ReadonlyMap<string, number>) {
  const xs = [...pos.values()].sort((a, b) => a - b);
  for (let i = 1; i < xs.length; i += 1) expect(xs[i]! - xs[i - 1]!).toBeGreaterThanOrEqual(EDGE_SLOT);
}

describe("readings", () => {
  test("five visible readings; the exact state survives for the detail", () => {
    expect(edgeVisible("working", false)).toBe("working");
    expect(edgeVisible("question", false)).toBe("needs");
    expect(edgeVisible("blocked", false)).toBe("needs");
    expect(edgeVisible("done", false)).toBe("done");
    for (const state of ["quiet", "waiting", "ended", "cancelled", undefined] as const) expect(edgeVisible(state, false)).toBe("resting");
    expect(edgeVisible("question", true)).toBe("disconnected");
    expect(exactLabel("quiet")).toBe("Quiet");
    expect(exactLabel("question")).toBe("Asks you");
    expect(exactDiffers("working")).toBe(false);
    expect(exactDiffers("done")).toBe(false);
    expect(exactDiffers("waiting")).toBe(true);
    expect(exactDiffers(undefined)).toBe(true);
  });
});

describe("free spans", () => {
  test("margins, obstacles and the reserved home slot are cut out", () => {
    expect(freeSpans(1000, [])).toEqual([[EDGE_MARGIN, 1000 - EDGE_MARGIN]]);
    expect(freeSpans(1000, [{ start: 200, end: 400 }], { start: 956, end: 986 })).toEqual([[14, 200], [400, 956]]);
    expect(freeSpans(20, [])).toEqual([]);
  });

  test("nearestFree keeps a slot clear of neighbours and spans", () => {
    const free = freeSpans(1000, [{ start: 200, end: 400 }]);
    expect(nearestFree(310, free, [])).toBe(415);
    expect(nearestFree(300, free, [])).toBe(185); // a tie goes to the earlier span
    expect(nearestFree(500, free, [500])).toBe(470);
    expect(nearestFree(50, [[0, 20]], [])).toBeNull();
  });
});

describe("placement", () => {
  const base = { free: freeSpans(1000, []), anchor: "right" as const, width: 1000 };

  test("new figures gather at the anchor end without overlapping", () => {
    const { pos, overflow, stackAt } = solveEdge([fig("a"), fig("b"), fig("c")], { ...base, prev: new Map() });
    expect(overflow).toEqual([]);
    expect(stackAt).toBeNull();
    expect(Math.max(...pos.values())).toBe(1000 - EDGE_MARGIN - EDGE_SLOT / 2);
    noOverlap(pos);
  });

  test("settled figures hold still when others arrive", () => {
    const first = solveEdge([fig("a"), fig("b")], { ...base, prev: new Map() });
    const second = solveEdge([fig("a"), fig("b"), fig("new", "working", { arriving: true })], { ...base, prev: first.pos });
    expect(second.pos.get("a")).toBe(first.pos.get("a"));
    expect(second.pos.get("b")).toBe(first.pos.get("b"));
    noOverlap(second.pos);
  });

  test("changing the gathering end relocates settled figures and cancels old step targets", () => {
    const figures = [fig("a"), fig("b")];
    const right = solveEdge(figures, { ...base, prev: new Map() });
    const left = solveEdge([fig("a", "working", { stepTarget: 920 }), fig("b")], {
      ...base, prev: right.pos, previousAnchor: "right", anchor: "left",
    });
    expect(Math.max(...left.pos.values())).toBeLessThan(100);
    noOverlap(left.pos);
    const back = solveEdge(figures, { ...base, prev: left.pos, previousAnchor: "left" });
    expect(Math.min(...back.pos.values())).toBeGreaterThan(900);
    noOverlap(back.pos);
  });

  test("obstacles are avoided", () => {
    const free = freeSpans(1000, [{ start: 900, end: 1000 }]);
    const { pos } = solveEdge([fig("a"), fig("b")], { ...base, free, prev: new Map() });
    for (const x of pos.values()) expect(x + EDGE_SLOT / 2).toBeLessThanOrEqual(900);
  });

  test("a full edge folds into +N; needs-you and arrivals keep their spots", () => {
    const narrow = { ...base, free: freeSpans(14 * 2 + EDGE_SLOT * 4, []), width: 14 * 2 + EDGE_SLOT * 4 };
    const prev = new Map([["r1", 29], ["r2", 59], ["r3", 89], ["w1", 119]]);
    const figures = [
      fig("r1", "resting"), fig("r2", "resting"), fig("r3", "resting"), fig("w1", "working"),
      fig("ask", "needs"), fig("fresh", "resting", { arriving: true }),
    ];
    const { pos, overflow, stackAt } = solveEdge(figures, { ...narrow, prev });
    expect(stackAt).not.toBeNull();
    expect(pos.has("ask")).toBe(true);
    expect(pos.has("fresh")).toBe(true);
    expect(overflow.length + pos.size).toBe(figures.length);
    for (const x of pos.values()) expect(Math.abs(x - stackAt!)).toBeGreaterThanOrEqual(EDGE_SLOT / 2 + 22 - 0.001);
    noOverlap(pos);
  });

  test("needs-you displaces a resting figure rather than going to +N", () => {
    // Three settled figures leave gaps too narrow for a fourth.
    const width = 14 * 2 + 150;
    const prev = new Map([["r1", 44], ["d1", 89], ["w1", 134]]);
    const { pos, overflow } = solveEdge(
      [fig("r1", "resting"), fig("d1", "done"), fig("w1", "working"), fig("ask", "needs")],
      { free: freeSpans(width, []), anchor: "right", width, prev },
    );
    expect(pos.has("ask")).toBe(true);
    expect(overflow).toEqual(["r1"]);
    noOverlap(pos);
  });

  test("a walker heads to its step target", () => {
    const first = solveEdge([fig("a")], { ...base, prev: new Map() });
    const home = first.pos.get("a")!;
    const target = stepTarget("a", 1, home, home);
    const walked = solveEdge([fig("a", "working", { stepTarget: target })], { ...base, prev: first.pos });
    expect(walked.pos.get("a")).toBe(Math.min(target, 1000 - EDGE_MARGIN - EDGE_SLOT / 2));
  });
});

describe("steps", () => {
  test("deterministic, bounded by reach, never a no-op", () => {
    let x = 500;
    for (let n = 1; n < 60; n += 1) {
      const next = stepTarget("work-1", n, x, 500);
      expect(Math.abs(next - 500)).toBeLessThanOrEqual(EDGE_REACH);
      expect(next).not.toBe(x);
      expect(stepTarget("work-1", n, x, 500)).toBe(next);
      x = next;
    }
  });
});

describe("arrivals and visitors", () => {
  test("the first observation records; only later ids arrive", () => {
    const first = detectArrivals(null, ["a", "b"]);
    expect(first.arrived).toEqual([]);
    const second = detectArrivals(first.known, ["a", "b", "c"]);
    expect(second.arrived).toEqual(["c"]);
    // Leaving and coming back is not a new arrival within the session.
    expect(detectArrivals(detectArrivals(second.known, ["a"]).known, ["a", "c"]).arrived).toEqual([]);
  });

  test("a visitor needs real remote provenance", () => {
    expect(isVisitor({ localNodeId: "node-a", pinMachineId: "node-b" })).toBe(true);
    expect(isVisitor({ localNodeId: "node-a", pinMachineId: "node-a", agentNodeIds: ["node-b"] })).toBe(false);
    expect(isVisitor({ localNodeId: "node-a", agentNodeIds: ["node-b", null] })).toBe(true);
    expect(isVisitor({ localNodeId: "node-a", agentNodeIds: ["node-b", "node-a"] })).toBe(false);
    // Unknown is never remote.
    expect(isVisitor({ localNodeId: "node-a", agentNodeIds: [] })).toBe(false);
    expect(isVisitor({ localNodeId: null, pinMachineId: "node-b" })).toBe(false);
  });
});

describe("origin pins", () => {
  test("group by conversation; singles only when focused", () => {
    const pos = new Map([["a", 100], ["b", 160], ["c", 400], ["d", 700]]);
    const figures = [
      { id: "a", conversationId: "chn-1" },
      { id: "b", conversationId: "chn-1" },
      { id: "c", conversationId: "chn-2" },
      { id: "d", conversationId: null },
      { id: "e", conversationId: "chn-1" }, // in +N: no spot, not counted
    ];
    expect(originGroups(figures, pos)).toEqual([{ conversationId: "chn-1", ids: ["a", "b"], center: 130 }]);
    expect(originGroups(figures, pos, "c").map((group) => group.conversationId)).toEqual(["chn-1", "chn-2"]);
  });

  test("pin tabs never overlap and stay on screen", () => {
    const xs = spreadPins([100, 110, 120, 995], 1000);
    for (let i = 1; i < xs.length; i += 1) expect(xs[i]! - xs[i - 1]!).toBeGreaterThanOrEqual(48);
    expect(xs.at(-1)!).toBeLessThanOrEqual(1000 - EDGE_MARGIN - 22);
    expect(xs[0]!).toBeGreaterThanOrEqual(EDGE_MARGIN + 22);
  });

  test("popovers stay on screen", () => {
    expect(popoverLeft(5, 320, 1000)).toBe(12);
    expect(popoverLeft(995, 320, 1000)).toBe(668);
    expect(popoverLeft(500, 320, 1000)).toBe(340);
  });
});

describe("motion expiry", () => {
  test("each motion ends on its own clock, whatever refreshes arrive", () => {
    const inFlight = new Map([["hop", { until: 900 }], ["chute", { until: 2600 }]]);
    expect(nextExpiry(inFlight)).toBe(900);
    expect(nextExpiry(new Map())).toBeNull();
    // Nothing ended: the same map, so no re-render and no re-armed timer.
    expect(pruneExpired(inFlight, 500)).toBe(inFlight);
    const afterHop = pruneExpired(inFlight, 900);
    expect([...afterHop.keys()]).toEqual(["chute"]);
    expect(nextExpiry(afterHop)).toBe(2600);
    expect(pruneExpired(afterHop, 2600).size).toBe(0);
  });
});
