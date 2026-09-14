/**
 * What is going on, on one machine.
 *
 * Selecting a node loads that node's own state — its identity, and the agents
 * it is actually running — from the broker that owns it, over the signed mesh
 * path. It never falls back to this machine's agents to fill the space: an
 * agent list that silently belongs to somewhere else is worse than an empty
 * panel, because it reads as an answer.
 *
 * The four readings stay separate on screen. "We could not reach it", "it
 * answered but cannot report this", "it answered and has nothing running", and
 * "this is what it said last time we got through" are four different things,
 * and only the third of them means idle.
 */

import { useEffect, useRef, type ReactNode } from "react";

import { timeAgo } from "../../lib/time.ts";
import {
  loadMeshNodeState,
  refreshMeshNodeState,
  isEvidencedIdle,
  summarizeNodeReach,
  type MeshNodeStateAgentView,
  type MeshNodeStateEntry,
  type MeshNodeStateSectionView,
  type MeshNodeStateView,
} from "../../lib/mesh-node-state.ts";
import { useMeshNodeState } from "../../lib/use-mesh-node-state.ts";
import { setMeshSelection } from "../../lib/mesh-view-store.ts";
import type { MeshStatus } from "../../lib/types.ts";

function shortHost(input?: string | null): string {
  if (!input) return "";
  return input.replace(/^https?:\/\//, "").split("/")[0] ?? input;
}

function agentStateToken(state: MeshNodeStateAgentView["state"]): string {
  if (state === "working") return "in_turn";
  if (state === "available") return "callable";
  if (state === "offline") return "blocked";
  return "unknown";
}

/** Identity facts we can state without having reached the machine. */
function DetailCard({ label, value, code }: { label: string; value: string; code?: boolean }) {
  return (
    <div className="sys-detail-card">
      <span className="sys-detail-label">{label}</span>
      {code
        ? <code className="sys-detail-value">{value}</code>
        : <span className="sys-detail-value">{value}</span>}
    </div>
  );
}

function WorkloadStrip({ view }: { view: MeshNodeStateView }) {
  const workload = view.workload;
  if (!workload) {
    return (
      <div className="mesh-node-workload mesh-node-workload--unknown">
        <span className="mesh-node-workload-note">
          No workload reported for this machine yet.
        </span>
      </div>
    );
  }

  // A source that names agents without attesting liveness reports null
  // counters. Showing "0 working" there would be a number we made up.
  const attested = workload.working !== null;
  return (
    <div className="mesh-node-workload">
      <div className="mesh-node-workload-cell">
        <span className="mesh-node-workload-num">{workload.total}</span>
        <span className="mesh-node-workload-label">on this node</span>
      </div>
      {attested ? (
        <>
          <div className="mesh-node-workload-cell mesh-node-workload-cell--working">
            <span className="mesh-node-workload-num">{workload.working}</span>
            <span className="mesh-node-workload-label">working</span>
          </div>
          <div className="mesh-node-workload-cell">
            <span className="mesh-node-workload-num">{workload.available}</span>
            <span className="mesh-node-workload-label">ready</span>
          </div>
          <div className="mesh-node-workload-cell">
            <span className="mesh-node-workload-num">{workload.offline}</span>
            <span className="mesh-node-workload-label">offline</span>
          </div>
        </>
      ) : (
        <div className="mesh-node-workload-cell mesh-node-workload-cell--unknown">
          <span className="mesh-node-workload-label">
            registered here — this broker cannot report what they are doing
          </span>
        </div>
      )}
      {workload.unattributed > 0 && (
        <div className="mesh-node-workload-cell mesh-node-workload-cell--unknown">
          <span className="mesh-node-workload-num">{workload.unattributed}</span>
          <span className="mesh-node-workload-label">not attributed to this node</span>
        </div>
      )}
    </div>
  );
}

function Roster({ view }: { view: MeshNodeStateView }) {
  if (view.roster.length === 0) {
    // Only a complete, attested, current reading may be read as "nothing
    // running" — the same rule the rest of the page uses.
    if (isEvidencedIdle(view)) {
      return (
        <div className="sys-list-empty" style={{ marginTop: 4 }}>
          <p>Connected, with nothing running right now.</p>
        </div>
      );
    }
    return (
      <div className="sys-list-empty" style={{ marginTop: 4 }}>
        <p>Nothing has been reported for this machine. That is not the same as nothing running.</p>
      </div>
    );
  }

  return (
    <div className="mesh-agent-table" style={{ marginTop: 4 }}>
      {view.roster.map((agent) => {
        const token = agentStateToken(agent.state);
        return (
          <div key={agent.id} className="mesh-detail-agent">
            <span className={`mesh-detail-dot mesh-detail-dot--${token}`} />
            <div className="mesh-detail-agent-body">
              <span className="mesh-detail-agent-name">{agent.title}</span>
              {(agent.role || agent.projectRoot) && (
                <span className="mesh-detail-agent-task">
                  {[agent.role, agent.projectRoot].filter(Boolean).join(" · ")}
                </span>
              )}
            </div>
            <span className={`mesh-detail-agent-state mesh-detail-agent-state--${token}`}>
              {agent.statusLabel ?? (agent.state ?? "state unknown")}
            </span>
          </div>
        );
      })}
      {view.workload?.truncated && (
        <p className="mesh-node-roster-note">
          Showing the first {view.roster.length} of {view.workload.total}.
        </p>
      )}
    </div>
  );
}

/**
 * A section of the panel.
 *
 * `section === null` means nothing reported it. That is a different sentence
 * from "it reported none", and the two must never share a rendering: one is
 * missing evidence, the other is evidence of absence.
 */
function Section<T>({
  title,
  section,
  unreported,
  empty,
  render,
}: {
  title: string;
  section: MeshNodeStateSectionView<T>;
  unreported: string;
  empty: string;
  render: (item: T) => ReactNode;
}) {
  return (
    <div className="mesh-node-inspector-section">
      <div className="sys-inspector-section-label">
        {title}
        {section && section.total > 0 && (
          <span className="mesh-node-section-count">{section.total}</span>
        )}
      </div>
      {!section && (
        <p className="mesh-node-unreported">{unreported}</p>
      )}
      {section && section.items.length === 0 && (
        <p className="mesh-node-empty">{empty}</p>
      )}
      {section && section.items.length > 0 && (
        <div className="mesh-node-rows">
          {section.items.map((item) => render(item))}
          {section.truncated && (
            <p className="mesh-node-roster-note">
              Showing {section.items.length} of {section.total}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function NodeDetailPanel({
  machineId,
  mesh,
  issues = [],
}: {
  machineId: string;
  mesh: MeshStatus;
  /** Local-broker issues, shown only for this machine's own row. */
  issues?: MeshStatus["issues"];
}) {
  const entry: MeshNodeStateEntry | null = useMeshNodeState(machineId);
  const view = entry?.view ?? null;
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    // Details load on selection, not on every poll, and once per selection.
    if (loadedFor.current === machineId) return;
    loadedFor.current = machineId;
    void loadMeshNodeState(machineId, { deep: true });
  }, [machineId]);

  // Identity we already hold from the mesh snapshot, so the panel is never
  // blank while the check runs.
  const snapshotNode = Object.values(mesh.nodes).find((node) => node.id === machineId)
    ?? (mesh.localNode?.id === machineId ? mesh.localNode : null);
  const tailnetPeer = machineId.startsWith("tailnet:")
    ? mesh.tailscale.peers.find((peer) => peer.id === machineId.slice("tailnet:".length)) ?? null
    : mesh.tailscale.peers.find((peer) => {
        const host = (peer.hostName ?? peer.name ?? "").split(".")[0]?.toLowerCase();
        const nodeHost = (snapshotNode?.hostName ?? snapshotNode?.name ?? "").split(".")[0]?.toLowerCase();
        return Boolean(host && nodeHost && host === nodeHost);
      }) ?? null;

  const label = view?.label
    ?? snapshotNode?.hostName?.split(".")[0]
    ?? snapshotNode?.name
    ?? tailnetPeer?.hostName?.split(".")[0]
    ?? tailnetPeer?.name
    ?? "Node";
  const isLocal = mesh.localNode?.id === machineId;
  const reach = summarizeNodeReach(view);
  const brokerUrl = view?.node?.brokerUrl ?? snapshotNode?.brokerUrl ?? null;
  const nodeId = view?.node?.id ?? snapshotNode?.id ?? null;
  const capabilities = view?.node?.capabilities ?? snapshotNode?.capabilities ?? [];
  const address = tailnetPeer?.addresses?.[0]?.split("/")[0] ?? null;
  // Only peer node records carry a last-seen stamp; the local one does not.
  const snapshotLastSeenAt = snapshotNode && "lastSeenAt" in snapshotNode
    && typeof snapshotNode.lastSeenAt === "number"
    ? snapshotNode.lastSeenAt
    : null;

  return (
    <div className="sys-inspector-content mesh-node-inspector">
      <div className="sys-inspector-head">
        <h3 className="sys-inspector-title">{label}</h3>
        <div className="mesh-node-inspector-actions">
          {isLocal && <span className="sys-chip sys-chip-neutral">this broker</span>}
          <span className={`sys-chip mesh-node-reach mesh-node-reach--${reach.tone}`}>
            {entry?.loading ? "Checking…" : reach.label}
          </span>
          <button
            type="button"
            className="s-btn s-btn--sm"
            disabled={entry?.loading ?? false}
            onClick={() => void refreshMeshNodeState(machineId)}
            title="Check this machine again now"
          >
            Refresh
          </button>
        </div>
      </div>

      {(reach.detail || entry?.error) && (
        <div className={`sys-banner sys-banner-${reach.tone === "bad" ? "warning" : "muted"} mesh-node-reach-note`}>
          <span>{entry?.error ?? reach.detail}</span>
        </div>
      )}

      <div className="mesh-node-inspector-section">
        <div className="sys-inspector-section-label">
          Running here
          {view?.stale && <span className="mesh-node-stale-tag">last known</span>}
        </div>

        {!view && entry?.loading && (
          <div className="sys-banner sys-banner-muted">
            <span>Asking {label} what it is running…</span>
          </div>
        )}

        {!view && !entry?.loading && (
          <div className="sys-list-empty">
            <p>This machine has not been checked yet.</p>
          </div>
        )}

        {view && (
          <>
            <WorkloadStrip view={view} />
            <Roster view={view} />
          </>
        )}
      </div>

      {view && (
        <>
          <Section
            title="Sessions"
            section={view.sessions}
            unreported="This machine did not report its sessions."
            empty="No harness session is live on this machine."
            render={(session) => (
              <div key={session.id} className="mesh-node-row">
                <span className="mesh-node-row-name">{session.agentId || session.id}</span>
                <span className="mesh-node-row-meta">
                  {[session.harness, session.transport].filter(Boolean).join(" · ") || "session"}
                </span>
                <span className={`mesh-node-row-state mesh-node-row-state--${session.state}`}>
                  {session.state}
                </span>
              </div>
            )}
          />

          <Section
            title="Work in flight"
            section={view.work}
            unreported="This machine did not report work in flight."
            empty="No work is in flight on this machine."
            render={(item) => (
              <div key={item.id} className="mesh-node-row">
                <span className="mesh-node-row-name">{item.targetAgentId || item.id}</span>
                {item.summary && <span className="mesh-node-row-meta">{item.summary}</span>}
                <span className={`mesh-node-row-state mesh-node-row-state--${item.state}`}>
                  {item.state}
                </span>
              </div>
            )}
          />
        </>
      )}

      {/* Identity sits under the live state on purpose: an operator opening a
          machine is asking what is happening on it, not what it is called. */}
      <div className="mesh-node-inspector-section mesh-node-identity">
        <div className="sys-inspector-section-label">Machine</div>
        <div className="sys-detail-grid">
          {nodeId && <DetailCard label="Node ID" value={nodeId} code />}
          {(view?.node?.hostName ?? snapshotNode?.hostName) && (
            <DetailCard label="Host" value={view?.node?.hostName ?? snapshotNode?.hostName ?? ""} />
          )}
          {brokerUrl && <DetailCard label="Broker" value={shortHost(brokerUrl)} code />}
          {address && <DetailCard label="Address" value={address} code />}
          {tailnetPeer?.os && <DetailCard label="Platform" value={tailnetPeer.os} />}
          {view?.node?.meshId && <DetailCard label="Mesh" value={view.node.meshId.slice(0, 14)} code />}
          {view?.observedAt && <DetailCard label="Reported" value={timeAgo(view.observedAt)} />}
          {view?.checkedAt && <DetailCard label="Checked" value={timeAgo(view.checkedAt)} />}
          {!view?.checkedAt && snapshotLastSeenAt !== null && (
            <DetailCard label="Last seen" value={timeAgo(snapshotLastSeenAt)} />
          )}
        </div>
        {capabilities.length > 0 && (
          <div className="mesh-node-caps">
            {capabilities.map((capability) => (
              <span key={capability} className="sys-chip sys-chip-neutral">{capability}</span>
            ))}
          </div>
        )}
      </div>

      {isLocal && issues.length > 0 && (
        <div className="sys-issue-grid" style={{ marginTop: 12 }}>
          {issues.map((issue, index) => (
            <article
              key={index}
              className={`sys-issue-card sys-issue-card-${issue.severity === "error" ? "error" : "warning"}`}
            >
              <div className="sys-issue-head">
                <h3 className="sys-issue-title">{issue.title}</h3>
              </div>
              <p className="sys-issue-body">{issue.summary}</p>
              {issue.actionCommand && (
                <div className="sys-issue-action">
                  <code className="sys-code-inline">{issue.actionCommand}</code>
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      <button
        type="button"
        className="s-btn"
        style={{ marginTop: 14 }}
        onClick={() => setMeshSelection(null, null)}
      >
        Clear selection
      </button>
    </div>
  );
}
