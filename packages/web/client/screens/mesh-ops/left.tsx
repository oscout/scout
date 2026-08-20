import { useEffect, useState } from "react";
import { api } from "../../lib/api.ts";
import {
  clearRouteMachineScope,
  routeMachineId,
  setRouteMachineScope,
} from "../../lib/router.ts";
import {
  itemIsNewSince,
  readMeshOpsLastLookAt,
  useMeshOpsViewStore,
  setMeshOpsUnattributedOnly,
} from "../../lib/mesh-ops-view-store.ts";
import { setMeshSnapshot, useMeshViewStore } from "../../lib/mesh-view-store.ts";
import { useScout } from "../../scout/Provider.tsx";
import { RailRow } from "../../scout/slots/RailRow.tsx";
import { useMeshOpsItems } from "./use-mesh-ops-items.ts";
import type { MeshStatus } from "../../lib/types.ts";
import "../../scout/slots/ctx-panel.css";
import "./mesh-ops.css";

type MeshNode = NonNullable<MeshStatus["localNode"]>;

function hostLabel(node: MeshNode): string {
  return node.hostName?.split(".")[0] ?? node.name ?? node.id.slice(0, 12);
}

/**
 * Mesh Ops host rail — the mesh read as attention counts, not a map.
 * "everywhere" clears the machine scope; a host row scopes the list to that
 * machine; "unattributed" narrows to items with no venue host.
 */
export function MeshOpsLeft() {
  const { route, navigate } = useScout();
  const machineId = routeMachineId(route);
  const { items, unattributedOnly, lab, refreshToken } = useMeshOpsViewStore();
  const { meshSnapshot } = useMeshViewStore();
  useMeshOpsItems(machineId);
  // New-since-last-look is the rail's one signal — agnostic by construction.
  const [lastLookAt] = useState(() => readMeshOpsLastLookAt());

  useEffect(() => {
    let cancelled = false;
    void api<MeshStatus>("/api/mesh")
      .then((data) => { if (!cancelled) setMeshSnapshot(data); })
      .catch(() => { /* host rail degrades to item counts only */ });
    return () => { cancelled = true; };
  }, [refreshToken]);

  const scopeTo = (id: string | null) => {
    setMeshOpsUnattributedOnly(false);
    navigate(id ? setRouteMachineScope(route, id) : clearRouteMachineScope(route));
  };

  const showUnattributed = () => {
    navigate(clearRouteMachineScope(route));
    setMeshOpsUnattributedOnly(true);
  };

  const localNode = meshSnapshot?.localNode ?? null;
  const peers = meshSnapshot
    ? Object.values(meshSnapshot.nodes).filter((n) => n.id !== localNode?.id)
    : [];

  const newCount = (list: typeof items) =>
    lab.lastLook ? list.filter((it) => itemIsNewSince(it, lastLookAt)).length : 0;
  const unattributed = items.filter((it) => it.hostNodeId === null);

  const hostRow = (node: MeshNode) => {
    const here = items.filter((it) => it.hostNodeId === node.id);
    const fresh = newCount(here);
    const active = machineId === node.id;
    return (
      <RailRow
        key={node.id}
        name={hostLabel(node)}
        meta={here.length > 0 ? `${fresh > 0 ? `${fresh}·` : ""}${here.length}` : "—"}
        tone={fresh > 0 ? "needs_attention" : "neutral"}
        active={active}
        unread={fresh > 0}
        onClick={() => scopeTo(active ? null : node.id)}
        title={`Scope the list to ${hostLabel(node)}`}
      />
    );
  };

  return (
    <div className="ctx-panel mesh-ops-rail">
      <div className="ctx-panel-section">
        <div className="ctx-panel-section-label">Mesh</div>
        <RailRow
          name="everywhere"
          meta={`${newCount(items) > 0 ? `${newCount(items)}·` : ""}${items.length}`}
          tone={newCount(items) > 0 ? "needs_attention" : "neutral"}
          active={machineId === null && !unattributedOnly}
          onClick={() => scopeTo(null)}
          title="Show items across all hosts"
        />
      </div>

      {localNode && (
        <div className="ctx-panel-section">
          <div className="ctx-panel-section-label">This host</div>
          {hostRow(localNode)}
        </div>
      )}

      {peers.length > 0 && (
        <div className="ctx-panel-section">
          <div className="ctx-panel-section-label">Peers</div>
          {peers.map((node) => hostRow(node))}
        </div>
      )}

      <div className="ctx-panel-section">
        <div className="ctx-panel-section-label">No venue</div>
        <RailRow
          name="unattributed"
          meta={unattributed.length > 0 ? String(unattributed.length) : "—"}
          tone="neutral"
          active={unattributedOnly}
          onClick={() => (unattributedOnly ? scopeTo(null) : showUnattributed())}
          title="Items with no venue host"
        />
      </div>

      {!meshSnapshot && (
        <div className="ctx-panel-empty">Loading mesh…</div>
      )}
    </div>
  );
}
