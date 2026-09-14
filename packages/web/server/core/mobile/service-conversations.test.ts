import { expect, test } from "bun:test";
import { directChannelNaturalKey } from "@openscout/protocol";
import { createRuntimeRegistrySnapshot } from "../../../../runtime/src/registry.ts";
import { buildMobileAgentSummary, buildMobileSessionSnapshot, resolveMobileConversation } from "./service.ts";
import { buildMobileSessionSnapshot as desktopSnapshot, resolveMobileConversation as desktopResolve } from "../../../../../apps/desktop/src/core/mobile/service.ts";

function fixture() {
  const snapshot = createRuntimeRegistrySnapshot();
  snapshot.agents.worker = {
    id: "worker", kind: "agent", definitionId: "worker", displayName: "Worker",
    agentClass: "general", capabilities: [], wakePolicy: "manual", homeNodeId: "local",
    authorityNodeId: "local", advertiseScope: "local",
  };
  snapshot.conversations.shared = {
    id: "shared", kind: "channel", title: "shared-channel", visibility: "workspace",
    shareMode: "shared", authorityNodeId: "local", participantIds: ["operator", "worker"],
  };
  return snapshot;
}

test("channel-only lanes resolve to null and render empty history in both mobile services", () => {
  const snapshot = fixture();
  expect(buildMobileAgentSummary(snapshot, snapshot.agents.worker!).conversationId).toBeNull();
  for (const resolve of [resolveMobileConversation, desktopResolve]) {
    expect(resolve(snapshot, "worker")).toBeNull();
    expect(resolve(snapshot, "shared")).toBe(snapshot.conversations.shared);
  }
  for (const build of [buildMobileSessionSnapshot, desktopSnapshot]) {
    const result = build(snapshot, "worker");
    expect(result.turns).toEqual([]);
    expect(result.history.hasOlder).toBe(false);
    expect(result.currentTurnId).toBeNull();
    expect(result.session.name).toBe("Worker");
    expect(result.session.providerMeta?.agentId).toBe("worker");
  }
  expect(buildMobileSessionSnapshot(snapshot, "worker").session.providerMeta?.conversationId).toBeNull();
  expect(() => buildMobileSessionSnapshot(snapshot, "unknown")).toThrow("Unknown mobile session");
});

test("operator DM and non-channel consult fallback stay routable", () => {
  const snapshot = fixture();
  snapshot.conversations.consult = {
    ...snapshot.conversations.shared!, id: "consult", kind: "direct", participantIds: ["worker", "other"],
  };
  for (const resolve of [resolveMobileConversation, desktopResolve]) {
    expect(resolve(snapshot, "worker")?.id).toBe("consult");
  }
  const id = "dm.operator.worker";
  snapshot.conversations[id] = {
    ...snapshot.conversations.consult!, id, participantIds: ["operator", "worker"],
    metadata: { naturalKey: directChannelNaturalKey(["operator", "worker"]) },
  };
  for (const resolve of [resolveMobileConversation, desktopResolve]) {
    expect(resolve(snapshot, "worker")?.id).toBe(id);
  }
  expect(buildMobileAgentSummary(snapshot, snapshot.agents.worker!).conversationId).toBe(id);
});
