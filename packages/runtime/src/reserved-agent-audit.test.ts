import { describe, expect, test } from "bun:test";

import type { AgentDefinition } from "@openscout/protocol";

import { assertNoReservedStoredAgentNames } from "./reserved-agent-audit.js";

function agent(definitionId: string): AgentDefinition {
  return {
    id: `${definitionId}.main.node`,
    kind: "agent",
    definitionId,
    displayName: definitionId,
    agentClass: "general",
    capabilities: ["chat"],
    wakePolicy: "on_demand",
    homeNodeId: "node",
    authorityNodeId: "node",
    advertiseScope: "local",
  };
}

describe("stored reserved agent audit", () => {
  test("fails startup for historical runtime-vocabulary identities", () => {
    expect(() => assertNoReservedStoredAgentNames({
      codex: agent("codex"),
    })).toThrow('reserved_name_existing: stored agent codex.main.node uses reserved harness name "codex"');
    expect(() => assertNoReservedStoredAgentNames({
      max: agent("max"),
    })).toThrow('reserved_name_existing: stored agent max.main.node uses reserved effort name "max"');
  });

  test("allows ordinary, built-in, and product identities", () => {
    expect(() => assertNoReservedStoredAgentNames({
      ranger: agent("ranger"),
      scout: agent("scout"),
      openscout: agent("openscout"),
      reviewer: agent("reviewer"),
    })).not.toThrow();
  });

  test("does not let a remote mesh identity block local startup", () => {
    const remote = agent("fable");
    remote.homeNodeId = "remote-node";
    remote.authorityNodeId = "remote-node";

    expect(() => assertNoReservedStoredAgentNames(
      { fable: remote },
      { localNodeId: "local-node" },
    )).not.toThrow();
  });

  test("still rejects a reserved identity owned by the local node", () => {
    expect(() => assertNoReservedStoredAgentNames(
      { fable: agent("fable") },
      { localNodeId: "node" },
    )).toThrow('reserved_name_existing: stored agent fable.main.node uses reserved profile name "fable"');
  });
});
