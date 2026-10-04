import { hasRetiredEndpointRegistration, isEndpointOnlineState } from "./broker-endpoint-selection.js";
import type { AgentEndpoint, HerdrSessionTopology } from "@openscout/protocol";
import type { ListeningBinding } from "./broker-chat-listening.js";
export function endpointListeningFacing(endpoint: AgentEndpoint): "operator" | "background" {
  return endpoint.pane || endpoint.transport === "tmux" || ["foreground", "attached"].includes(String(endpoint.metadata?.placement)) ? "operator" : "background";
}
export type BindingObservation = { availability: "available" | "unavailable" | "unknown"; facing?: "operator" | "background"; terminalId?: string; endpointId?: string };
/** Read-only identity proof, not a delivery/readiness probe. A failed probe is
 * unknown, never proof of death. Never resumes, creates or retargets anything. */
export function createListeningSessionObserver(options: {
  herdr: (session: string) => Promise<HerdrSessionTopology>;
  endpoints: () => AgentEndpoint[];
  nodeId: string;
}) {
  return async (binding: ListeningBinding): Promise<BindingObservation> => {
    if (binding.mode !== "session" || !binding.sessionId) return { availability: "unknown" };
    if (binding.herdrSession && binding.pane) {
      let topology: HerdrSessionTopology;
      try { topology = await options.herdr(binding.herdrSession); } catch { return { availability: "unknown" }; }
      // Older Herdr probe classifiers conflate CLI failure with not-running.
      // Only a successful live topology is authority for disappearance here.
      if (!topology.running) return { availability: "unknown" };
      const panes = topology.workspaces.flatMap(w => w.tabs).flatMap(t => t.panes).filter(p => p.paneId === binding.pane);
      if (!panes.length) return { availability: "unavailable" };
      if (panes.length !== 1) return { availability: "unknown" };
      const pane = panes[0]!;
      if (!pane.terminalId) return { availability: "unknown" };
      if (binding.terminalId && pane.terminalId !== binding.terminalId) return { availability: "unavailable" };
      if (!pane.agentSession || pane.agentSession.kind !== "id") return { availability: "unknown" };
      if (pane.agentSession.value !== binding.sessionId || (binding.harness && pane.agentSession.agent !== binding.harness)) return { availability: "unavailable" };
      return { availability: "available", facing: "operator", terminalId: pane.terminalId ?? undefined };
    }
    const identities = (endpoint: AgentEndpoint) => [endpoint.sessionId, endpoint.metadata?.nativeSessionId, endpoint.metadata?.externalSessionId]
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    // Resolve a pinned endpoint before checking its identity: managed endpoints
    // can be reused for another session, which permanently ends the old binding.
    const endpoints = options.endpoints().filter(e => e.nodeId === options.nodeId
      && (binding.endpointId ? e.id === binding.endpointId : identities(e).includes(binding.sessionId!)));
    if (endpoints.length !== 1) return { availability: "unknown" };
    const endpoint = endpoints[0]!;
    if ((["stopped", "superseded"].includes(endpoint.state) || hasRetiredEndpointRegistration(endpoint))) return { availability: "unavailable" };
    const knownIdentities = identities(endpoint);
    if (!knownIdentities.includes(binding.sessionId)) return { availability: knownIdentities.length ? "unavailable" : "unknown" };
    if (binding.harness && endpoint.harness !== binding.harness) return { availability: endpoint.harness ? "unavailable" : "unknown" };
    if (!isEndpointOnlineState(endpoint.state)) return { availability: "unknown" };
    return { availability: "available", endpointId: endpoint.id,
      facing: endpointListeningFacing(endpoint) };
  };
}
