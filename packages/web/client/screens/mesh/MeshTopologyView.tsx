import { lazy, Suspense, useMemo } from "react";
import type { MeshStatus } from "../../lib/types.ts";

const ArcDiagram = lazy(() =>
  import("@arach/arc").then((m) => ({ default: m.ArcDiagram })),
);

type ArcData = {
  layout: { width: number; height: number };
  nodes: Record<string, { x: number; y: number; size: "s" | "m" | "l" }>;
  nodeData: Record<string, {
    icon: string;
    name: string;
    subtitle?: string;
    color: "violet" | "emerald" | "blue" | "amber" | "sky" | "zinc" | "rose" | "orange";
  }>;
  connectors: Array<{
    from: string;
    to: string;
    fromAnchor: "top" | "bottom" | "left" | "right";
    toAnchor: "top" | "bottom" | "left" | "right";
    style: string;
  }>;
  connectorStyles: Record<string, {
    color: string;
    strokeWidth: number;
    dashed?: boolean;
    label?: string;
  }>;
};

function shortHost(input?: string | null): string {
  if (!input) return "";
  const host = input.replace(/^https?:\/\//, "").split("/")[0];
  const [name] = host.split(":");
  return name.split(".")[0];
}

function peerDisplayName(peer: MeshStatus["tailscale"]["peers"][number]): string {
  const hostName = peer.hostName?.trim();
  if (hostName && hostName.toLowerCase() !== "localhost") {
    return shortHost(hostName) || hostName;
  }

  const dnsName = peer.dnsName?.trim().replace(/\.$/, "");
  if (dnsName) {
    return shortHost(dnsName) || dnsName;
  }

  return shortHost(peer.name) || peer.name;
}

function fullHost(input?: string | null): string {
  if (!input) return "";
  const host = input.replace(/^https?:\/\//, "").split("/")[0];
  const [name] = host.split(":");
  return name.replace(/\.$/, "").toLowerCase();
}

function baseHost(input?: string | null): string {
  const host = fullHost(input);
  if (!host) return "";
  return host.split(".")[0] ?? host;
}

function subtitleFor(node: {
  hostName?: string;
  brokerUrl?: string;
  id: string;
}): string {
  if (node.brokerUrl) return shortHost(node.brokerUrl);
  if (node.hostName) return shortHost(node.hostName);
  return node.id.slice(0, 10);
}

function anchorsFor(dx: number, dy: number): [
  ArcData["connectors"][number]["fromAnchor"],
  ArcData["connectors"][number]["toAnchor"],
] {
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? ["right", "left"] : ["left", "right"];
  }
  return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
}

function isLocalTailnetPeer(mesh: MeshStatus, peer: MeshStatus["tailscale"]["peers"][number]): boolean {
  const peerBase = baseHost(peer.hostName || peer.name);
  const localBase = baseHost(mesh.localNode?.hostName || mesh.localNode?.name);
  return Boolean(localBase) && peerBase === localBase;
}

function peerMatchesMeshNode(
  peer: MeshStatus["tailscale"]["peers"][number],
  node: NonNullable<MeshStatus["localNode"]> | MeshStatus["nodes"][string],
): boolean {
  const peerAliases = new Set(
    [
      baseHost(peer.hostName),
      baseHost(peer.name),
      ...peer.addresses.map((address) => fullHost(address)),
      ...peer.addresses.map((address) => baseHost(address)),
    ].filter(Boolean),
  );

  const nodeAliases = new Set(
    [
      baseHost(node.hostName),
      baseHost(node.name),
      fullHost(node.brokerUrl),
      baseHost(node.brokerUrl),
    ].filter(Boolean),
  );

  for (const alias of peerAliases) {
    if (nodeAliases.has(alias)) {
      return true;
    }
  }

  return false;
}

function buildMeshDiagram(mesh: MeshStatus): ArcData | null {
  if (!mesh.localNode) return null;

  const localId = mesh.localNode.id;
  const remoteMeshPeers = Object.values(mesh.nodes).filter((n) => n.id !== localId);
  const tailnetPeers = mesh.tailscale.peers
    .filter((peer) => !isLocalTailnetPeer(mesh, peer))
    .filter((peer) => !remoteMeshPeers.some((node) => peerMatchesMeshNode(peer, node)));
  const renderedPeers = [
    ...remoteMeshPeers.map((peer) => ({ kind: "mesh" as const, peer })),
    ...tailnetPeers.map((peer) => ({ kind: "tailnet" as const, peer })),
  ];

  const width = 800;
  const height = 300;
  const cx = width / 2;
  const cy = height / 2;

  const nodes: ArcData["nodes"] = {
    [localId]: { x: cx, y: cy, size: "m" },
  };
  const nodeData: ArcData["nodeData"] = {
    [localId]: {
      icon: "Database",
      name: shortHost(mesh.localNode.hostName) || mesh.localNode.name || "broker",
      subtitle: "this node",
      color: "violet",
    },
  };
  const connectors: ArcData["connectors"] = [];

  if (renderedPeers.length === 0) {
    nodes["__placeholder"] = { x: cx + 220, y: cy, size: "m" };
    nodeData["__placeholder"] = {
      icon: "CircleDashed",
      name: "No peers yet",
      subtitle: "awaiting discovery",
      color: "zinc",
    };
    connectors.push({
      from: localId,
      to: "__placeholder",
      fromAnchor: "right",
      toAnchor: "left",
      style: "pending",
    });
  } else {
    const count = renderedPeers.length;
    const radius = Math.min(170, 100 + count * 10);
    renderedPeers.forEach(({ kind, peer }, i) => {
      const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
      const x = Math.round(cx + radius * Math.cos(angle));
      const y = Math.round(cy + radius * Math.sin(angle));
      const peerId = kind === "mesh" ? peer.id : `tailnet:${peer.id}`;
      const peerName = kind === "mesh"
        ? (shortHost(peer.hostName) || peer.name || "peer")
        : (peerDisplayName(peer) || "tailnet");
      const peerSubtitle = kind === "mesh"
        ? subtitleFor(peer)
        : (peer.online
          ? (peer.addresses[0] ?? "tailnet only")
          : "tailnet offline");

      nodes[peerId] = { x, y, size: kind === "mesh" ? "m" : "s" };
      nodeData[peerId] = {
        icon: kind === "mesh" ? "Database" : "CircleDashed",
        name: peerName,
        subtitle: peerSubtitle,
        color: kind === "mesh"
          ? (peer.advertiseScope === "mesh" ? "emerald" : "zinc")
          : (peer.online ? "sky" : "zinc"),
      };
      const [fromAnchor, toAnchor] = anchorsFor(x - cx, y - cy);
      connectors.push({
        from: localId,
        to: peerId,
        fromAnchor,
        toAnchor,
        style: kind === "mesh"
          ? (peer.advertiseScope === "mesh" ? "mesh" : "local")
          : (peer.online ? "tailnet" : "tailnet-offline"),
      });
    });
  }

  return {
    layout: { width, height },
    nodes,
    nodeData,
    connectors,
    connectorStyles: {
      mesh: { color: "emerald", strokeWidth: 2, label: "mesh" },
      local: { color: "zinc", strokeWidth: 1.5 },
      tailnet: { color: "sky", strokeWidth: 1.5, dashed: true, label: "tailnet" },
      "tailnet-offline": { color: "zinc", strokeWidth: 1.25, dashed: true, label: "tailnet" },
      pending: { color: "zinc", strokeWidth: 1.5, dashed: true },
    },
  };
}

export function MeshTopologyView({ mesh }: { mesh: MeshStatus }) {
  const data = useMemo(() => buildMeshDiagram(mesh), [mesh]);
  if (!data) return null;

  return (
    <div className="s-mesh-topology">
      <Suspense fallback={<div className="s-mesh-topology-fallback" />}>
        <ArcDiagram
          data={data as never}
          className="s-mesh-topology-canvas"
          mode="light"
          theme="cool"
          interactive
          showArcToggle={false}
          defaultZoom="fit"
          maxFitZoom={0.95}
          hoverEffects={{ dim: true, lift: true, glow: true, highlightEdges: true }}
        />
      </Suspense>
    </div>
  );
}
