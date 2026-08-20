import type { AdvertiseScope, MetadataMap, ScoutId } from "./common.js";

export const OPENSCOUT_MESH_PROTOCOL_VERSION = 1;
export const OPENSCOUT_IROH_MESH_ALPN = "openscout/mesh/0";
export const DEFAULT_OPENSCOUT_MESH_RENDEZVOUS_URL = "https://mesh.oscout.net";
export const DEFAULT_OPENSCOUT_MOBILE_PAIRING_RELAY_URL = "wss://mesh.oscout.net/v1/relay";

export type NodeMeshEntrypoint =
  | IrohMeshEntrypoint
  | CloudflareTunnelMeshEntrypoint
  | HttpMeshEntrypoint
  | MobilePairingMeshEntrypoint;

export interface IrohMeshEntrypoint {
  kind: "iroh";
  endpointId: string;
  endpointAddr: unknown;
  alpn: typeof OPENSCOUT_IROH_MESH_ALPN;
  bridgeProtocolVersion: typeof OPENSCOUT_MESH_PROTOCOL_VERSION;
  lastSeenAt?: number;
  expiresAt?: number;
  metadata?: MetadataMap;
}

export interface CloudflareTunnelMeshEntrypoint {
  kind: "cloudflare_tunnel";
  url: string;
  lastSeenAt?: number;
  expiresAt?: number;
  metadata?: MetadataMap;
}

export interface HttpMeshEntrypoint {
  kind: "http";
  url: string;
  lastSeenAt?: number;
  expiresAt?: number;
  metadata?: MetadataMap;
}

export interface MobilePairingMeshEntrypoint {
  kind: "mobile_pairing";
  relay: string;
  fallbackRelays?: string[];
  room: string;
  publicKey: string;
  expiresAt: number;
  lastSeenAt?: number;
  metadata?: MetadataMap;
}

export type TrustedPeerTier = "observe" | "control";

export type TrustedPeerGrantChannel = "sas" | "github" | "ssh";

// A peer this node has enrolled into its trust cone (see
// docs/proposals/mesh-trust-cone.md §6). All enrollment channels produce the
// same artifact; revocation is soft via `revokedAt`.
export interface TrustedPeerRecord {
  /** Canonical machine identity: full SHA-256 hex of the DER public key. */
  keyId: string;
  /** Base64 DER spki Ed25519 public key. */
  publicKey: string;
  /** Short `osc1:xxxx-xxxx` form — display-only, never an identity key. */
  fingerprint: string;
  /** Remote node's runtime id, when known. */
  nodeId?: ScoutId;
  label: string;
  tier: TrustedPeerTier;
  grantedVia: TrustedPeerGrantChannel;
  grantedAt: number;
  expiresAt?: number;
  revokedAt?: number;
  lastSeenAt?: number;
  /**
   * §11.2 durable TLS pin: SHA-256 hex of the peer TLS certificate's
   * SubjectPublicKeyInfo DER, copied from the peer's verified signed card at
   * enrollment. Absent for Tailscale-path peers and pre-P1.5 enrollments.
   */
  tlsSpkiFingerprint?: string;
  metadata?: MetadataMap;
}

export interface NodeDefinition {
  id: ScoutId;
  meshId: ScoutId;
  name: string;
  hostName?: string;
  advertiseScope: AdvertiseScope;
  brokerUrl?: string;
  webUrl?: string;
  meshEntrypoints?: NodeMeshEntrypoint[];
  tailnetName?: string;
  capabilities?: string[];
  labels?: string[];
  metadata?: MetadataMap;
  lastSeenAt?: number;
  registeredAt: number;
}

export interface OpenScoutMeshPresence {
  v: typeof OPENSCOUT_MESH_PROTOCOL_VERSION;
  meshId: ScoutId;
  nodeId: ScoutId;
  nodeName: string;
  issuedAt: number;
  expiresAt: number;
  entrypoints: NodeMeshEntrypoint[];
  signature?: {
    algorithm: "ed25519";
    keyId: string;
    value: string;
  };
  metadata?: MetadataMap;
}

export interface OpenScoutMeshPresenceRecord extends OpenScoutMeshPresence {
  observedAt: number;
}

export interface OpenScoutMeshRendezvousList {
  v: typeof OPENSCOUT_MESH_PROTOCOL_VERSION;
  meshId: ScoutId;
  nodes: OpenScoutMeshPresenceRecord[];
}

export function buildUnsignedMeshPresence(input: {
  node: Pick<NodeDefinition, "id" | "meshId" | "name">;
  entrypoints: NodeMeshEntrypoint[];
  issuedAt?: number;
  ttlMs?: number;
  metadata?: MetadataMap;
}): OpenScoutMeshPresence {
  const issuedAt = input.issuedAt ?? Date.now();
  const ttlMs = input.ttlMs ?? 60_000;
  return {
    v: OPENSCOUT_MESH_PROTOCOL_VERSION,
    meshId: input.node.meshId,
    nodeId: input.node.id,
    nodeName: input.node.name,
    issuedAt,
    expiresAt: issuedAt + ttlMs,
    entrypoints: input.entrypoints,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}
