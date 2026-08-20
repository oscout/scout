import { homedir } from "node:os";

import {
  createAcpAdapter as createAcp,
  createClaudeCodeAdapter as createClaudeCode,
  createCodexAdapter as createCodex,
  createGrokAcpAdapter as createGrokAcp,
  createKimiAcpAdapter as createKimiAcp,
  createOpenAiCompatAdapter as createOpenAI,
  createOpencodeAdapter as createOpenCode,
  createOpencodeAcpAdapter as createOpenCodeAcp,
  createOpencodeV2Adapter as createOpenCodeV2,
  createPiAdapter as createPi,
  type AdapterFactory,
} from "@openscout/agent-sessions";
import { Bridge } from "./bridge/bridge";
import { type AdapterEntry, resolveConfig, type SessionEntry } from "./bridge/config";
import { startFileServer, type FileServer } from "./bridge/fileserver";
import { connectToRelay, type RelayConnection, type RelayEventHandlers } from "./bridge/relay-client";
import { startBridgeServerTRPC as startBridgeServer } from "./bridge/server-trpc";
import { createQRPayload, loadOrCreateIdentity, type KeyPair, type QRPayload } from "./security";

export type PairingRuntimeEvents = RelayEventHandlers;

export type PairingRuntimeRelayEndpoint = {
  relayUrl: string;
  advertisedRelayUrl?: string | null;
  fallbackRelayUrls?: string[];
};

export type StartedPairingRuntime = {
  bridge: Bridge;
  fileServer: FileServer;
  identity: KeyPair;
  config: ReturnType<typeof resolveConfig>;
  relayConnection: RelayConnection | null;
  relayConnections: RelayConnection[];
  qrPayload: QRPayload | null;
  stop: () => Promise<void>;
};

export function createPairingAdapterRegistry(configAdapters?: Record<string, AdapterEntry>) {
  const adapters: Record<string, AdapterFactory> = {
    "claude-code": createClaudeCode,
    acp: createAcp,
    codex: createCodex,
    "grok-acp": createGrokAcp,
    "kimi-acp": createKimiAcp,
    pi: createPi,
    opencode: createOpenCode,
    "opencode-acp": createOpenCodeAcp,
    "opencode-v2": createOpenCodeV2,
    openai: createOpenAI,
  };

  if (configAdapters) {
    for (const [name, entry] of Object.entries(configAdapters)) {
      const baseFactory = adapters[entry.type];
      if (!baseFactory) {
        console.warn(`[pairing] config adapter "${name}" references unknown type "${entry.type}" — skipped`);
        continue;
      }

      adapters[name] = (adapterConfig) => {
        const merged = {
          ...adapterConfig,
          options: { ...entry.options, ...adapterConfig.options },
        };
        return baseFactory(merged);
      };
    }
  }

  return adapters;
}

export async function startPairingRuntime(options?: {
  relayUrl?: string | null;
  advertisedRelayUrl?: string | null;
  fallbackRelayUrls?: string[];
  relayEndpoints?: PairingRuntimeRelayEndpoint[];
  relayEvents?: PairingRuntimeEvents;
}) : Promise<StartedPairingRuntime> {
  const config = resolveConfig();
  const identity = loadOrCreateIdentity();
  const adapters = createPairingAdapterRegistry(config.adapters);
  const bridge = new Bridge({
    port: config.port,
    adapters,
  });

  const server = startBridgeServer({
    bridge,
    port: config.port,
    secure: config.secure,
    identity: config.secure ? identity : undefined,
  });
  const fileServer = startFileServer({ port: config.port + 2, bridge });

  const relayEndpoints = resolveRelayEndpoints(config, options);
  const advertisedRelayUrls = dedupeRelayUrls(relayEndpoints.flatMap((endpoint) => [
    advertisedRelayUrl(endpoint),
    ...(endpoint.fallbackRelayUrls ?? []),
  ]));
  const primaryRelayUrl = advertisedRelayUrls[0] ?? null;
  if (!primaryRelayUrl) {
    fileServer.stop();
    server.stop();
    throw new Error("Pairing relay URL is not configured.");
  }

  const qrPayload = createQRPayload(identity.publicKey, primaryRelayUrl, advertisedRelayUrls.slice(1));
  let relayConnections: RelayConnection[] = [];
  try {
    relayConnections = relayEndpoints.map((endpoint) =>
      connectToRelay(endpoint.relayUrl.trim(), identity, bridge, {
        secure: true,
        publicRelayUrl: advertisedRelayUrl(endpoint),
        qrPayload,
        events: options?.relayEvents,
      })
    );
  } catch (error) {
    for (const relayConnection of relayConnections) {
      relayConnection.disconnect();
    }
    fileServer.stop();
    server.stop();
    throw error;
  }

  await autoStartConfiguredSessions(bridge, config.sessions);

  return {
    bridge,
    fileServer,
    identity,
    config,
    relayConnection: relayConnections[0] ?? null,
    relayConnections,
    qrPayload,
    async stop() {
      for (const relayConnection of relayConnections) {
        relayConnection.disconnect();
      }
      fileServer.stop();
      await bridge.shutdown();
      server.stop();
    },
  };
}

function resolveRelayEndpoints(
  config: ReturnType<typeof resolveConfig>,
  options: {
    relayUrl?: string | null;
    advertisedRelayUrl?: string | null;
    fallbackRelayUrls?: string[];
    relayEndpoints?: PairingRuntimeRelayEndpoint[];
  } | undefined,
): PairingRuntimeRelayEndpoint[] {
  const explicit = options?.relayEndpoints
    ?.map((endpoint) => ({
      relayUrl: endpoint.relayUrl.trim(),
      advertisedRelayUrl: endpoint.advertisedRelayUrl?.trim() || endpoint.relayUrl.trim(),
      fallbackRelayUrls: endpoint.fallbackRelayUrls,
    }))
    .filter((endpoint) => endpoint.relayUrl.length > 0) ?? [];
  if (explicit.length > 0) {
    return dedupeRelayEndpoints(explicit);
  }

  const relayUrl = options?.relayUrl?.trim() || config.relay || null;
  if (!relayUrl) {
    return [];
  }
  return [{
    relayUrl,
    advertisedRelayUrl: options?.advertisedRelayUrl?.trim() || relayUrl,
    fallbackRelayUrls: options?.fallbackRelayUrls,
  }];
}

function advertisedRelayUrl(endpoint: PairingRuntimeRelayEndpoint): string {
  return endpoint.advertisedRelayUrl?.trim() || endpoint.relayUrl.trim();
}

function dedupeRelayEndpoints(endpoints: PairingRuntimeRelayEndpoint[]): PairingRuntimeRelayEndpoint[] {
  const seen = new Set<string>();
  const out: PairingRuntimeRelayEndpoint[] = [];
  for (const endpoint of endpoints) {
    const relayUrl = endpoint.relayUrl.trim();
    if (!relayUrl || seen.has(relayUrl)) {
      continue;
    }
    seen.add(relayUrl);
    out.push({
      relayUrl,
      advertisedRelayUrl: advertisedRelayUrl(endpoint),
      fallbackRelayUrls: dedupeRelayUrls(endpoint.fallbackRelayUrls ?? []),
    });
  }
  return out;
}

function dedupeRelayUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    const trimmed = url.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

async function autoStartConfiguredSessions(bridge: Bridge, sessions: SessionEntry[] | undefined) {
  if (!sessions?.length) {
    return;
  }

  console.log(`[bridge] auto-starting ${sessions.length} session(s)...`);
  for (const entry of sessions) {
    try {
      const session = await bridge.createSession(entry.adapter, {
        name: entry.name,
        cwd: entry.cwd?.replace(/^~/, homedir()),
        options: entry.options,
      });
      console.log(`[bridge] session started: ${session.name} (${entry.adapter})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[bridge] failed to start session "${entry.name}": ${message}`);
    }
  }
}
