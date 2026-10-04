import { expect, test } from "bun:test";
import type { WorkDetail } from "../../lib/types.ts";
import { initialWorkBriefSummary, workTailRoute, workMaterialImageUrl } from "./work-detail-context.ts";

const detail = {
  id: "work-review", conversationId: "chn-review", ownerId: "session-scout",
  ownerName: "reviewer", nextMoveOwnerName: "operator",
  primaryInvocation: {
    flightId: "flt-review", invocationId: "inv-review", resolvedSessionId: "session-scout",
    targetAgentId: "session-scout", task: "Full request with acceptance criteria",
  },
  timeline: [
    { kind: "collaboration_event", detailKind: "created", at: 1, summary: "Short summary" },
    { kind: "message", at: 2, summary: "Opening message" },
  ],
} as unknown as WorkDetail;

test("work tail preserves resolution handles instead of searching display names", () => {
  const route = workTailRoute(detail);
  expect(route).toMatchObject({
    view: "ops", mode: "tail", workId: "work-review", flightId: "flt-review",
    invocationId: "inv-review", sessionId: "session-scout", targetAgentId: "session-scout",
  });
  if (route.view !== "ops" || route.mode !== "tail") throw new Error("Expected tail");
  expect(route.tailQuery).not.toContain("operator");
  expect(route.tailQuery).not.toContain("reviewer");
});

test("work without an invocation still retains a resolvable work handle", () => {
  expect(workTailRoute({ ...detail, primaryInvocation: null })).toMatchObject({ workId: "work-review" });
});

test("original request uses full invocation prompt before short creation summary", () => {
  expect(initialWorkBriefSummary(detail)).toBe("Full request with acceptance criteria");
  expect(initialWorkBriefSummary({ ...detail, primaryInvocation: null })).toBe("Opening message");
  expect(initialWorkBriefSummary({ ...detail, primaryInvocation: null, timeline: [] })).toBeNull();
});

test("image materials keep a raw preview while source files use the text reader", () => {
  expect(workMaterialImageUrl("work/1", { id: "asset 1", path: "/design/preview.PNG" })).toBe("/api/work/work%2F1/material/raw?materialId=asset%201");
  expect(workMaterialImageUrl("work-1", { id: "source", path: "/src/index.tsx" })).toBeNull();
  expect(workMaterialImageUrl("work-1", null)).toBeNull();
});
