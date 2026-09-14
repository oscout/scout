import { useState, useCallback, useMemo } from "react";
import { useMeshViewStore, setMeshSnapshot } from "../../lib/mesh-view-store.ts";
import { NodeDetailPanel } from "./NodeDetailPanel.tsx";
import { useLocalAgents } from "../../lib/local-agents.ts";
import { useMeshNodeStates } from "../../lib/use-mesh-node-state.ts";
import { summarizeNodeReach } from "../../lib/mesh-node-state.ts";
import { timeAgo } from "../../lib/time.ts";
import { filterMeshRosterAgents } from "../../lib/mesh-roster.ts";
import { hasJoinedMesh } from "../../lib/mesh-membership.ts";
import { normalizeAgentState, isAgentBusy } from "../../lib/agent-state.ts";
import { api } from "../../lib/api.ts";
import type { Agent, MeshStatus } from "../../lib/types.ts";
import "../system-surfaces-redesign.css";
import "./mesh-screen.css";

type MeshActionMessage = {
  tone: "info" | "success" | "warning" | "error";
  text: string;
};

type MeshJoinStatus = MeshStatus & {
  discovery: {
    discoveredCount: number;
    probes: string[];
    error: string | null;
  };
};

function harnessBreakdown(agents: Agent[]): Array<{ label: string; total: number; working: number }> {
  const acc = new Map<string, { total: number; working: number }>();
  for (const a of agents) {
    const key = (a.harness ?? a.agentClass ?? "agent").toLowerCase();
    const entry = acc.get(key) ?? { total: 0, working: 0 };
    entry.total += 1;
    if (isAgentBusy(a.state)) entry.working += 1;
    acc.set(key, entry);
  }
  return Array.from(acc.entries())
    .map(([label, v]) => ({ label, total: v.total, working: v.working }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 6);
}

function shortHost(input?: string | null): string {
  if (!input) return "Unavailable";
  return input.replace(/^https?:\/\//, "").split("/")[0] ?? input;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function pollMeshStatus(
  predicate: (mesh: MeshStatus) => boolean,
  options: { attempts: number; intervalMs: number },
): Promise<MeshStatus> {
  let latest: MeshStatus | null = null;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= options.attempts; attempt += 1) {
    try {
      latest = await api<MeshStatus>("/api/mesh");
      setMeshSnapshot(latest);
      if (predicate(latest)) {
        return latest;
      }
    } catch (error) {
      lastError = error;
    }

    if (attempt < options.attempts) {
      await delay(options.intervalMs);
    }
  }

  if (latest) {
    return latest;
  }

  throw lastError instanceof Error ? lastError : new Error("Mesh status is temporarily unavailable.");
}

function firstActionableIssue(mesh: MeshStatus): string | null {
  return mesh.issues.find((issue) =>
    issue.code === "local_only" || issue.code === "mesh_loopback" || issue.code === "tailscale_stopped"
  )?.summary ?? null;
}

export function MeshInspectorPanel() {
  const { meshSnapshot, selectedId, selectedType } = useMeshViewStore();
  const { agents } = useLocalAgents();
  const nodeStates = useMeshNodeStates();
  const rosterAgents = useMemo(() => filterMeshRosterAgents(agents), [agents]);
  const [meshBusy, setMeshBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<MeshActionMessage | null>(null);

  const handleJoin = useCallback(async () => {
    setMeshBusy(true);
    setActionMessage({ tone: "info", text: "Joining mesh — announcing broker and syncing peers…" });
    try {
      const data = await api<MeshJoinStatus>("/api/mesh/join", { method: "POST", body: "{}" });
      setMeshSnapshot(data);
      const final = data.identity.discoverable
        ? data
        : await pollMeshStatus((mesh) => mesh.identity.discoverable, { attempts: 6, intervalMs: 750 });
      if (final.identity.discoverable) {
        const discovery = data.discovery;
        const peerNote = discovery?.discoveredCount != null
          ? ` Found ${discovery.discoveredCount} peer node${discovery.discoveredCount === 1 ? "" : "s"}.`
          : "";
        setActionMessage(discovery.error
          ? {
              tone: "warning",
              text: `On mesh, but the initial peer sync failed: ${discovery.error}`,
            }
          : {
              tone: "success",
              text: `On mesh at ${shortHost(final.identity.announceUrl ?? final.brokerUrl)}.${peerNote}`,
            });
      } else {
        setActionMessage({
          tone: "warning",
          text: firstActionableIssue(final) ?? "Joined, but this broker is not peer-reachable yet.",
        });
      }
    } catch (error) {
      setActionMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setMeshBusy(false);
    }
  }, []);

  const handleLeave = useCallback(async () => {
    setMeshBusy(true);
    setActionMessage({ tone: "info", text: "Leaving mesh…" });
    try {
      const data = await api<MeshStatus>("/api/mesh/leave", { method: "POST", body: "{}" });
      setMeshSnapshot(data);
      setActionMessage({ tone: "success", text: "Local only — peers will no longer discover this broker." });
    } catch (error) {
      setActionMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setMeshBusy(false);
    }
  }, []);

  const totals = useMemo(() => {
    const acc = { total: rosterAgents.length, working: 0, ready: 0, notReady: 0 };
    for (const a of rosterAgents) {
      const state = normalizeAgentState(a.state);
      if (state === "in_turn" || state === "in_flight") acc.working += 1;
      else if (state === "callable") acc.ready += 1;
      else acc.notReady += 1;
    }
    return acc;
  }, [rosterAgents]);

  const harness = useMemo(() => harnessBreakdown(rosterAgents), [rosterAgents]);

  if (!meshSnapshot) {
    return (
      <div className="sys-inspector-empty">
        <p>Loading mesh…</p>
      </div>
    );
  }

  // ── A machine is selected: show what is going on there ──
  // One panel for every row — this broker, a mesh peer, or a tailnet-only
  // device — so no kind of machine is a dead end on click.
  if (selectedId && selectedType === "node") {
    return <NodeDetailPanel machineId={selectedId} mesh={meshSnapshot} issues={meshSnapshot.issues} />;
  }

  // ── Default: the network, counted in machines ──
  // Nothing selected means no machine has been asked about, so this panel talks
  // about machines and when they were last checked. It deliberately does not
  // total the local agent roster and present it as the network: that roster is
  // this host's, and reading it as a fleet-wide figure is the habit that made
  // remote machines look empty.
  const mesh = meshSnapshot;
  const peerCount = Object.values(mesh.nodes).filter((n) => n.id !== mesh.localNode?.id).length;
  const tailnetOnline = mesh.tailscale.onlineCount ?? 0;
  const hostLabel = mesh.localNode?.hostName?.split(".")[0] ?? mesh.localNode?.name ?? mesh.identity.name ?? "this broker";

  const machines = Object.values(nodeStates.entries);
  const machineCounts = machines.reduce(
    (acc, entry) => {
      const tone = summarizeNodeReach(entry.view ?? null).tone;
      if (!entry.view || entry.view.broker === "unknown") acc.unchecked += 1;
      else if (tone === "ok") acc.responding += 1;
      else if (tone === "warn") acc.partial += 1;
      else acc.silent += 1;
      return acc;
    },
    { responding: 0, partial: 0, silent: 0, unchecked: 0 },
  );

  return (
    <div className="sys-inspector-content mesh-summary">
      <div className="sys-inspector-head">
        <h3 className="sys-inspector-title">Network</h3>
        <span className="mesh-summary-mode">{mesh.identity.modeLabel}</span>
      </div>

      <section className="mesh-summary-section">
        <div className="mesh-summary-counts">
          <div className="mesh-summary-count">
            <span className="mesh-summary-count-value">{machines.length || peerCount + 1}</span>
            <span className="mesh-summary-count-label">machines</span>
          </div>
          <div className="mesh-summary-count mesh-summary-count--working">
            <span className="mesh-summary-count-value">{machineCounts.responding}</span>
            <span className="mesh-summary-count-label">responding</span>
          </div>
          {machineCounts.partial > 0 && (
            <div className="mesh-summary-count">
              <span className="mesh-summary-count-value">{machineCounts.partial}</span>
              <span className="mesh-summary-count-label">partial</span>
            </div>
          )}
          {machineCounts.silent > 0 && (
            <div className="mesh-summary-count mesh-summary-count--offline">
              <span className="mesh-summary-count-value">{machineCounts.silent}</span>
              <span className="mesh-summary-count-label">no answer</span>
            </div>
          )}
          {machineCounts.unchecked > 0 && (
            <div className="mesh-summary-count">
              <span className="mesh-summary-count-value">{machineCounts.unchecked}</span>
              <span className="mesh-summary-count-label">not checked</span>
            </div>
          )}
        </div>
        <p className="mesh-summary-hint">
          {nodeStates.updatedAt
            ? `Machines last swept ${timeAgo(nodeStates.updatedAt)}. Select one to see what is running on it.`
            : "Select a machine to see what is running on it."}
        </p>
      </section>

      <section className="mesh-summary-section">
        <div className="sys-inspector-section-label">On {hostLabel}</div>
        <div className="mesh-summary-counts">
          <div className="mesh-summary-count">
            <span className="mesh-summary-count-value">{totals.total}</span>
            <span className="mesh-summary-count-label">agents</span>
          </div>
          <div className="mesh-summary-count mesh-summary-count--working">
            <span className="mesh-summary-count-value">{totals.working}</span>
            <span className="mesh-summary-count-label">working</span>
          </div>
          <div className="mesh-summary-count">
            <span className="mesh-summary-count-value">{totals.ready}</span>
            <span className="mesh-summary-count-label">ready</span>
          </div>
          <div className="mesh-summary-count mesh-summary-count--offline">
            <span className="mesh-summary-count-value">{totals.notReady}</span>
            <span className="mesh-summary-count-label">not ready</span>
          </div>
        </div>
      </section>

      {harness.length > 0 && (
        <section className="mesh-summary-section">
          <div className="sys-inspector-section-label">By harness, on {hostLabel}</div>
          <div className="mesh-summary-harness">
            {harness.map((h) => (
              <div key={h.label} className="mesh-summary-harness-row">
                <span className="mesh-summary-harness-name">{h.label}</span>
                <span className="mesh-summary-harness-count">{h.total}</span>
                {h.working > 0 && (
                  <span className="mesh-summary-harness-working">{h.working} working</span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="mesh-summary-section">
        <div className="sys-inspector-section-label">Peers</div>
        <div className="mesh-summary-peers">
          <div className="mesh-summary-peer-row">
            <span className="mesh-summary-peer-label">Mesh</span>
            <span className="mesh-summary-peer-value">{peerCount}</span>
          </div>
          {mesh.tailscale.available && (
            <div className="mesh-summary-peer-row">
              <span className="mesh-summary-peer-label">Tailnet</span>
              <span className={`mesh-summary-peer-value${mesh.tailscale.running ? "" : " mesh-summary-peer-value--dim"}`}>
                {mesh.tailscale.running ? `${tailnetOnline} online` : "stopped"}
              </span>
            </div>
          )}
        </div>
      </section>

      <section className="mesh-summary-section mesh-summary-reach">
        <div className="sys-inspector-section-label">Mesh</div>
        <MeshJoinToggle
          joined={hasJoinedMesh(mesh)}
          busy={meshBusy}
          tailscaleAvailable={mesh.tailscale.available}
          onJoin={() => void handleJoin()}
          onLeave={() => void handleLeave()}
        />
        {actionMessage && (
          <div className={`sys-banner mesh-action-message sys-banner-${actionMessage.tone}`}>
            <span>{actionMessage.text}</span>
          </div>
        )}
      </section>
    </div>
  );
}

function MeshJoinToggle({
  joined,
  busy,
  tailscaleAvailable,
  onJoin,
  onLeave,
}: {
  joined: boolean;
  busy: boolean;
  tailscaleAvailable: boolean;
  onJoin: () => void;
  onLeave: () => void;
}) {
  return (
    <div className="mesh-reach">
      <label className="mesh-join-toggle">
        <input
          type="checkbox"
          checked={joined}
          disabled={busy}
          onChange={() => {
            if (joined) onLeave();
            else onJoin();
          }}
        />
        <span className="mesh-join-toggle-copy">
          {busy ? "Working…" : joined ? "On mesh" : "Join mesh"}
        </span>
      </label>
      {!tailscaleAvailable && !joined && (
        <p className="mesh-join-hint">Tailscale can add automatic discovery; explicit seeds and LAN peers still work.</p>
      )}
      {joined && (
        <p className="mesh-join-hint">Mesh membership is on. Reachability is reported separately above.</p>
      )}
    </div>
  );
}
