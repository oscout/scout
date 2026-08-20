import { describe, expect, test } from "bun:test";
import type { ScoutBrokerFlightRecord, ScoutBrokerMessageRecord } from "../core/broker/service.ts";
import {
  hasCurrentScoutbotAgentRegistration,
  isScoutbotAddressedMessage,
  isScoutbotDirectDeliveryFlight,
} from "./runner.ts";
import {
  SCOUTBOT_ROLE_CONFIG,
  scoutbotCodexLaunchArgs,
  scoutbotRuntimeToolNames,
} from "./role.ts";

describe("scoutbot runner routing", () => {
  test("constrains Codex to the effective Scout broker tool manifest", () => {
    expect(SCOUTBOT_ROLE_CONFIG.grants).toMatchObject({
      shell: false,
      codebaseWrites: false,
      write: ["messages_send", "ask"],
    });
    expect(scoutbotRuntimeToolNames()).toEqual(expect.arrayContaining([
      "agents_search",
      "broker_feed",
      "messages_send",
      "ask",
    ]));
    expect(scoutbotCodexLaunchArgs()).toEqual(expect.arrayContaining([
      "features.shell_tool=false",
      "features.unified_exec=false",
      "features.browser_use=false",
      `mcp_servers.scout.enabled_tools=${JSON.stringify(scoutbotRuntimeToolNames())}`,
    ]));
  });

  test("recognizes direct-route metadata as addressed to scoutbot", () => {
    const message = {
      id: "msg-direct-status",
      conversationId: "dm.operator.scoutbot",
      actorId: "operator",
      body: "/status",
      createdAt: 1,
      class: "agent",
      metadata: {
        destinationKind: "direct",
        destinationId: "scoutbot",
        relayTargetIds: ["scoutbot"],
      },
    } as ScoutBrokerMessageRecord;

    expect(isScoutbotAddressedMessage(message)).toBe(true);
  });

  test("distinguishes broker direct deliveries from runner-owned scoutbot flights", () => {
    const directFlight = {
      id: "flight-direct",
      invocationId: "inv-direct",
      requesterId: "operator",
      targetAgentId: "scoutbot",
      state: "queued",
      metadata: {
        source: "scout-mobile",
        destinationKind: "direct",
        destinationId: "scoutbot",
      },
    } as ScoutBrokerFlightRecord;
    const runnerFlight = {
      ...directFlight,
      id: "flight-runner",
      metadata: {
        source: "scoutbot",
        relayTarget: "scoutbot",
      },
    } as ScoutBrokerFlightRecord;

    expect(isScoutbotDirectDeliveryFlight(directFlight)).toBe(true);
    expect(isScoutbotDirectDeliveryFlight(runnerFlight)).toBe(false);
  });

  test("requires scoutbot to be owned by the local node", () => {
    const agent = {
      id: "scoutbot",
      kind: "agent",
      displayName: "Scout",
      handle: "scoutbot",
      labels: ["assistant", "scout", "scoutbot"],
      metadata: {
        source: "scoutbot",
        brokerRegistered: true,
        roleConfig: SCOUTBOT_ROLE_CONFIG,
      },
      definitionId: "scoutbot",
      selector: "@scoutbot",
      defaultSelector: "@scoutbot",
      agentClass: "operator",
      capabilities: ["chat", "invoke", "deliver"],
      wakePolicy: "keep_warm",
      homeNodeId: "peer-node",
      authorityNodeId: "peer-node",
      advertiseScope: "local",
    };

    expect(hasCurrentScoutbotAgentRegistration(agent, "local-node")).toBe(false);
    expect(hasCurrentScoutbotAgentRegistration({
      ...agent,
      homeNodeId: "local-node",
      authorityNodeId: "local-node",
    }, "local-node")).toBe(true);
  });
});
