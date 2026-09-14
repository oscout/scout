/**
 * What the rail shows under and beside a machine.
 *
 * Pure on purpose: this is where the Network page decides whose agents belong
 * to which machine, and that decision is the one #906 got wrong. It is testable
 * without a DOM.
 */

import { isAgentBusy, normalizeAgentState } from "../../lib/agent-state.ts";
import type { AgentStateToken } from "../../lib/mesh-view-store.ts";
import { bucketAgentsByMachine, type MachineBucket } from "../../lib/mesh-buckets.ts";
import {
  summarizeNodeReach,
  type MeshNodeStateAgentView,
  type MeshNodeStateView,
} from "../../lib/mesh-node-state.ts";
import type { Agent, MeshStatus } from "../../lib/types.ts";

export type MachineChild = {
  key: string;
  name: string;
  meta?: string;
  tone: AgentStateToken | "neutral";
  title: string;
  /** Only local agents can be opened; a remote roster row is a reading, not a handle. */
  agent: Agent | null;
  selectId: string | null;
};

function recencyKey(a: Agent): number {
  return a.updatedAt ?? a.createdAt ?? 0;
}

/**
 * What the rail lists under a machine.
 *
 * For this host the shared agent roster is the truth. For every other machine
 * it is not: those rows come from the local `/api/agents` response, which is
 * capped, filtered, and shared with other screens — that is what made a remote
 * card appear and then vanish. Remote children come from what the node itself
 * reported, and stay absent until it reports.
 */
export function machineChildren(bucket: MachineBucket, view: MeshNodeStateView | null): MachineChild[] {
  if (bucket.kind === "this") {
    return [...bucket.agents]
      .sort((x, y) => recencyKey(y) - recencyKey(x))
      .map((a) => ({
        key: a.id,
        name: a.name,
        tone: normalizeAgentState(a.state),
        title: a.name,
        agent: a,
        selectId: a.id,
      }));
  }
  if (!view || view.roster.length === 0) return [];
  return view.roster.map((a) => ({
    key: a.id,
    name: a.title,
    meta: a.statusLabel ?? undefined,
    tone: rosterTone(a.state),
    title: a.projectRoot ? `${a.title} — ${a.projectRoot}` : a.title,
    agent: null,
    selectId: null,
  }));
}

function rosterTone(state: MeshNodeStateAgentView["state"]): AgentStateToken | "neutral" {
  if (state === "working") return "in_turn";
  if (state === "available") return "callable";
  if (state === "offline") return "neutral";
  return "neutral";
}

/**
 * The number beside a machine.
 *
 * Counts appear only once that machine has reported them. Before then the row
 * says what we actually know — "not checked" — because a dash next to an
 * online machine reads as "nothing here", which is a claim no one has made.
 */
export function machineRowMeta(
  bucket: MachineBucket,
  view: MeshNodeStateView | null,
  loading: boolean,
): string {
  const workload = view?.workload ?? null;
  if (workload) {
    const counts = workload.working === null
      ? `${workload.total}`
      : `${workload.working}/${workload.total}`;
    return view?.stale ? `${counts} · last known` : counts;
  }
  if (loading) return "checking…";
  if (bucket.kind === "this" && bucket.agents.length > 0) {
    return `${bucket.agents.filter((a) => isAgentBusy(a.state)).length}/${bucket.agents.length}`;
  }
  return summarizeNodeReach(view).label.toLowerCase();
}


/** Remote map cards are inventory, never the shared cross-screen agent roster.
 * Their reading and detail action are rendered by the card itself. */
export function canvasMachineBuckets(agents: Agent[], mesh: MeshStatus): MachineBucket[] {
  return bucketAgentsByMachine(agents, mesh).map((bucket) =>
    bucket.kind === "this" ? bucket : { ...bucket, agents: [] });
}
