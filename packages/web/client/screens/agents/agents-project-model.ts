/* Agents · Project view — data shaping.

   The project-detail roster collapses a project's per-identity broker rows up by
   agent NAME (one recognizable agent surfaces under many rows — branch, worktree,
   clone, session). Ported from the signed-off studio study
   (design/studio/app/studies/agents-project): the studio's `groupsFor` ran over a
   fixture generated FROM this exact AgentInventoryRow shape, so it maps 1:1 onto
   the real `DirProject` tree. Pure + dependency-light so it stays unit-testable. */

import type {
  DirProject,
  ProjectTreeAgentNode,
} from "./model.ts";

const LIVE_WINDOW_MS = 30 * 60_000;

// The broker mints a separate identity per workflow card + numeric clone —
// "Openscout Card J Sh3vxg", "Openscout 185", "Sco061". Demote those so the
// recognizable agents lead and the ephemeral tail folds away.
export function isEphemeralAgent(name: string): boolean {
  return (
    /\bcard\b/i.test(name) ||
    /\b\d{3,}\b/i.test(name) ||
    /sco\d{2,}/i.test(name) ||
    /grok\d+$/i.test(name) ||
    /codex\s*\d+$/i.test(name) ||
    /message\s+(attach|workflow)/i.test(name)
  );
}

export type ProjectAgentGroup = {
  name: string;
  harness: string;
  model: string | null;
  // The per-identity broker rows that rolled up under this name (each carries its
  // own branch/worktree + folded sessions). nodes[0] is the most recent.
  nodes: ProjectTreeAgentNode[];
  branches: string[];
  sessionCount: number;
  lastActivityAt: number;
  needs: boolean;
  ephemeral: boolean;
};

/**
 * Roll a project's agent nodes up by agent name. needs-you sorts first, then
 * recency, then conversation volume — so whoever wants you, or worked last, leads.
 */
export function groupsForProject(project: DirProject): ProjectAgentGroup[] {
  const byName = new Map<string, ProjectTreeAgentNode[]>();
  for (const node of project.agents) {
    const name = node.row.agent.name;
    const list = byName.get(name) ?? [];
    list.push(node);
    byName.set(name, list);
  }

  const groups: ProjectAgentGroup[] = [];
  for (const [name, nodes] of byName) {
    const branches = [
      ...new Set(nodes.map((node) => node.row.branch).filter((branch) => branch && branch !== "—")),
    ];
    const harnesses = [...new Set(nodes.map((node) => node.row.harness).filter(Boolean))];
    const models = [...new Set(nodes.map((node) => node.row.agent.model).filter((model): model is string => Boolean(model)))];
    groups.push({
      name,
      harness: harnesses.length === 1 ? harnesses[0]! : "mixed",
      model: harnesses.length === 1 && models.length === 1 ? models[0]! : null,
      nodes: [...nodes].sort(
        (a, b) => (b.row.lastActivityAt ?? 0) - (a.row.lastActivityAt ?? 0),
      ),
      branches,
      sessionCount: nodes.reduce((total, node) => total + node.sessions.length, 0),
      lastActivityAt: Math.max(0, ...nodes.map((node) => node.row.lastActivityAt ?? 0)),
      needs: nodes.some((node) => node.row.activeAskCount > 0),
      ephemeral: isEphemeralAgent(name),
    });
  }

  return groups.sort((a, b) => {
    if (a.needs !== b.needs) return a.needs ? -1 : 1;
    return b.lastActivityAt - a.lastActivityAt || b.sessionCount - a.sessionCount;
  });
}

/** Distinct non-trunk branches with active work, most-recent first. */
export function branchesInFlightForProject(project: DirProject): string[] {
  const seen = new Map<string, number>();
  for (const node of project.agents) {
    const branch = node.row.branch;
    if (!branch || branch === "—" || branch === "main") continue;
    seen.set(branch, Math.max(seen.get(branch) ?? 0, node.row.lastActivityAt ?? 0));
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([branch]) => branch);
}

export function isGroupLive(group: ProjectAgentGroup, nowMs: number): boolean {
  return nowMs - group.lastActivityAt < LIVE_WINDOW_MS;
}

/** Split the roster into the recognizable agents and the ephemeral/clone tail. */
export function partitionGroups(groups: ProjectAgentGroup[]): {
  primary: ProjectAgentGroup[];
  ephemeral: ProjectAgentGroup[];
} {
  return {
    primary: groups.filter((group) => !group.ephemeral),
    ephemeral: groups.filter((group) => group.ephemeral),
  };
}
