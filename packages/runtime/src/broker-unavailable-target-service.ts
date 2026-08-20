import type {
  AgentDefinition,
  NodeDefinition,
  ScoutDispatchEnvelope,
  ScoutDispatchUnavailableTarget,
} from "@openscout/protocol";

import { brokerTargetProjectRoot } from "./broker-conversation-helpers.js";
import {
  staleLocalAgentReason,
} from "./broker-local-invocation-helpers.js";
import { isManagedLocalSessionMetadata } from "./broker-managed-session-helpers.js";
import {
  classifyEndpoint,
  endpointCandidateState,
  homeEndpointForAgent,
  latestEndpointForAgent,
} from "./broker-endpoint-selection.js";
import { isDirectLocalAgentTransport } from "./local-agent-transports.js";
import type { RuntimeRegistrySnapshot } from "./registry.js";

type BrokerUnavailableTargetServiceDeps = {
  nodeId: string;
  describeRemoteAuthorityIssue: (
    agent: AgentDefinition,
    authorityNode: NodeDefinition | undefined,
  ) => ScoutDispatchUnavailableTarget | null;
  now?: () => number;
};

export class BrokerUnavailableTargetService {
  readonly #deps: BrokerUnavailableTargetServiceDeps;

  constructor(deps: BrokerUnavailableTargetServiceDeps) {
    this.#deps = deps;
  }

  describe(
    snapshot: RuntimeRegistrySnapshot,
    agent: AgentDefinition,
    targetSessionId?: string,
  ): ScoutDispatchUnavailableTarget | null {
    const supersededReason = targetSessionId
      ? staleLocalAgentReason(snapshot, agent)
      : agent.metadata?.staleLocalRegistration === true
      ? staleLocalAgentReason(snapshot, agent)
      : null;
    if (supersededReason) {
      const endpoint = latestEndpointForAgent(snapshot, agent.id);
      return {
        agentId: agent.id,
        displayName: agent.displayName ?? agent.id,
        reason: targetSessionId ? "session_reference_not_attachable" : "superseded_registration",
        detail: supersededReason,
        wakePolicy: agent.wakePolicy,
        endpointState: endpointCandidateState(endpoint?.state),
        transport: endpoint?.transport ?? null,
        projectRoot: brokerTargetProjectRoot(agent, endpoint),
      };
    }

    const endpoint = homeEndpointForAgent(snapshot, agent.id);
    const endpointClassification = classifyEndpoint(endpoint, { agent });
    const projectRoot = brokerTargetProjectRoot(agent, endpoint);

    if (agent.metadata?.retiredFromFleet === true) {
      return {
        agentId: agent.id,
        displayName: agent.displayName ?? agent.id,
        reason: "retired",
        detail: `${agent.displayName ?? agent.id} is retired from the fleet and cannot receive new broker deliveries.`,
        wakePolicy: agent.wakePolicy,
        endpointState: endpoint?.state === "offline" ? "offline" : "unknown",
        transport: endpoint?.transport ?? null,
        projectRoot,
      };
    }

    if (agent.authorityNodeId && agent.authorityNodeId !== this.#deps.nodeId) {
      return this.#deps.describeRemoteAuthorityIssue(agent, snapshot.nodes[agent.authorityNodeId]);
    }

    if (agent.wakePolicy !== "manual" && (endpointClassification.wakeable || endpointClassification.runnable)) {
      return null;
    }

    if (endpointClassification.reachable) {
      return null;
    }

    if (
      endpoint
      && isManagedLocalSessionMetadata(endpoint.metadata)
      && isDirectLocalAgentTransport(endpoint.transport)
    ) {
      return null;
    }

    return {
      agentId: agent.id,
      displayName: agent.displayName ?? agent.id,
      reason: "manual_wake_required",
      detail: `${agent.displayName ?? agent.id} is currently offline with a manual wake policy, so the broker cannot bring it online without operator help.`,
      wakePolicy: agent.wakePolicy,
      endpointState: endpointCandidateState(endpoint?.state),
      transport: endpoint?.transport ?? null,
      projectRoot,
    };
  }

  buildEnvelope(
    askedLabel: string,
    target: ScoutDispatchUnavailableTarget,
  ): ScoutDispatchEnvelope {
    return {
      kind: "unavailable",
      askedLabel,
      detail: target.detail,
      candidates: [],
      target,
      dispatchedAt: this.#deps.now?.() ?? Date.now(),
      dispatcherNodeId: this.#deps.nodeId,
    };
  }
}
