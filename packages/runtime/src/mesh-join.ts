import type { NodeDefinition } from "@openscout/protocol";

import { requestScoutBrokerJson } from "./broker-api.js";

export type MeshJoinDiscovery = {
  discovered: NodeDefinition[];
  probes: string[];
  error: string | null;
};

type BrokerJsonRequest = typeof requestScoutBrokerJson;

/**
 * Make mesh participation durable before attempting best-effort peer discovery.
 * A discovery outage must not report the preceding successful bind as a failed
 * join, while a bind failure must stop before any discovery work begins.
 */
export async function joinBrokerMesh(
  controlUrl: string,
  requestJson: BrokerJsonRequest = requestScoutBrokerJson,
): Promise<MeshJoinDiscovery> {
  await requestJson(controlUrl, "/v1/mesh/bind", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: { scope: "mesh" },
  });

  try {
    const result = await requestJson<{ discovered?: NodeDefinition[]; probes?: string[] }>(
      controlUrl,
      "/v1/mesh/discover",
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: {},
        signal: AbortSignal.timeout(60_000),
      },
    );
    return {
      discovered: result.discovered ?? [],
      probes: result.probes ?? [],
      error: null,
    };
  } catch (error) {
    return {
      discovered: [],
      probes: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function leaveBrokerMesh(
  controlUrl: string,
  requestJson: BrokerJsonRequest = requestScoutBrokerJson,
): Promise<void> {
  await requestJson(controlUrl, "/v1/mesh/bind", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: { scope: "local" },
  });
}
