import type { RuntimeEnv } from "./portable-types.js";
import { readFileSync } from "node:fs";

import { resolveOpenScoutSupportPaths } from "./support-paths.js";

export const DEFAULT_OPENSCOUT_NETWORK_RENDEZVOUS_URL = "https://mesh.oscout.net";
export const DEFAULT_OPENSCOUT_NETWORK_PAIRING_RELAY_URL = "wss://mesh.oscout.net/v1/relay";

export type OpenScoutNetworkRuntimeSettings = {
  discoveryEnabled: boolean;
  rendezvousUrl: string;
  pairingRelayUrl: string;
  keepPairingRelayRunning: boolean;
};

export function defaultOpenScoutNetworkSettings(): OpenScoutNetworkRuntimeSettings {
  return {
    discoveryEnabled: false,
    rendezvousUrl: DEFAULT_OPENSCOUT_NETWORK_RENDEZVOUS_URL,
    pairingRelayUrl: DEFAULT_OPENSCOUT_NETWORK_PAIRING_RELAY_URL,
    keepPairingRelayRunning: true,
  };
}

export function normalizeOpenScoutNetworkSettings(input: unknown): OpenScoutNetworkRuntimeSettings {
  const base = defaultOpenScoutNetworkSettings();
  const record = isRecord(input) ? input : {};
  return {
    discoveryEnabled: typeof record.discoveryEnabled === "boolean"
      ? record.discoveryEnabled
      : base.discoveryEnabled,
    rendezvousUrl: normalizeUrlString(record.rendezvousUrl, base.rendezvousUrl),
    pairingRelayUrl: normalizeUrlString(record.pairingRelayUrl, base.pairingRelayUrl),
    keepPairingRelayRunning: typeof record.keepPairingRelayRunning === "boolean"
      ? record.keepPairingRelayRunning
      : base.keepPairingRelayRunning,
  };
}

export function readOpenScoutNetworkSettingsSync(): OpenScoutNetworkRuntimeSettings {
  try {
    const raw = readFileSync(resolveOpenScoutSupportPaths().settingsPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const network = isRecord(parsed) && isRecord(parsed.network) ? parsed.network : {};
    return normalizeOpenScoutNetworkSettings(isRecord(network.openScoutNetwork) ? network.openScoutNetwork : {});
  } catch {
    return defaultOpenScoutNetworkSettings();
  }
}

export function openScoutNetworkDiscoveryEnabled(env: RuntimeEnv = process.env): boolean {
  const explicit = readBooleanEnv(env.OPENSCOUT_NETWORK_DISCOVERY_ENABLED)
    ?? readBooleanEnv(env.OPENSCOUT_OSN_DISCOVERY_ENABLED);
  if (explicit !== undefined) {
    return explicit;
  }
  return readOpenScoutNetworkSettingsSync().discoveryEnabled;
}

export function openScoutNetworkServiceEnvironment(env: RuntimeEnv = process.env): RuntimeEnv {
  const settings = readOpenScoutNetworkSettingsSync();
  if (!settings.discoveryEnabled) {
    return {};
  }

  const next: RuntimeEnv = {};
  if (!hasEnv(env, "OPENSCOUT_MESH_RENDEZVOUS_URL")) {
    next.OPENSCOUT_MESH_RENDEZVOUS_URL = settings.rendezvousUrl;
  }
  if (
    !hasEnv(env, "OPENSCOUT_PAIRING_RELAY_URL")
    && !hasEnv(env, "OPENSCOUT_MOBILE_PAIRING_RELAY_URL")
  ) {
    next.OPENSCOUT_PAIRING_RELAY_URL = settings.pairingRelayUrl;
  }
  return next;
}

function normalizeUrlString(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim().replace(/\/$/, "");
  return trimmed || fallback;
}

function readBooleanEnv(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function hasEnv(env: RuntimeEnv, key: string): boolean {
  return typeof env[key] === "string" && env[key]!.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
