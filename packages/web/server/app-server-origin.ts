import { hostname as osHostname, networkInterfaces as osNetworkInterfaces } from "node:os";

import {
  DEFAULT_SCOUT_WEB_PORTAL_HOST,
  loadLocalConfig,
  resolveConfiguredScoutWebHostname,
  resolveScoutWebDevHostname,
  resolveScoutWebMdnsHostname,
  resolveScoutWebNamedHostname,
  type LocalConfig,
} from "@openscout/runtime/local-config";
import { readTailscaleSelfWebHostsSync } from "@openscout/runtime/mesh/tailscale";

export type OpenScoutWebApplicationServerIdentity = {
  advertisedHost: string;
  portalHost: string;
  publicOrigin?: string;
  trustedHosts: string[];
  trustedOrigins: string[];
  /**
   * Authenticating reverse-proxy origins (exe.dev private shares, the OSN mesh
   * front door) that vouch for the browser; see
   * shouldIssueFrontDoorScoutWebCredential.
   */
  frontDoorOrigins: string[];
  /** Extra proxy peer addresses allowed for front-door issuance (loopback always is). */
  frontDoorPeers: string[];
};

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function hostFromOrigin(value: string | undefined): string | null {
  if (!value?.trim()) {
    return null;
  }
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

function normalizeFrontDoorOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const withScheme = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme).origin.toLowerCase();
  } catch {
    return null;
  }
}

function uniq(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = value?.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/**
 * This machine's own non-loopback IPv4/IPv6 addresses, so a browser that reaches
 * Scout by bare LAN address (http://192.168.1.20) passes the Host trust gate the
 * same way the tailnet addresses already do. Opt out with
 * OPENSCOUT_WEB_TRUST_LAN_ADDRESSES=0 — this only makes the address a *trusted
 * name*; reaching the port at all is still governed by the LAN access scope and
 * every /api route still requires a credential.
 */
export function localReachableWebHosts(): string[] {
  return Object.values(osNetworkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => !entry.internal)
    .map((entry) => entry.address)
    // Drop IPv6 link-local (fe80::…%en0): the zone id never appears in a URL host.
    .filter((address) => !address.toLowerCase().startsWith("fe80:"));
}

export function resolveOpenScoutWebApplicationServerIdentity(
  env: NodeJS.ProcessEnv = process.env,
  _machineHostname = osHostname(),
  config: Pick<LocalConfig, "webLocalName"> = loadLocalConfig(),
  _localAddresses: readonly string[] = localReachableWebHosts(),
): OpenScoutWebApplicationServerIdentity {
  const configuredName = env.OPENSCOUT_WEB_LOCAL_NAME?.trim();
  const portalHost = resolveScoutWebNamedHostname(env.OPENSCOUT_WEB_PORTAL_HOST?.trim() || DEFAULT_SCOUT_WEB_PORTAL_HOST);
  const advertisedHost =
    env.OPENSCOUT_WEB_ADVERTISED_HOST?.trim()
    || (configuredName ? resolveScoutWebNamedHostname(configuredName) : undefined)
    || resolveConfiguredScoutWebHostname(config, _machineHostname);
  const publicOrigin = env.OPENSCOUT_WEB_PUBLIC_ORIGIN?.trim() || undefined;
  const publicOriginHost = hostFromOrigin(publicOrigin);
  const tailnetHosts = readTailscaleSelfWebHostsSync(env);
  const mdnsHost = resolveScoutWebMdnsHostname(_machineHostname);
  const frontDoorOrigins = uniq(
    splitList(env.OPENSCOUT_WEB_FRONT_DOORS).map(normalizeFrontDoorOrigin),
  );
  const lanHosts = env.OPENSCOUT_WEB_TRUST_LAN_ADDRESSES?.trim() === "0"
    ? []
    : _localAddresses;

  return {
    advertisedHost,
    portalHost,
    publicOrigin,
    trustedHosts: uniq([
      advertisedHost,
      portalHost,
      resolveScoutWebDevHostname(portalHost),
      mdnsHost,
      publicOriginHost,
      ...tailnetHosts,
      ...lanHosts,
      ...frontDoorOrigins.map(hostFromOrigin),
      ...splitList(env.OPENSCOUT_WEB_TRUSTED_HOSTS),
    ]),
    trustedOrigins: uniq([
      publicOrigin,
      ...frontDoorOrigins,
      ...splitList(env.OPENSCOUT_WEB_TRUSTED_ORIGINS),
    ]),
    frontDoorOrigins,
    frontDoorPeers: uniq(splitList(env.OPENSCOUT_WEB_FRONT_DOOR_PEERS)),
  };
}
