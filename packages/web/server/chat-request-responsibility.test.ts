import { expect, test } from "bun:test";
import type { CollaborationRecord } from "@openscout/protocol";
import { chatRequestResponsibility } from "./chat-request-responsibility.ts";

const base = { id: "question-1", kind: "question", state: "answered", acceptanceState: "pending", title: "Choose a release", conversationId: "channel", createdById: "agent", nextMoveOwnerId: "maya", answer: "Release two", createdAt: 1, updatedAt: 2 } satisfies CollaborationRecord;
const project = (record: CollaborationRecord | undefined) => chatRequestResponsibility(record, "channel", new Set(["thread"]), id => id === "maya" ? "Maya" : id);

test("answered questions retain the explicit next actor until closed", () => {
  expect(project(base)).toMatchObject({ state: "answered", settled: false, actorId: "maya", actorName: "Maya", answer: "Release two" });
  expect(project({ ...base, state: "closed" })).toMatchObject({ settled: true });
  expect(project({ ...base, state: "closed" })?.actorId).toBeUndefined();
});
test("missing ownership stays unknown and cross-channel records stay private", () => {
  expect(project({ ...base, nextMoveOwnerId: undefined })?.actorId).toBeUndefined();
  expect(project({ ...base, conversationId: "elsewhere" })).toBeUndefined();
  expect(project({ ...base, conversationId: undefined })).toBeUndefined();
  expect(project(undefined)).toBeUndefined();
  expect(project({ ...base, conversationId: "thread" })?.recordId).toBe("question-1");
});
test("work dependencies and review survive a separate completed flight", () => {
  const work = { ...base, kind: "work_item", state: "waiting", waitingOn: { kind: "approval", label: "Release approval" } } satisfies CollaborationRecord;
  expect(project(work)).toMatchObject({ settled: false, waitingOn: "Release approval", actorId: "maya" });
  expect(project({ ...work, state: "review" })?.settled).toBe(false);
  expect(project({ ...work, state: "done" })?.waitingOn).toBeUndefined();
});


test("only the recorded respondent and requester receive question actions", () => {
  const projectFor = (record: CollaborationRecord, viewer: string) => chatRequestResponsibility(record, "channel", new Set(), id => id, viewer);
  expect(projectFor({ ...base, createdById: "agent", askedById: "maya" }, "maya")?.actions).toEqual(["close", "reopen"]);
  expect(projectFor(base, "stranger")?.actions).toEqual([]);
  expect(projectFor({ ...base, state: "open" }, "maya")?.actions).toEqual(["answer"]);
  expect(projectFor({ ...base, state: "closed" }, "maya")?.actions).toEqual([]);
});
