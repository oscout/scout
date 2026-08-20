import type { RuntimeEnv } from "./portable-types.js";
import {
  buildUnsignedMeshPresence,
  type MobilePairingMeshEntrypoint,
  type NodeDefinition,
  type NodeMeshEntrypoint,
  type OpenScoutMeshPresence,
} from "@openscout/protocol";

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { isLoopbackHost } from "./broker-process-manager.js";
import { readOpenScoutNetworkSettingsSync } from "./open-scout-network.js";

export interface MeshRendezvousPublishConfig {
  url: string;
  token?: string;
  sessionToken?: string;
  ttlMs: number;
  intervalMs: number;
}

export interface MeshRendezvousPublisher {
  publishNow(): Promise<void>;
  stop(): void;
}

export interface MeshRendezvousPublisherOptions {
  config: MeshRendezvousPublishConfig;
  fetch?: typeof fetch;
  logger?: Pick<Console, "log" | "warn">;
}

export type MeshRendezvousNodeSource = NodeDefinition | (() => NodeDefinition);

const DEFAULT_RENDEZVOUS_TTL_MS = 60_000;
const DEFAULT_RENDEZVOUS_INTERVAL_MS = 30_000;

export function resolveMeshRendezvousPublishConfig(
  env: RuntimeEnv = process.env,
  options: { includeSettings?: boolean } = {},
): MeshRendezvousPublishConfig | undefined {
  const explicitUrl = env.OPENSCOUT_MESH_RENDEZVOUS_URL?.trim();
  if (explicitUrl?.toLowerCase() === "false" || explicitUrl === "0") {
    return undefined;
  }
  const includeSettings = options.includeSettings ?? true;
  const settings = includeSettings ? readOpenScoutNetworkSettingsSync() : null;
  const rawUrl = explicitUrl || (settings?.discoveryEnabled ? settings.rendezvousUrl : "");
  if (!rawUrl) {
    return undefined;
  }

  const token = env.OPENSCOUT_MESH_RENDEZVOUS_TOKEN?.trim() || undefined;
  const sessionToken = env.OPENSCOUT_MESH_RENDEZVOUS_SESSION?.trim() || undefined;

  return {
    url: rawUrl.replace(/\/$/, ""),
    token,
    sessionToken: sessionToken || undefined,
    ttlMs: readPositiveInteger(env.OPENSCOUT_MESH_RENDEZVOUS_TTL_MS, DEFAULT_RENDEZVOUS_TTL_MS),
    intervalMs: readPositiveInteger(env.OPENSCOUT_MESH_RENDEZVOUS_INTERVAL_MS, DEFAULT_RENDEZVOUS_INTERVAL_MS),
  };
}

export function buildMeshRendezvousPresence(
  node: NodeDefinition,
  options: { issuedAt?: number; ttlMs?: number } = {},
): OpenScoutMeshPresence | undefined {
  const entrypoints = reachableEntrypointsForNode(node);
  if (entrypoints.length === 0) {
    return undefined;
  }

  return buildUnsignedMeshPresence({
    node,
    entrypoints,
    issuedAt: options.issuedAt,
    ttlMs: options.ttlMs,
    metadata: {
      source: "openscout-runtime",
    },
  });
}

export async function publishMeshRendezvousPresence(
  node: NodeDefinition,
  options: MeshRendezvousPublisherOptions,
): Promise<boolean> {
  const presence = buildMeshRendezvousPresence(node, { ttlMs: options.config.ttlMs });
  if (!presence) {
    options.logger?.warn("[openscout-runtime] mesh rendezvous skipped: no reachable entrypoints to publish");
    return false;
  }

  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(`${options.config.url}/v1/presence`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...rendezvousAuthHeaders(options.config),
    },
    body: JSON.stringify(presence),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`rendezvous publish failed: ${response.status} ${response.statusText}${detail ? ` ${detail}` : ""}`);
  }

  return true;
}

export function startMeshRendezvousPublisher(
  node: MeshRendezvousNodeSource,
  options: MeshRendezvousPublisherOptions,
): MeshRendezvousPublisher {
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const publishNow = async () => {
    if (stopped) return;
    if (inFlight) {
      await inFlight;
      return;
    }
    inFlight = publishMeshRendezvousPresence(resolveNodeSource(node), options)
      .then((published) => {
        if (published) {
          options.logger?.log(`[openscout-runtime] published mesh rendezvous presence to ${options.config.url}`);
        }
      })
      .catch((error) => {
        options.logger?.warn(`[openscout-runtime] mesh rendezvous publish failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        inFlight = null;
      });
    await inFlight;
  };

  const timer = setInterval(() => {
    publishNow().catch(() => undefined);
  }, options.config.intervalMs);
  timer.unref();
  publishNow().catch(() => undefined);

  return {
    publishNow,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export function readMobilePairingMeshEntrypoint(
  env: RuntimeEnv = process.env,
  now: number = Date.now(),
): MobilePairingMeshEntrypoint | undefined {
  const runtimeStatePath = env.OPENSCOUT_PAIRING_RUNTIME_STATE_PATH
    ?? join(env.HOME ?? homedir(), ".scout", "pairing", "runtime.json");
  if (!existsSync(runtimeStatePath)) {
    return undefined;
  }

  try {
    return mobilePairingMeshEntrypointFromSnapshot(
      JSON.parse(readFileSync(runtimeStatePath, "utf8")),
      now,
    );
  } catch {
    return undefined;
  }
}

export function mobilePairingMeshEntrypointFromSnapshot(
  input: unknown,
  now: number = Date.now(),
): MobilePairingMeshEntrypoint | undefined {
  if (!isRecord(input)) return undefined;
  const pairing = isRecord(input["pairing"]) ? input["pairing"] : undefined;
  if (!pairing) return undefined;

  const relay = readString(pairing["relay"]);
  const room = readString(pairing["room"]);
  const publicKey = readString(pairing["publicKey"]);
  const expiresAt = readNumber(pairing["expiresAt"]);
  if (!relay || !room || !isPublicKeyHex(publicKey) || !expiresAt || expiresAt <= now) {
    return undefined;
  }

  const fallbackRelays = readFallbackRelays(pairing);
  const lastSeenAt = readNumber(input["updatedAt"]);
  return {
    kind: "mobile_pairing",
    relay,
    ...(fallbackRelays.length > 0 ? { fallbackRelays } : {}),
    room,
    publicKey,
    expiresAt,
    ...(lastSeenAt ? { lastSeenAt } : {}),
    metadata: {
      source: "openscout-pairing-runtime",
    },
  };
}

function reachableEntrypointsForNode(node: NodeDefinition): NodeMeshEntrypoint[] {
  const entrypoints = [...(node.meshEntrypoints ?? [])];
  if (node.brokerUrl && isReachableHttpUrl(node.brokerUrl)) {
    entrypoints.push({
      kind: "http",
      url: node.brokerUrl,
      lastSeenAt: node.lastSeenAt,
    });
  }
  return entrypoints;
}

function resolveNodeSource(source: MeshRendezvousNodeSource): NodeDefinition {
  return typeof source === "function" ? source() : source;
}

function rendezvousAuthHeaders(config: MeshRendezvousPublishConfig): { authorization?: string } {
  if (config.sessionToken) {
    return { authorization: osnSessionAuthHeader(config.sessionToken) };
  }
  if (config.token) {
    return { authorization: `Bearer ${config.token}` };
  }
  return {};
}

function osnSessionAuthHeader(sessionToken: string): string {
  return sessionToken.startsWith("osn_session_")
    ? `Bearer ${sessionToken}`
    : `Bearer osn_session_${sessionToken}`;
}

function isReachableHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readFallbackRelays(pairing: Record<string, unknown>): string[] {
  const direct = readStringArray(pairing["fallbackRelays"]);
  if (direct.length > 0) {
    return direct;
  }

  const qrValue = readString(pairing["qrValue"]);
  if (!qrValue) {
    return [];
  }

  try {
    const parsed = JSON.parse(qrValue);
    return isRecord(parsed) ? readStringArray(parsed["fallbackRelays"]) : [];
  } catch {
    return [];
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(readString).filter((entry): entry is string => Boolean(entry))
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPublicKeyHex(value: string | undefined): value is string {
  return Boolean(value && /^[0-9a-fA-F]{64}$/.test(value));
}
