import { describe, expect, test } from "bun:test";

import { SCOUTBOT_SUBMIT_EVENT } from "../../lib/scoutbot.ts";
import type { Agent, BrokerRouteAttempt } from "../../lib/types.ts";
import {
  brokerAttemptContextJson,
  brokerAttemptContextText,
  brokerAttemptDedupeFingerprint,
  brokerAttemptErrorSummary,
  brokerAttemptFailureTitle,
  brokerAttemptIsFailure,
  brokerMessageFeedRows,
  brokerAttemptRootCauseFingerprint,
  brokerAttemptTargetAgent,
  brokerDispatchReviewRequest,
  brokerScoutbotTriageRequest,
  brokerMetadataPayload,
  brokerMetadataSummary,
} from "./broker-display.ts";

function agent(overrides: Partial<Agent> & Pick<Agent, "id" | "name">): Agent {
  return {
    definitionId: overrides.id,
    handle: null,
    agentClass: "agent",
    harness: "claude",
    state: "online",
    projectRoot: "/Users/art/dev/openscout",
    cwd: "/Users/art/dev/openscout",
    updatedAt: 1,
    createdAt: 1,
    transport: "tmux",
    selector: null,
    defaultSelector: null,
    nodeQualifier: null,
    workspaceQualifier: null,
    wakePolicy: null,
    capabilities: [],
    project: "openscout",
    branch: "main",
    role: null,
    model: "opus",
    harnessSessionId: null,
    terminalSurface: null,
    harnessLogPath: null,
    conversationId: null,
    homeNodeId: null,
    homeNodeName: null,
    ownerId: null,
    ownerName: null,
    ownerHandle: null,
    staleLocalRegistration: false,
    retiredFromFleet: false,
    replacedByAgentId: null,
    ...overrides,
  };
}

function attempt(overrides: Partial<BrokerRouteAttempt> = {}): BrokerRouteAttempt {
  return {
    id: "attempt-1",
    kind: "success",
    status: "sent",
    ts: 1,
    actorName: "Ava",
    target: "session-mcp@pi-lattice",
    route: "dm",
    detail: "Project-path routed request",
    conversationId: "c-1",
    messageId: "msg-1",
    deliveryId: null,
    invocationId: null,
    ...overrides,
  };
}

describe("broker dispatch display", () => {
  test("flags failed deliveries as failures", () => {
    expect(brokerAttemptIsFailure(attempt({ kind: "failed_delivery", status: "failed" }))).toBe(true);
    expect(brokerAttemptIsFailure(attempt())).toBe(false);
    expect(brokerAttemptContextText(attempt())).toContain("OpenScout dispatch context");
  });

  test("resolves retry destination from the attempted session and relay metadata", () => {
    const intended = agent({
      id: "openscout-plato-5",
      name: "openscout-plato-5",
      harnessSessionId: "session-ms5b6u68-xwdwqx",
    });
    const unrelated = agent({ id: "scoutbot", name: "Scout" });
    const dispatched = attempt({
      target: "session-ms5b6u68-xwdwqx",
      metadata: {
        raw: {
          targetSessionId: "session-ms5b6u68-xwdwqx",
          targetDisplayName: "openscout-plato-5",
          relayTarget: "session-ms5b6u68-xwdwqx",
        },
      },
    });

    expect(brokerAttemptTargetAgent(dispatched, [unrelated, intended])).toBe(intended);
  });

  test("uses the attempted destination's display name when its session id is no longer attached", () => {
    const intended = agent({ id: "agent-plato", name: "openscout-plato-5" });
    const unrelated = agent({ id: "scoutbot", name: "Scout" });
    const dispatched = attempt({
      target: "session-ms5b6u68-xwdwqx",
      metadata: {
        raw: {
          targetSessionId: "session-ms5b6u68-xwdwqx",
          targetDisplayName: "openscout-plato-5",
        },
      },
    });

    expect(brokerAttemptTargetAgent(dispatched, [unrelated, intended])).toBe(intended);
    expect(brokerAttemptTargetAgent(dispatched, [unrelated])).toBeNull();
  });

  test("presents one message row with its linked delivery failure folded in", () => {
    const message = attempt({
      id: "message:message-1",
      kind: "success",
      status: "sent",
      ts: 100,
      actorName: "Arach",
      target: "agent-1",
      route: "dm",
      detail: "Please review this.",
      messageId: "message-1",
      metadata: { source: "messages" },
    });
    const failure = attempt({
      id: "delivery:delivery-1",
      kind: "failed_delivery",
      status: "failed",
      ts: 110,
      actorName: "Agent One",
      target: "agent-1",
      route: "local_socket",
      detail: "direct_message",
      messageId: "message-1",
      deliveryId: "delivery-1",
      metadata: { failureReason: "agent_unreachable" },
    });
    const retry = attempt({
      id: "attempt:attempt-1",
      kind: "delivery_attempt",
      status: "failed",
      ts: 105,
      messageId: "message-1",
      deliveryId: "delivery-1",
    });

    expect(brokerMessageFeedRows([failure, retry, message])).toEqual([{
      ...failure,
      id: message.id,
      ts: message.ts,
      actorName: "Arach",
      route: "dm",
      detail: "Please review this.",
      metadata: {
        failureReason: "agent_unreachable",
        message: { source: "messages" },
      },
    }]);
  });

  test("summarizes dispatch metadata for failed queries", () => {
    const failedQuery = attempt({
      kind: "failed_query",
      status: "failed",
      detail: "No agent matches for pi-lattice",
      metadata: {
        dispatchKind: "unknown",
        requestedLabel: "pi-lattice",
      },
    });
    expect(brokerAttemptFailureTitle(failedQuery)).toBe("Target not found");
    expect(brokerAttemptErrorSummary(failedQuery)).toBe("Target not found");
  });

  test("prefers actionable delivery failure detail over its transport reason", () => {
    const summary = brokerAttemptErrorSummary(attempt({
      kind: "failed_delivery",
      status: "failed",
      detail: "Please review this.",
      metadata: {
        reason: "direct_message",
        failureReason: "local_socket_unreachable",
        failureDetail: "connect ENOENT /tmp/agent.sock",
      },
    }));
    expect(summary).toContain("connect ENOENT /tmp/agent.sock");
    expect(summary).not.toContain("direct_message");
  });

  test("does not present a generic delivery reason as an error", () => {
    expect(brokerAttemptErrorSummary(attempt({
      kind: "failed_delivery",
      status: "failed",
      detail: "Please review this.",
      metadata: { reason: "direct_message" },
    }))).toBeNull();
  });

  test("splits metadata into summary scalars and structured payload", () => {
    const summary = brokerMetadataSummary({
      source: "messages",
      class: "scout.dispatch",
      raw: {
        request: "hello",
        context: { project: "openscout" },
      },
    });
    expect(summary).toEqual([
      { key: "source", value: "messages" },
      { key: "class", value: "scout.dispatch" },
    ]);
    expect(brokerMetadataPayload({
      source: "messages",
      class: "scout.dispatch",
      raw: {
        request: "hello",
        context: { project: "openscout" },
      },
    })).toEqual({
      request: "hello",
      context: { project: "openscout" },
    });
  });

  test("builds a stable copy context and dedupe fingerprint for failed deliveries", () => {
    const failed = attempt({
      kind: "failed_delivery",
      status: "failed",
      target: "talkie.codex-agent",
      route: "local_socket",
      detail: "mention",
      messageId: "msg-1",
      deliveryId: "delivery-1",
      metadata: {
        source: "deliveries",
        targetId: "talkie.codex-agent",
        transport: "local_socket",
        reason: "mention",
        failureReason: "local_socket_unreachable",
        failureDetail: "connect ENOENT /tmp/talkie.sock",
      },
    });

    expect(brokerAttemptDedupeFingerprint(failed))
      .toBe("failed_delivery|msg-1|talkie.codex-agent|local_socket");
    expect(brokerAttemptRootCauseFingerprint(failed))
      .toBe("failed_delivery|talkie.codex-agent|local_socket|local_socket_unreachable|connect enoent /tmp/talkie.sock");
    expect(brokerAttemptContextJson(failed)).toMatchObject({
      dedupeFingerprint: "failed_delivery|msg-1|talkie.codex-agent|local_socket",
      rootCauseFingerprint: "failed_delivery|talkie.codex-agent|local_socket|local_socket_unreachable|connect enoent /tmp/talkie.sock",
      attempt: failed,
    });
    expect(brokerAttemptContextText(failed)).toContain("Full JSON:");
    expect(brokerAttemptContextText(failed)).toContain("deliveryId: delivery-1");
  });

  test("includes the inspected snapshot when requesting a report for a synthesized message row", () => {
    const synthesized = attempt({
      id: "message:msg-1",
      kind: "failed_delivery",
      status: "failed",
      messageId: "msg-1",
      deliveryId: "delivery-1",
    });

    expect(brokerDispatchReviewRequest(synthesized)).toEqual({
      attemptId: "message:msg-1",
      attempt: synthesized,
    });
  });

  test("builds an explicit Scout submission for failed-dispatch triage", () => {
    const failed = attempt({
      kind: "failed_delivery",
      status: "failed",
      detail: "connect ENOENT /tmp/talkie.sock",
      deliveryId: "delivery-1",
    });

    const request = brokerScoutbotTriageRequest(failed);

    expect(request.eventName).toBe(SCOUTBOT_SUBMIT_EVENT);
    expect(request.eventName).toBe("scout:scoutbot-submit");
    expect(request.body).toContain("Review and triage this failed dispatch.");
    expect(request.body).toContain("report your verdict and recommended next step");
    expect(request.body).toContain("deliveryId: delivery-1");
    expect(request.body).toContain("connect ENOENT /tmp/talkie.sock");
  });
});
