/**
 * Mesh dial preference: LAN before Tailscale.
 *
 * Cards and bind lists advertise both paths. Same-house peers should hit the
 * RFC1918 / .local address first; Tailscale CGNAT and MagicDNS are the
 * fallback when LAN is unreachable.
 */

import type { NodeDefinition } from "@openscout/protocol";

export type MeshDialRank = 0 | 1 | 2;

const TAILSCALE_MAGIC_DNS = /\.(ts\.net|tailscale\.net)$/i;

export function meshDialRank(url: string): MeshDialRank {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return 2;
  }

  if (isTailscaleIPv4(hostname) || TAILSCALE_MAGIC_DNS.test(hostname)) {
    return 1;
  }
  if (isPrivateLanIPv4(hostname) || hostname.endsWith(".local")) {
    return 0;
  }
  return 2;
}

export function orderMeshDialUrls(urls: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const url of urls) {
    const trimmed = url.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique
    .map((url, index) => ({ url, index, rank: meshDialRank(url) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.url);
}

export function httpMeshUrlsForNode(node: Pick<NodeDefinition, "brokerUrl" | "meshEntrypoints">): string[] {
  const urls: string[] = [];
  if (node.brokerUrl) urls.push(node.brokerUrl);
  for (const entrypoint of node.meshEntrypoints ?? []) {
    if (entrypoint.kind === "http" && entrypoint.url) {
      urls.push(entrypoint.url);
    }
  }
  return orderMeshDialUrls(urls);
}

function isPrivateLanIPv4(address: string): boolean {
  const octets = parseIPv4(address);
  if (!octets) return false;
  const [first, second] = octets;
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

function isTailscaleIPv4(address: string): boolean {
  const octets = parseIPv4(address);
  return Boolean(octets && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127);
}

function parseIPv4(address: string): [number, number, number, number] | null {
  const octets = address.split(".");
  if (octets.length !== 4) return null;
  const numbers = octets.map((octet) => Number(octet));
  if (numbers.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  return numbers as [number, number, number, number];
}
