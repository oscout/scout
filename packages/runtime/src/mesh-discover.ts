import { DEFAULT_BROKER_URL } from "./broker-process-manager.js";

function resolveBrokerUrl(): string {
  return (process.env.OPENSCOUT_BROKER_URL ?? DEFAULT_BROKER_URL).replace(/\/$/, "");
}

function collectSeeds(argv: string[]): string[] {
  return argv
    .map((value) => value.trim())
    .filter(Boolean);
}

async function postJson<T>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`request failed: ${response.status} ${response.statusText}${detail ? `\n${detail}` : ""}`);
  }

  return await response.json() as T;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`request failed: ${response.status} ${response.statusText}${detail ? `\n${detail}` : ""}`);
  }

  return await response.json() as T;
}

interface DiscoverResponse {
  ok: true;
  discovered: Array<{
    id: string;
    meshId: string;
    name: string;
    brokerUrl?: string;
    advertiseScope: string;
    lastSeenAt?: number;
  }>;
}

async function main(): Promise<void> {
  const brokerUrl = resolveBrokerUrl();
  const seeds = collectSeeds(process.argv.slice(2));

  const health = await getJson<{ ok: boolean; nodeId: string; meshId: string }>(`${brokerUrl}/health`);
  console.log(`Broker: ${brokerUrl}`);
  console.log(`Node:   ${health.nodeId}`);
  console.log(`Mesh:   ${health.meshId}`);

  const result = await postJson<DiscoverResponse>(`${brokerUrl}/v1/mesh/discover`, { seeds });
  console.log("");

  if (result.discovered.length === 0) {
    console.log("No peers discovered.");
  } else {
    console.log("Discovered peers:");
    for (const node of result.discovered) {
      console.log(`- ${node.name} (${node.id}) -> ${node.brokerUrl ?? "no broker url"}`);
    }
  }

  const nodes = await getJson<Record<string, { name: string; brokerUrl?: string; advertiseScope: string }>>(
    `${brokerUrl}/v1/mesh/nodes`,
  );

  console.log("");
  console.log("Known mesh nodes:");
  for (const [id, node] of Object.entries(nodes)) {
    console.log(`- ${node.name} (${id}) [${node.advertiseScope}]${node.brokerUrl ? ` -> ${node.brokerUrl}` : ""}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
