import {
  loadScoutBrokerContext,
  readScoutBrokerHealth,
  resolveScoutBrokerUrl,
} from "./core/broker/service.ts";

export type OpenScoutWebShellState = {
  runtime: {
    brokerReachable: boolean;
    brokerHealthy: boolean;
    brokerLabel: string;
    agentCount: number;
    messageCount: number;
    nodeId: string | null;
    error: string | null;
  };
};

export async function loadOpenScoutWebShellState(): Promise<OpenScoutWebShellState> {
  const brokerUrl = resolveScoutBrokerUrl();
  const health = await readScoutBrokerHealth(brokerUrl);

  if (!health.reachable) {
    return {
      runtime: {
        brokerReachable: false,
        brokerHealthy: false,
        brokerLabel: "Offline",
        agentCount: 0,
        messageCount: 0,
        nodeId: null,
        error: health.error ?? null,
      },
    };
  }

  const context = health.ok ? await loadScoutBrokerContext(brokerUrl) : null;
  const agents = health.counts?.agents ?? Object.keys(context?.snapshot.agents ?? {}).length;
  const messages = health.counts?.messages ?? Object.keys(context?.snapshot.messages ?? {}).length;

  return {
    runtime: {
      brokerReachable: true,
      brokerHealthy: health.ok,
      brokerLabel: health.ok ? "Running" : "Degraded",
      agentCount: agents,
      messageCount: messages,
      nodeId: health.nodeId ?? context?.node.id ?? null,
      error: health.error ?? null,
    },
  };
}
