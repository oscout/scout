#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const bridgeManifest = resolve(repoRoot, "packages/runtime/native/iroh-bridge/Cargo.toml");
const bridgeBin = resolve(repoRoot, "packages/runtime/native/iroh-bridge/target/debug/openscout-iroh-bridge");
const runtimeSource = resolve(repoRoot, "packages/runtime/src/broker-daemon.ts");
const defaultBrokerUrl = process.env.OPENSCOUT_BROKER_URL ?? "http://127.0.0.1:65501";

const [, , command, ...args] = process.argv;

function usage(exitCode = 0) {
  console.log(`OpenScout Mesh Iroh smoke helper

Usage:
  bun scripts/mesh-iroh-smoke.mjs build-bridge
  bun scripts/mesh-iroh-smoke.mjs run-broker [-- broker args...]
  bun scripts/mesh-iroh-smoke.mjs inspect [--broker-url URL]
  bun scripts/mesh-iroh-smoke.mjs export-node [--broker-url URL] [--out FILE]
  bun scripts/mesh-iroh-smoke.mjs import-node --file FILE [--broker-url URL]
  bun scripts/mesh-iroh-smoke.mjs send-message [--broker-url URL] [--peer-node-id ID] [--body TEXT]
  bun scripts/mesh-iroh-smoke.mjs check-message --conversation-id ID [--broker-url URL]
  bun scripts/mesh-iroh-smoke.mjs send-invocation [--broker-url URL] [--peer-node-id ID] [--task TEXT]
  bun scripts/mesh-iroh-smoke.mjs check-invocation --invocation-id ID [--broker-url URL]

Two-machine loop before Cloudflare:
  1. On both machines: bun scripts/mesh-iroh-smoke.mjs build-bridge
  2. On both machines: bun scripts/mesh-iroh-smoke.mjs run-broker
  3. On both machines: bun scripts/mesh-iroh-smoke.mjs export-node --out node.json
  4. Copy each node.json to the other machine.
  5. On each machine: bun scripts/mesh-iroh-smoke.mjs import-node --file peer-node.json
  6. Run inspect on both machines and verify both nodes have iroh entrypoints.
  7. From one machine: bun scripts/mesh-iroh-smoke.mjs send-message --peer-node-id PEER_ID
  8. On the peer: bun scripts/mesh-iroh-smoke.mjs check-message --conversation-id CONVERSATION_ID
  9. From one machine: bun scripts/mesh-iroh-smoke.mjs send-invocation --peer-node-id PEER_ID
  10. On the peer: bun scripts/mesh-iroh-smoke.mjs check-invocation --invocation-id INVOCATION_ID
`);
  process.exit(exitCode);
}

function parseOptions(argv) {
  const options = {};
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--") {
      rest.push(...argv.slice(index + 1));
      break;
    }
    if (value?.startsWith("--")) {
      const key = value.slice(2);
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        options[key] = "true";
      } else {
        options[key] = next;
        index += 1;
      }
    } else {
      rest.push(value);
    }
  }
  return { options, rest };
}

function run(commandName, commandArgs, options = {}) {
  const result = spawnSync(commandName, commandArgs, {
    cwd: repoRoot,
    stdio: options.stdio ?? "inherit",
    env: options.env ?? process.env,
    encoding: options.encoding,
  });
  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
  return result;
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}${detail ? `\n${detail}` : ""}`);
  }
  return await response.json();
}

async function postJson(url, payload) {
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
    throw new Error(`POST ${url} failed: ${response.status} ${response.statusText}${detail ? `\n${detail}` : ""}`);
  }
  return await response.json();
}

function brokerUrlFrom(options) {
  return (options["broker-url"] ?? defaultBrokerUrl).replace(/\/$/, "");
}

function irohEntrypoints(node) {
  return (node.meshEntrypoints ?? []).filter((entrypoint) => entrypoint.kind === "iroh");
}

function summarizeNode(node) {
  const iroh = irohEntrypoints(node);
  const routes = [];
  if (node.brokerUrl) routes.push(`http=${node.brokerUrl}`);
  if (iroh.length > 0) routes.push(`iroh=${iroh.map((entrypoint) => entrypoint.endpointId).join(",")}`);
  return `${node.name} (${node.id}) [${routes.join(" ") || "no entrypoints"}]`;
}

async function buildBridge() {
  const cargo = process.env.CARGO ?? `${process.env.HOME ?? ""}/.cargo/bin/cargo`;
  run(cargo, ["build", "--manifest-path", bridgeManifest]);
  console.log("");
  console.log(`Bridge binary: ${bridgeBin}`);
  console.log(`Run broker env: OPENSCOUT_IROH_BRIDGE_BIN=${bridgeBin}`);
}

function runBroker(rest) {
  if (!existsSync(bridgeBin)) {
    console.error(`Missing bridge binary: ${bridgeBin}`);
    console.error("Run: bun scripts/mesh-iroh-smoke.mjs build-bridge");
    process.exit(1);
  }

  const env = {
    ...process.env,
    OPENSCOUT_IROH_BRIDGE_BIN: process.env.OPENSCOUT_IROH_BRIDGE_BIN ?? bridgeBin,
  };
  console.log(`OPENSCOUT_IROH_BRIDGE_BIN=${env.OPENSCOUT_IROH_BRIDGE_BIN}`);
  run(process.execPath, [runtimeSource, ...rest], { env });
}

async function inspect(options) {
  const brokerUrl = brokerUrlFrom(options);
  const health = await getJson(`${brokerUrl}/health`);
  const localNode = await getJson(`${brokerUrl}/v1/node`);
  const nodes = await getJson(`${brokerUrl}/v1/mesh/nodes`);

  console.log(`Broker: ${brokerUrl}`);
  console.log(`Node:   ${health.nodeId}`);
  console.log(`Mesh:   ${health.meshId}`);
  console.log("");
  console.log(`Local:  ${summarizeNode(localNode)}`);
  if (irohEntrypoints(localNode).length === 0) {
    console.log("Warning: local node has no Iroh entrypoint. Check OPENSCOUT_IROH_BRIDGE_BIN and bridge startup logs.");
  }
  console.log("");
  console.log("Known nodes:");
  for (const node of Object.values(nodes)) {
    console.log(`- ${summarizeNode(node)}`);
  }
}

async function exportNode(options) {
  const brokerUrl = brokerUrlFrom(options);
  const node = await getJson(`${brokerUrl}/v1/node`);
  const payload = `${JSON.stringify(node, null, 2)}\n`;
  if (options.out) {
    writeFileSync(resolve(process.cwd(), options.out), payload);
    console.log(`Wrote ${options.out}`);
  } else {
    process.stdout.write(payload);
  }
  if (irohEntrypoints(node).length === 0) {
    console.error("Warning: exported node has no Iroh entrypoint.");
  }
}

async function importNode(options) {
  if (!options.file) {
    throw new Error("import-node requires --file FILE");
  }
  const brokerUrl = brokerUrlFrom(options);
  const node = JSON.parse(readFileSync(resolve(process.cwd(), options.file), "utf8"));
  const result = await postJson(`${brokerUrl}/v1/nodes`, node);
  console.log(`Imported ${node.name} (${result.nodeId ?? node.id}) into ${brokerUrl}`);
}

function createId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function pickPeerNode(localNode, nodes, explicitPeerNodeId) {
  if (explicitPeerNodeId) {
    const peer = nodes[explicitPeerNodeId];
    if (!peer) {
      throw new Error(`unknown peer node ${explicitPeerNodeId}`);
    }
    return peer;
  }

  const peers = Object.values(nodes).filter((node) => node.id !== localNode.id);
  const irohPeer = peers.find((node) => irohEntrypoints(node).length > 0);
  const peer = irohPeer ?? peers[0];
  if (!peer) {
    throw new Error("no peer nodes are known; import a peer node first");
  }
  return peer;
}

async function sendMessage(options) {
  const brokerUrl = brokerUrlFrom(options);
  const localNode = await getJson(`${brokerUrl}/v1/node`);
  const nodes = await getJson(`${brokerUrl}/v1/mesh/nodes`);
  const peer = pickPeerNode(localNode, nodes, options["peer-node-id"]);
  const agentId = options["actor-id"] ?? `mesh-smoke-${localNode.id}`;
  const conversationId = options["conversation-id"] ?? `channel.mesh-smoke.${localNode.id}.${peer.id}`;
  const messageId = options["message-id"] ?? createId("msg-mesh-smoke");
  const now = Date.now();

  await postJson(`${brokerUrl}/v1/agents`, {
    id: agentId,
    kind: "agent",
    definitionId: agentId,
    displayName: `Mesh Smoke ${localNode.name}`,
    handle: agentId,
    labels: ["mesh-smoke"],
    selector: `@${agentId}`,
    defaultSelector: `@${agentId}`,
    metadata: { source: "mesh-iroh-smoke" },
    agentClass: "general",
    capabilities: ["chat"],
    wakePolicy: "on_demand",
    homeNodeId: localNode.id,
    authorityNodeId: localNode.id,
    advertiseScope: "mesh",
  });

  await postJson(`${brokerUrl}/v1/conversations`, {
    id: conversationId,
    kind: "channel",
    title: "OpenScout Mesh Smoke",
    visibility: "workspace",
    shareMode: "shared",
    authorityNodeId: peer.id,
    participantIds: [agentId],
    metadata: {
      surface: "mesh-iroh-smoke",
      peerNodeId: peer.id,
    },
  });

  const result = await postJson(`${brokerUrl}/v1/messages`, {
    id: messageId,
    conversationId,
    actorId: agentId,
    originNodeId: localNode.id,
    class: "agent",
    body: options.body ?? `mesh smoke from ${localNode.name} to ${peer.name} at ${new Date(now).toISOString()}`,
    visibility: "workspace",
    policy: "durable",
    createdAt: now,
    metadata: {
      source: "mesh-iroh-smoke",
      peerNodeId: peer.id,
    },
  });

  console.log(`Sent ${messageId} from ${localNode.name} to authority ${peer.name}`);
  console.log(`Conversation: ${conversationId}`);
  console.log(`Peer:         ${peer.id}`);
  if (result.mesh) {
    console.log(`Mesh result:  ${JSON.stringify(result.mesh)}`);
  }
  console.log("");
  console.log("On the peer, run:");
  console.log(`  bun scripts/mesh-iroh-smoke.mjs check-message --conversation-id ${conversationId}`);
}

function agentDefinition(input) {
  return {
    id: input.id,
    kind: "agent",
    definitionId: input.id,
    displayName: input.displayName,
    handle: input.handle ?? input.id,
    labels: ["mesh-smoke"],
    selector: `@${input.id}`,
    defaultSelector: `@${input.id}`,
    metadata: { source: "mesh-iroh-smoke" },
    agentClass: "general",
    capabilities: input.capabilities ?? ["chat"],
    wakePolicy: "on_demand",
    homeNodeId: input.homeNodeId,
    authorityNodeId: input.authorityNodeId,
    advertiseScope: "mesh",
  };
}

async function checkMessage(options) {
  if (!options["conversation-id"]) {
    throw new Error("check-message requires --conversation-id ID");
  }
  const brokerUrl = brokerUrlFrom(options);
  const conversationId = options["conversation-id"];
  const messages = await getJson(`${brokerUrl}/v1/messages?conversationId=${encodeURIComponent(conversationId)}`);
  console.log(`Messages for ${conversationId}: ${messages.length}`);
  for (const message of messages) {
    console.log(`- ${message.id} ${message.actorId}: ${message.body}`);
  }
}

async function sendInvocation(options) {
  const brokerUrl = brokerUrlFrom(options);
  const localNode = await getJson(`${brokerUrl}/v1/node`);
  const nodes = await getJson(`${brokerUrl}/v1/mesh/nodes`);
  const peer = pickPeerNode(localNode, nodes, options["peer-node-id"]);
  const requesterId = options["requester-id"] ?? `mesh-smoke-${localNode.id}`;
  const targetAgentId = options["target-agent-id"] ?? `mesh-smoke-target-${peer.id}`;
  const conversationId = options["conversation-id"] ?? `channel.mesh-smoke.invocations.${localNode.id}.${peer.id}`;
  const invocationId = options["invocation-id"] ?? createId("inv-mesh-smoke");
  const now = Date.now();

  await postJson(`${brokerUrl}/v1/agents`, agentDefinition({
    id: requesterId,
    displayName: `Mesh Smoke ${localNode.name}`,
    homeNodeId: localNode.id,
    authorityNodeId: localNode.id,
    capabilities: ["chat", "invoke"],
  }));

  await postJson(`${brokerUrl}/v1/agents`, agentDefinition({
    id: targetAgentId,
    displayName: `Mesh Smoke Target ${peer.name}`,
    homeNodeId: peer.id,
    authorityNodeId: peer.id,
    capabilities: ["chat", "invoke"],
  }));

  await postJson(`${brokerUrl}/v1/conversations`, {
    id: conversationId,
    kind: "channel",
    title: "OpenScout Mesh Invocation Smoke",
    visibility: "workspace",
    shareMode: "shared",
    authorityNodeId: peer.id,
    participantIds: [requesterId, targetAgentId],
    metadata: {
      surface: "mesh-iroh-smoke",
      peerNodeId: peer.id,
    },
  });

  const result = await postJson(`${brokerUrl}/v1/invocations`, {
    id: invocationId,
    requesterId,
    requesterNodeId: localNode.id,
    targetAgentId,
    targetNodeId: peer.id,
    action: "consult",
    task: options.task ?? `mesh invocation smoke from ${localNode.name} to ${peer.name} at ${new Date(now).toISOString()}`,
    conversationId,
    ensureAwake: true,
    stream: false,
    createdAt: now,
    metadata: {
      source: "mesh-iroh-smoke",
      peerNodeId: peer.id,
    },
  });

  console.log(`Sent invocation ${invocationId} from ${localNode.name} to authority ${peer.name}`);
  console.log(`Conversation: ${conversationId}`);
  console.log(`Target:       ${targetAgentId}`);
  console.log(`State:        ${result.state ?? "accepted"}`);
  console.log("");
  console.log("On the origin, inspect delivery status:");
  console.log(`  curl ${brokerUrl}/v1/invocations/${encodeURIComponent(invocationId)}`);
  console.log("");
  console.log("On the peer, run:");
  console.log(`  bun scripts/mesh-iroh-smoke.mjs check-invocation --invocation-id ${invocationId}`);
}

async function checkInvocation(options) {
  if (!options["invocation-id"]) {
    throw new Error("check-invocation requires --invocation-id ID");
  }
  const brokerUrl = brokerUrlFrom(options);
  const invocationId = options["invocation-id"];
  const snapshot = await getJson(`${brokerUrl}/v1/invocations/${encodeURIComponent(invocationId)}`);
  const invocation = snapshot.invocation;
  const flight = snapshot.flight;
  const deliveries = snapshot.deliveries ?? [];
  console.log(`Invocation: ${invocationId}`);
  console.log(`Target:     ${invocation?.targetAgentId ?? flight?.targetAgentId ?? "unknown"}`);
  console.log(`Flight:     ${flight?.state ?? "missing"}${flight?.id ? ` (${flight.id})` : ""}`);
  if (deliveries.length > 0) {
    console.log("Deliveries:");
    for (const delivery of deliveries) {
      console.log(`- ${delivery.id} ${delivery.transport} ${delivery.status}`);
    }
  }
  if (!invocation && !flight) {
    process.exitCode = 1;
  }
}

async function main() {
  if (!command || command === "--help" || command === "-h") {
    usage(0);
  }

  const { options, rest } = parseOptions(args);
  switch (command) {
    case "build-bridge":
      await buildBridge();
      break;
    case "run-broker":
      runBroker(rest);
      break;
    case "inspect":
      await inspect(options);
      break;
    case "export-node":
      await exportNode(options);
      break;
    case "import-node":
      await importNode(options);
      break;
    case "send-message":
      await sendMessage(options);
      break;
    case "check-message":
      await checkMessage(options);
      break;
    case "send-invocation":
      await sendInvocation(options);
      break;
    case "check-invocation":
      await checkInvocation(options);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      usage(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
