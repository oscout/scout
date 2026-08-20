import { describe, expect, test } from "bun:test";

import type { ResolvedRelayAgentConfig } from "./setup.js";
import {
  isReusableBrokerRegisteredTargetAgent,
  scoutBrokerAgentRegistrationFromConfig,
} from "./scout-broker.js";

describe("scout broker relay-agent registration", () => {
  test("marks configured relay agents as broker-registered for shared client projection", () => {
    const config: ResolvedRelayAgentConfig = {
      agentId: "ocean-minimax.main.ocean-iron",
      definitionId: "ocean-minimax",
      displayName: "Ocean Minimax",
      projectName: "Scout Ocean Agent",
      projectRoot: "/home/exedev/scout-ocean-agent",
      projectConfigPath: null,
      source: "manual",
      registrationKind: "configured",
      startedAt: 1,
      launchArgs: ["--no-extensions"],
      capabilities: ["chat", "invoke", "deliver"],
      defaultHarness: "pi",
      harnessProfiles: {},
      instance: {
        id: "ocean-minimax.main.ocean-iron",
        selector: "@ocean-minimax.main.node:ocean-iron",
        defaultSelector: "@ocean-minimax",
        nodeQualifier: "ocean-iron",
        workspaceQualifier: "main",
        branch: "main",
        isDefault: true,
      },
      runtime: {
        cwd: "/home/exedev/scout-ocean-agent",
        harness: "pi",
        transport: "pi_rpc",
        sessionId: "relay-ocean-minimax-main-ocean-iron-pi",
        wakePolicy: "on_demand",
      },
    };

    const registration = scoutBrokerAgentRegistrationFromConfig(
      config,
      "ocean-iron-openscout",
    );

    expect(registration.agent.metadata).toMatchObject({
      brokerRegistered: true,
      source: "relay-agent-registry",
      project: "Scout Ocean Agent",
    });
  });

  test("re-registers legacy target cards that predate the projection marker", () => {
    const base = {
      id: "ocean-minimax.main.ocean-iron",
      kind: "agent",
      definitionId: "ocean-minimax",
      displayName: "Ocean Minimax",
      agentClass: "general" as const,
      capabilities: ["chat" as const],
      wakePolicy: "on_demand" as const,
      homeNodeId: "ocean-iron-openscout",
      authorityNodeId: "ocean-iron-openscout",
      advertiseScope: "local" as const,
    };

    expect(isReusableBrokerRegisteredTargetAgent({
      ...base,
      metadata: { source: "relay-agent-registry" },
    })).toBe(false);
    expect(isReusableBrokerRegisteredTargetAgent({
      ...base,
      metadata: { brokerRegistered: true },
    })).toBe(true);
    expect(isReusableBrokerRegisteredTargetAgent({
      ...base,
      metadata: { source: "broker" },
    })).toBe(true);
    expect(isReusableBrokerRegisteredTargetAgent({
      ...base,
      metadata: { brokerRegistered: true, staleLocalRegistration: true },
    })).toBe(false);
  });
});
