import { useMemo, useState } from "react";
import type { Agent } from "../lib/types.ts";
import { agentStateCssToken, agentStateLabel, isAgentBusy, normalizeAgentState, type AgentDisplayState } from "../lib/agent-state.ts";
import { stateColor } from "../lib/colors.ts";
import { timeAgo } from "../lib/time.ts";
import { useScout } from "../scout/Provider.tsx";
import { useAgentHoverCard } from "./useAgentHoverCard.tsx";

type AgentState = AgentDisplayState;

type BranchGroup = {
  branch: string;
  agents: Agent[];
  latest: number;
};

type ProjectGroup = {
  project: string;
  branches: BranchGroup[];
  agents: Agent[];
  latest: number;
  counts: Record<AgentState, number>;
};

function groupAgentsForTree(agents: Agent[]): ProjectGroup[] {
  const byProject = new Map<string, Map<string, Agent[]>>();
  const labelCounts = new Map<string, Map<string, number>>();
  for (const agent of agents) {
    const rawProject = agent.project ?? "Unassigned";
    const projectKey = rawProject.toLowerCase();
    const branch = agent.branch ?? "—";
    let branchMap = byProject.get(projectKey);
    if (!branchMap) {
      branchMap = new Map();
      byProject.set(projectKey, branchMap);
    }
    const list = branchMap.get(branch) ?? [];
    list.push(agent);
    branchMap.set(branch, list);
    let counts = labelCounts.get(projectKey);
    if (!counts) {
      counts = new Map();
      labelCounts.set(projectKey, counts);
    }
    counts.set(rawProject, (counts.get(rawProject) ?? 0) + 1);
  }

  const pickLabel = (key: string): string => {
    const counts = labelCounts.get(key);
    if (!counts) return key;
    let best: string | null = null;
    let bestCount = -1;
    for (const [label, count] of counts) {
      if (count > bestCount) { best = label; bestCount = count; }
    }
    return best ?? key;
  };

  const groups: ProjectGroup[] = [];
  for (const [projectKey, branchMap] of byProject) {
    const project = pickLabel(projectKey);
    const branches: BranchGroup[] = [];
    let projectLatest = 0;
    const counts: Record<AgentState, number> = {
      in_turn: 0,
      in_flight: 0,
      needs_attention: 0,
      callable: 0,
      blocked: 0,
    };
    const projectAgents: Agent[] = [];
    for (const [branch, list] of branchMap) {
      const sorted = [...list].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      const latest = sorted.reduce((acc, a) => Math.max(acc, a.updatedAt ?? 0), 0);
      projectLatest = Math.max(projectLatest, latest);
      for (const agent of sorted) {
        counts[normalizeAgentState(agent.state)] += 1;
        projectAgents.push(agent);
      }
      branches.push({ branch, agents: sorted, latest });
    }
    branches.sort((a, b) => b.latest - a.latest);
    groups.push({ project, branches, agents: projectAgents, latest: projectLatest, counts });
  }
  groups.sort((a, b) => b.latest - a.latest);
  return groups;
}

export type AgentTreeProps = {
  agents: Agent[];
  emptyTitle?: string;
  emptyBody?: string;
  selectMode?: "preview" | "navigate";
};

function homify(path: string | null | undefined): string | null {
  if (!path) return null;
  return path.replace(/^\/Users\/[^/]+/, "~");
}

export function AgentTree({
  agents,
  emptyTitle = "No agents registered",
  emptyBody = "Agents connected to this broker will appear here.",
  selectMode = "preview",
}: AgentTreeProps) {
  const { navigate } = useScout();
  const groups = useMemo(() => groupAgentsForTree(agents), [agents]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  // Flat ordered list of visible agent ids (skips collapsed groups) — drives keyboard arrows.
  const visibleAgentIds = useMemo(() => {
    const out: string[] = [];
    for (const group of groups) {
      if (collapsed.has(group.project)) continue;
      for (const branch of group.branches) {
        for (const agent of branch.agents) out.push(agent.id);
      }
    }
    return out;
  }, [groups, collapsed]);

  const hover = useAgentHoverCard({
    agents,
    orderedIds: visibleAgentIds,
    navigate,
    selectMode,
  });

  if (agents.length === 0) {
    return (
      <div className="sys-list-empty">
        <h3>{emptyTitle}</h3>
        <p>{emptyBody}</p>
      </div>
    );
  }

  const toggle = (project: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(project)) next.delete(project);
      else next.add(project);
      return next;
    });
  };

  return (
    <div className="mesh-tree" ref={hover.containerRef}>
      {groups.map((group) => {
        const isCollapsed = collapsed.has(group.project);
        return (
          <div key={group.project} className={`mesh-tree-group${isCollapsed ? " mesh-tree-group--collapsed" : ""}`}>
            <button
              type="button"
              className="mesh-tree-project"
              onClick={() => toggle(group.project)}
              aria-expanded={!isCollapsed}
            >
              <span className={`mesh-tree-caret${isCollapsed ? "" : " mesh-tree-caret--open"}`} aria-hidden>
                ›
              </span>
              <span className="mesh-tree-project-name">{group.project}</span>
              <span className="mesh-tree-project-count">{group.agents.length}</span>
              <span className="mesh-tree-counts">
                {(group.counts.in_turn + group.counts.in_flight + group.counts.needs_attention) > 0 && (
                  <span className="mesh-tree-count mesh-tree-count--working">
                    <span className="mesh-tree-count-dot" />
                    {group.counts.in_turn + group.counts.in_flight + group.counts.needs_attention}
                  </span>
                )}
                {group.counts.callable > 0 && (
                  <span className="mesh-tree-count mesh-tree-count--available">
                    <span className="mesh-tree-count-dot" />
                    {group.counts.callable}
                  </span>
                )}
                {group.counts.blocked > 0 && (
                  <span className="mesh-tree-count mesh-tree-count--offline">
                    <span className="mesh-tree-count-dot" />
                    {group.counts.blocked}
                  </span>
                )}
              </span>
              <span className="mesh-tree-project-time">
                {group.latest ? timeAgo(group.latest) : ""}
              </span>
            </button>

            {!isCollapsed && (
              <div className="mesh-tree-branches">
                {group.branches.map((branchGroup) => (
                  <div key={branchGroup.branch} className="mesh-tree-branch">
                    <div className="mesh-tree-branch-head">
                      <span className="mesh-tree-branch-elbow" aria-hidden>└</span>
                      <span className="mesh-tree-branch-name">{branchGroup.branch}</span>
                    </div>
                    <div className="mesh-tree-agents">
                      {branchGroup.agents.map((agent) => {
                        const state = normalizeAgentState(agent.state);
                        const stateClass = agentStateCssToken(agent.state);
                        const isOrganic = agent.agentClass === "organic";
                        const rowState = hover.getState(agent.id);
                        const cwd = homify(agent.cwd) ?? homify(agent.projectRoot);
                        const sessionRef = agent.harnessSessionId ? agent.harnessSessionId.slice(0, 8) : null;
                        const inlineParts: Array<{ kind: string; text: string }> = [];
                        if (cwd) inlineParts.push({ kind: "cwd", text: cwd });
                        if (agent.harness) inlineParts.push({ kind: "harness", text: agent.harness });
                        if (agent.model) inlineParts.push({ kind: "model", text: agent.model });
                        if (sessionRef) inlineParts.push({ kind: "sess", text: `sess:${sessionRef}` });
                        const bindings = hover.bind<HTMLButtonElement>(agent.id);
                        return (
                          <button
                            key={agent.id}
                            type="button"
                            className={`mesh-tree-agent${isOrganic ? " mesh-tree-agent--organic" : ""}${rowState.isActive ? " mesh-tree-agent--active" : ""}${rowState.isPinned ? " mesh-tree-agent--pinned" : ""}`}
                            title={isOrganic ? `${agent.harness ?? agent.name} · organic session` : undefined}
                            {...bindings}
                          >
                            <span
                              className={`mesh-tree-agent-dot mesh-tree-agent-dot--${stateClass}`}
                              style={{ background: stateColor(agent.state) }}
                            />
                            <span className="mesh-tree-agent-name">{agent.handle ?? agent.name}</span>
                            {isOrganic && (
                              <span className="mesh-tree-agent-organic" aria-label="organic session">○</span>
                            )}
                            <span className="mesh-tree-agent-inline">
                              {inlineParts.map((part, i) => (
                                <span key={part.kind} className={`mesh-tree-agent-inline-part mesh-tree-agent-inline-part--${part.kind}`}>
                                  {i > 0 && <span className="mesh-tree-agent-inline-sep">·</span>}
                                  {part.text}
                                </span>
                              ))}
                            </span>
                            <span className={`mesh-tree-agent-state mesh-tree-agent-state--${stateClass}`}>{agentStateLabel(state)}</span>
                            <span className="mesh-tree-agent-time">
                              {agent.updatedAt ? timeAgo(agent.updatedAt) : ""}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {hover.card}
    </div>
  );
}
