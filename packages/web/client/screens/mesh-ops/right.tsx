import { useState } from "react";
import { api } from "../../lib/api.ts";
import { timeAgo, timeAgoWithSuffix } from "../../lib/time.ts";
import type { WebMeshOpsItem } from "../../lib/types.ts";
import {
  requestMeshOpsRefresh,
  useMeshOpsViewStore,
} from "../../lib/mesh-ops-view-store.ts";
import { useMeshViewStore } from "../../lib/mesh-view-store.ts";
import { useScout } from "../../scout/Provider.tsx";
import "../../scout/slots/ctx-panel.css";
import "./mesh-ops.css";

type MeshOpsAction = "hold" | "release" | "accept" | "clear";

function isHeldByOperator(item: WebMeshOpsItem): boolean {
  return item.state === "waiting"
    && item.nextMoveOwnerId === "operator"
    && item.waitingOn?.label === "Held by operator";
}

function DetailRow({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="mesh-ops-detail-row">
      <span className="mesh-ops-detail-label">{label}</span>
      <span className="mesh-ops-detail-value">{value}</span>
    </div>
  );
}

/**
 * Mesh Ops inspector — the selected work item as detail rows plus the
 * steering actuations (hold / release / clear) as plain bordered buttons.
 * Actuations POST to the web server, which upserts through the broker;
 * the resulting SSE hint refetches the list.
 */
export function MeshOpsInspector() {
  const { navigate } = useScout();
  const { items, hosts, selectedItemId, lab } = useMeshOpsViewStore();
  const { meshSnapshot } = useMeshViewStore();
  const [pending, setPending] = useState<MeshOpsAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const item = items.find((candidate) => candidate.id === selectedItemId) ?? null;

  const actuate = async (action: MeshOpsAction) => {
    if (!item || pending) return;
    setPending(action);
    setActionError(null);
    try {
      await api(`/api/mesh-ops/items/${encodeURIComponent(item.id)}/${action}`, {
        method: "POST",
        body: "{}",
      });
      requestMeshOpsRefresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(null);
    }
  };

  if (!item) {
    // Nothing selected: the panel reads as the mesh summary — every known
    // host with the item counts touching it, like the study's right pane.
    const countsByHost = new Map<string, number>();
    for (const candidate of items) {
      if (!candidate.hostNodeId) continue;
      countsByHost.set(candidate.hostNodeId, (countsByHost.get(candidate.hostNodeId) ?? 0) + 1);
    }
    const localNodeId = meshSnapshot?.localNode?.id ?? null;
    return (
      <div className="ctx-panel mesh-ops-inspector">
        <div className="ctx-panel-section">
          <div className="ctx-panel-section-label">Mesh</div>
          {hosts.map((host) => (
            <DetailRow
              key={host.nodeId}
              label={host.nodeId === localNodeId ? "this host" : "peer"}
              value={`${host.label} · ${countsByHost.get(host.nodeId) ?? 0} items${
                host.liveSessionCount > 0 ? ` · ${host.liveSessionCount} live` : ""
              }`}
            />
          ))}
          {hosts.length === 0 && <div className="ctx-panel-empty">No hosts yet.</div>}
        </div>
        <div className="ctx-panel-section">
          <p className="mesh-ops-inspector-note">
            Select an item to inspect it. Counts are items attributed to each host; the map
            stays in the mesh screen.
          </p>
        </div>
      </div>
    );
  }

  // Observed session rows have no steering actuations — the inspector shows
  // the runtime detail the broker saw, nothing more.
  if (item.kind === "session" && item.session) {
    const session = item.session;
    return (
      <div className="ctx-panel mesh-ops-inspector">
        <div className="mesh-ops-inspector-header">
          <div className="mesh-ops-inspector-title">{item.title}</div>
          <div className="mesh-ops-inspector-summary">
            {session.live
              ? `Live ${session.harness} session`
              : session.endedAt !== null
                ? `Ended ${session.harness} session`
                : `Lost ${session.harness} session — no end marker, last seen ${timeAgoWithSuffix(session.lastSeenAt)}`}
            {session.alias ? ` · ${session.alias}` : ""}
          </div>
        </div>

        <div className="ctx-panel-section">
          <div className="ctx-panel-section-label">Session</div>
          <DetailRow label="harness" value={session.harness} />
          <DetailRow label="state" value={session.endedAt !== null ? "ended" : session.state} />
          <DetailRow label="agent" value={item.ownerId} />
          <DetailRow
            label="started"
            value={session.startedAt !== null ? timeAgoWithSuffix(session.startedAt) : null}
          />
          <DetailRow label="last seen" value={timeAgoWithSuffix(session.lastSeenAt)} />
          <DetailRow
            label="ended"
            value={session.endedAt !== null ? timeAgoWithSuffix(session.endedAt) : null}
          />
        </div>

        <div className="ctx-panel-section">
          <div className="ctx-panel-section-label">Venue</div>
          <DetailRow label="host" value={item.hostLabel} />
          <DetailRow label="project" value={item.projectRoot} />
          <DetailRow label="cwd" value={session.cwd} />
        </div>
      </div>
    );
  }

  const held = isHeldByOperator(item);
  const terminal = item.state === "done" || item.state === "cancelled";
  const canHold = item.state === "open" || item.state === "working";
  const canRelease = held;
  const accepting = item.state === "review";
  const flight = item.latestFlight;
  const inMotion =
    flight !== null && (flight.state === "running" || flight.state === "queued");
  const originLabel =
    meshSnapshot?.localNode?.hostName?.split(".")[0] ?? meshSnapshot?.localNode?.name ?? "here";
  const venueLabel = item.hostLabel ?? "unattributed";
  const sameHost = venueLabel === originLabel || item.hostNodeId === null;

  return (
    <div className="ctx-panel mesh-ops-inspector">
      <div className="mesh-ops-inspector-header">
        <div className="mesh-ops-inspector-title">{item.title}</div>
        {item.summary && <div className="mesh-ops-inspector-summary">{item.summary}</div>}
      </div>

      {lab.routeStrip && (
        <div className="mesh-ops-routestrip" aria-hidden>
          <svg viewBox="0 0 260 40" className="mesh-ops-routestrip-svg">
            <line
              x1="24"
              y1="18"
              x2="236"
              y2="18"
              className={`mesh-ops-routestrip-line${inMotion && !sameHost ? " mesh-ops-routestrip-line--moving" : ""}`}
            />
            <rect x="14" y="12" width="12" height="12" rx="2" className="mesh-ops-routestrip-node" />
            <rect x="234" y="12" width="12" height="12" rx="2" className="mesh-ops-routestrip-node" />
            <text x="20" y="36" textAnchor="middle" className="mesh-ops-routestrip-label">
              {originLabel}
            </text>
            <text x="246" y="36" textAnchor="end" className="mesh-ops-routestrip-label">
              {sameHost ? "(same host)" : venueLabel}
            </text>
          </svg>
        </div>
      )}

      {!terminal && (
        <div className="mesh-ops-actions">
          {canRelease ? (
            <button
              type="button"
              className="mesh-ops-button"
              disabled={pending !== null}
              onClick={() => void actuate("release")}
            >
              {pending === "release" ? "Releasing…" : "Release"}
            </button>
          ) : canHold ? (
            <button
              type="button"
              className="mesh-ops-button"
              disabled={pending !== null}
              onClick={() => void actuate("hold")}
            >
              {pending === "hold" ? "Holding…" : "Hold"}
            </button>
          ) : null}
          {(item.state === "review" || item.attention !== "silent") && (
            <button
              type="button"
              className="mesh-ops-button"
              disabled={pending !== null}
              onClick={() => void actuate(accepting ? "accept" : "clear")}
              title={accepting ? "Accept this work item" : "Dismiss this item from the attention queue"}
            >
              {pending === "accept" || pending === "clear"
                ? accepting ? "Accepting…" : "Clearing…"
                : accepting ? "Accept" : "Clear"}
            </button>
          )}
          <button
            type="button"
            className="mesh-ops-button"
            onClick={() => navigate({ view: "work", workId: item.id })}
            title="Open the full work item"
          >
            Open item
          </button>
        </div>
      )}
      {actionError && <div className="ctx-panel-empty" data-tone="error">{actionError}</div>}

      <div className="ctx-panel-section">
        <div className="ctx-panel-section-label">State</div>
        <DetailRow label="phase" value={item.currentPhase} />
        <DetailRow label="state" value={item.state} />
        <DetailRow label="attention" value={item.attention === "silent" ? null : item.attention} />
        <DetailRow label="waiting on" value={item.waitingOn?.label ?? null} />
        <DetailRow
          label="acceptance"
          value={item.acceptanceState === "none" ? null : item.acceptanceState}
        />
        <DetailRow label="priority" value={item.priority} />
        <DetailRow label="labels" value={item.labels.length > 0 ? item.labels.join(", ") : null} />
      </div>

      <div className="ctx-panel-section">
        <div className="ctx-panel-section-label">Venue</div>
        <DetailRow label="owner" value={item.ownerName ?? item.ownerId} />
        <DetailRow label="host" value={item.hostLabel ?? (item.hostNodeId ? item.hostNodeId : null)} />
        <DetailRow label="project" value={item.projectRoot} />
      </div>

      {flight && (
        <div className="ctx-panel-section">
          <div className="ctx-panel-section-label">Latest flight</div>
          <DetailRow label="state" value={flight.state} />
          <DetailRow label="summary" value={flight.summary} />
          <DetailRow
            label="started"
            value={flight.startedAt !== null ? timeAgoWithSuffix(flight.startedAt) : null}
          />
          <DetailRow
            label="completed"
            value={flight.completedAt !== null ? timeAgoWithSuffix(flight.completedAt) : null}
          />
          {item.activeFlightCount > 0 && (
            <DetailRow label="active" value={`${item.activeFlightCount} in flight`} />
          )}
        </div>
      )}

      <div className="ctx-panel-section">
        <div className="ctx-panel-section-label">Activity</div>
        <DetailRow label="last" value={item.lastMeaningfulSummary} />
        <DetailRow
          label="updated"
          value={`${timeAgo(item.updatedAt)} · created ${timeAgo(item.createdAt)}`}
        />
      </div>
    </div>
  );
}
