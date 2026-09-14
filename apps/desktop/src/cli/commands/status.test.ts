import { expect, test } from "bun:test";
import { createRuntimeRegistrySnapshot } from "@openscout/runtime/registry";
import { buildWorkStatuses, parseStatusCommandOptions, selectWorkStatuses } from "./status.ts";
import { shouldEnsureBrokerUptodateForCommand } from "../uptodate.ts";

test("status cannot restart the broker and rejects ambiguous filter syntax", () => {
  expect(shouldEnsureBrokerUptodateForCommand("status")).toBe(false);
  expect(() => parseStatusCommandOptions(["--blocked"])).toThrow("require --all");
  expect(() => parseStatusCommandOptions(["--all", "--blocked", "--failed"])).toThrow("choose only one");
  expect(() => parseStatusCommandOptions(["--all", "flt-1"])).toThrow("not both");
  expect(() => parseStatusCommandOptions(["--all", "--next-actor"])).toThrow("requires");
});

test("blocked is explicit, old questions survive, failed and quiet work are distinct", () => {
  const snapshot = createRuntimeRegistrySnapshot({
    flights: {
      waiting: { id: "waiting", invocationId: "inv-1", requesterId: "parent", targetAgentId: "child", state: "waiting", summary: "Dependency unavailable" },
      running: { id: "running", invocationId: "inv-2", requesterId: "parent", targetAgentId: "child", state: "running", summary: "Previously blocked; now working" },
      failed: { id: "failed", invocationId: "inv-3", requesterId: "parent", targetAgentId: "child", state: "failed", error: "Failed check" },
    },
    collaborationRecords: {
      question: { id: "question", kind: "question", title: "Which target?", state: "open", acceptanceState: "none", createdById: "child", nextMoveOwnerId: "operator", createdAt: 1, updatedAt: 1 },
      answered: { id: "answered", kind: "question", title: "Which branch?", state: "answered", acceptanceState: "none", createdById: "child", createdAt: 1, updatedAt: 2 },
    },
  });
  const rows = buildWorkStatuses(snapshot);
  expect(selectWorkStatuses(rows, parseStatusCommandOptions(["--all", "--blocked"])).map(row => row.id).sort()).toEqual(["question", "waiting"]);
  expect(selectWorkStatuses(rows, parseStatusCommandOptions(["--all", "--failed"])).map(row => row.id)).toEqual(["failed"]);
  expect(selectWorkStatuses(rows, parseStatusCommandOptions(["--all", "--blocked", "--next-actor", "operator"])).map(row => row.id)).toEqual(["question"]);
  expect(rows.find(row => row.id === "waiting")?.nextActor).toBeNull();
});

test("exact and reference handles resolve and ambiguous bindings fail closed", () => {
  const snapshot = createRuntimeRegistrySnapshot({
    invocations: { inv: { id: "inv", requesterId: "parent", requesterNodeId: "node", targetAgentId: "child", action: "execute", task: "Build", messageId: "msg", ensureAwake: false, stream: false, createdAt: 1 } },
    flights: { flt: { id: "flt", invocationId: "inv", requesterId: "parent", targetAgentId: "child", state: "running", metadata: { bindingRef: "binding" } } },
  });
  const rows = buildWorkStatuses(snapshot);
  for (const ref of ["flt", "inv", "msg", "ref:binding"]) {
    expect(selectWorkStatuses(rows, parseStatusCommandOptions([ref]))[0]?.id).toBe("flt");
  }
  expect(() => selectWorkStatuses(rows, parseStatusCommandOptions(["missing"]))).toThrow("no work found");
  expect(() => selectWorkStatuses([...rows, { ...rows[0]!, id: "another" }], parseStatusCommandOptions(["ref:binding"]))).toThrow("ambiguous");
});

test("operator question resolves only on an exact operator reply, never an unrelated message", () => {
  const snapshot = createRuntimeRegistrySnapshot();
  snapshot.messages.question = { id: "question", conversationId: "dm", actorId: "child", originNodeId: "node", class: "agent", body: "Which target should I use?", visibility: "private", policy: "durable", createdAt: 1, metadata: { operatorSignal: { kind: "need", question: "Which target should I use?" } } };
  snapshot.messages.reply = { ...snapshot.messages.question, id: "reply", metadata: {}, actorId: "operator", body: "Other topic", createdAt: 2 };
  expect(buildWorkStatuses(snapshot)[0]?.blocked).toBe(true);
  snapshot.messages.reply.replyToMessageId = "question";
  expect(buildWorkStatuses(snapshot)[0]?.state).toBe("answered");
  snapshot.messages.reply.actorId = "another-agent";
  expect(buildWorkStatuses(snapshot)[0]?.blocked).toBe(true);
});
