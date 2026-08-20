import { useEffect, useMemo, useState } from "react";

import { api } from "../lib/api.ts";
import { timeAgoWithSuffix } from "../lib/time.ts";
import type {
  HarnessTopologyObservation,
  HarnessTopologySnapshot,
  ObservedHarnessAgent,
  ObservedHarnessGroup,
  ObservedHarnessRelationship,
  ObservedHarnessTask,
  ObservedHarnessTopology,
} from "../lib/types.ts";

import "./observed-topology-panel.css";

type TopologyPanelSize = "full" | "compact" | "rail";

type ObservedTopologyPanelProps = {
  topology?: ObservedHarnessTopology | null;
  sessionId?: string | null;
  size?: TopologyPanelSize;
  title?: string;
  maxAgents?: number;
  maxTasks?: number;
  showEmpty?: boolean;
};

type TopologySourceModel = {
  source: string;
  observedAt: number | null;
  topology: ObservedHarnessTopology;
};

type WorkflowSummaryModel = {
  id: string;
  label: string;
  description: string | null;
  runId: string;
  parentSessionId: string | null;
  status: string;
  workerCount: number;
  taskCount: number;
  activeTaskCount: number;
  completedTaskCount: number;
  eventCount: number;
  latestAt: number | null;
  taskPreview: ObservedHarnessTask[];
};

function observedAtMs(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function shortId(value: string | undefined): string | null {
  if (!value) return null;
  if (value.length <= 12) return value;
  return value.slice(0, 12);
}

function sourceLabel(source: string): string {
  if (source.includes("workflow")) return "Claude workflows";
  if (source.includes("codex")) return "Codex";
  if (source.includes("claude")) return "Claude Code";
  return source.replace(/[-_]/g, " ");
}

function workflowStatsLine(workflow: WorkflowSummaryModel): string {
  const parts: string[] = [];
  if (workflow.workerCount > 0) {
    parts.push(`${workflow.workerCount} worker${workflow.workerCount === 1 ? "" : "s"}`);
  }
  if (workflow.eventCount > 0) {
    parts.push(`${workflow.eventCount} event${workflow.eventCount === 1 ? "" : "s"}`);
  } else if (workflow.taskCount > 0) {
    parts.push(`${workflow.completedTaskCount}/${workflow.taskCount} tasks`);
  }
  return parts.join(" · ");
}

function workflowTooltip(workflow: WorkflowSummaryModel): string {
  const lines = [workflow.label];
  if (workflow.description) lines.push(workflow.description);
  const stats = workflowStatsLine(workflow);
  if (stats) lines.push(stats);
  if (workflow.parentSessionId) {
    lines.push(`Parent session ${workflow.parentSessionId}`);
  }
  return lines.join("\n");
}

function displayAgentName(agent: ObservedHarnessAgent): string {
  return agent.name ?? shortId(agent.externalSessionId) ?? agent.id.replace(/^.*:/, "");
}

function agentStatus(agent: ObservedHarnessAgent): string {
  return agent.status ?? agent.role ?? agent.type ?? "observed";
}

function stringMeta(meta: Record<string, unknown> | undefined, key: string): string | null {
  const value = meta?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberMeta(meta: Record<string, unknown> | undefined, key: string): number | null {
  const value = meta?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function workflowRunIdFromMeta(meta: Record<string, unknown> | undefined): string | null {
  return stringMeta(meta, "claudeWorkflowRunId") ?? stringMeta(meta, "workflowRunId");
}

function findSpawnParents(
  agent: ObservedHarnessAgent,
  relationships: ObservedHarnessRelationship[],
  agentById: Map<string, ObservedHarnessAgent>,
): string[] {
  return relationships
    .filter((rel) => rel.kind === "spawned" && rel.toId === agent.id)
    .map((rel) => agentById.get(rel.fromId))
    .filter((parent): parent is ObservedHarnessAgent => Boolean(parent))
    .map(displayAgentName);
}

function taskForAgent(
  agent: ObservedHarnessAgent,
  tasks: ObservedHarnessTask[],
): ObservedHarnessTask | null {
  return tasks.find((task) => task.assigneeId === agent.id) ?? null;
}

function taskMatchesWorkflow(task: ObservedHarnessTask, runId: string): boolean {
  return workflowRunIdFromMeta(task.providerMeta) === runId || task.id.includes(runId);
}

function agentMatchesWorkflow(agent: ObservedHarnessAgent, runId: string): boolean {
  return workflowRunIdFromMeta(agent.providerMeta) === runId || agent.id.includes(runId);
}

function latestAgentTimestamp(agent: ObservedHarnessAgent): number | null {
  const value = stringMeta(agent.providerMeta, "latestTimestamp");
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function workflowStatus(tasks: ObservedHarnessTask[], workers: ObservedHarnessAgent[]): string {
  if (tasks.some((task) => task.state && statusRank(task.state) === 0)) return "running";
  if (workers.some((worker) => worker.status && statusRank(worker.status) === 0)) return "running";
  if (tasks.some((task) => task.state === "failed" || task.state === "error")) return "failed";
  if (workers.some((worker) => worker.status === "failed" || worker.status === "error")) return "failed";
  if (tasks.length > 0 && tasks.every((task) => task.state === "completed" || task.state === "done")) return "completed";
  if (workers.length > 0 && workers.every((worker) => worker.status === "completed" || worker.status === "done")) return "completed";
  if (tasks.length > 0) return "observed";
  return "workflow";
}

function buildWorkflowSummaries(
  topology: ObservedHarnessTopology,
  observedAt: number | null,
): WorkflowSummaryModel[] {
  const workflowGroups = topology.groups.filter((group) => group.kind === "workflow");
  return workflowGroups
    .map((group: ObservedHarnessGroup): WorkflowSummaryModel => {
      const runId = workflowRunIdFromMeta(group.providerMeta) ?? group.id;
      const tasks = topology.tasks.filter((task) => taskMatchesWorkflow(task, runId));
      const workers = topology.agents.filter((agent) =>
        agent.role !== "lead" && agentMatchesWorkflow(agent, runId)
      );
      const activeTasks = tasks.filter((task) => task.state !== "completed" && task.state !== "done");
      const completedTasks = tasks.filter((task) => task.state === "completed" || task.state === "done");
      const latestWorkerAt = workers
        .map(latestAgentTimestamp)
        .filter((value): value is number => Boolean(value))
        .sort((left, right) => right - left)[0] ?? null;
      const eventCount = workers.reduce(
        (total, worker) => total + (numberMeta(worker.providerMeta, "eventCount") ?? 0),
        0,
      );
      const taskPreview = (activeTasks.length > 0 ? activeTasks : tasks).slice(0, 3);

      return {
        id: group.id,
        label: group.name ?? runId,
        description: stringMeta(group.providerMeta, "description"),
        runId,
        parentSessionId: stringMeta(group.providerMeta, "parentSessionId"),
        status: workflowStatus(tasks, workers),
        workerCount: workers.length,
        taskCount: tasks.length,
        activeTaskCount: activeTasks.length,
        completedTaskCount: completedTasks.length,
        eventCount,
        latestAt: latestWorkerAt ?? observedAt,
        taskPreview,
      };
    })
    .sort((left, right) => {
      const activeDelta = (right.activeTaskCount > 0 ? 1 : 0) - (left.activeTaskCount > 0 ? 1 : 0);
      if (activeDelta !== 0) return activeDelta;
      return (right.latestAt ?? 0) - (left.latestAt ?? 0)
        || left.label.localeCompare(right.label);
    });
}

function statusRank(status: string | undefined): number {
  if (status === "running" || status === "in_progress" || status === "working") return 0;
  if (status === "queued" || status === "pending" || status === "materialized") return 1;
  if (status === "failed" || status === "error") return 2;
  if (status === "completed" || status === "done") return 3;
  return 4;
}

function flattenSnapshot(snapshot: HarnessTopologySnapshot | null): TopologySourceModel[] {
  if (!snapshot) return [];
  return snapshot.observations.map((observation: HarnessTopologyObservation) => ({
    source: observation.source,
    observedAt: observedAtMs(observation.observedAt),
    topology: observation.topology,
  }));
}

export function ObservedTopologyPanel({
  topology,
  sessionId,
  size = "full",
  title = "Internal topology",
  maxAgents = size === "rail" ? 5 : 8,
  maxTasks = size === "rail" ? 3 : 5,
  showEmpty = false,
}: ObservedTopologyPanelProps) {
  const [snapshot, setSnapshot] = useState<HarnessTopologySnapshot | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (topology) return;
    let cancelled = false;
    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
    api<HarnessTopologySnapshot>(`/api/topology/snapshot${query}`)
      .then((result) => {
        if (!cancelled) {
          setSnapshot(result);
          setFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, topology]);

  const sources = useMemo<TopologySourceModel[]>(() => {
    if (topology) {
      return [{
        source: topology.source,
        observedAt: observedAtMs(topology.observedAt),
        topology,
      }];
    }
    return flattenSnapshot(snapshot);
  }, [snapshot, topology]);

  const totals = useMemo(() => {
    return sources.reduce(
      (acc, source) => {
        acc.sources += 1;
        acc.workflows += source.topology.groups.filter((group) => group.kind === "workflow").length;
        acc.agents += source.topology.agents.length;
        acc.subagents += source.topology.agents.filter((agent) => agent.role === "subagent").length;
        acc.tasks += source.topology.tasks.length;
        acc.activeTasks += source.topology.tasks.filter((task) => task.state !== "completed").length;
        acc.spawned += source.topology.relationships.filter((rel) => rel.kind === "spawned").length;
        return acc;
      },
      { sources: 0, workflows: 0, agents: 0, subagents: 0, tasks: 0, activeTasks: 0, spawned: 0 },
    );
  }, [sources]);

  const isRail = size === "rail";
  const runningWorkflowCount = sources.reduce(
    (count, source) => count + buildWorkflowSummaries(source.topology, source.observedAt)
      .filter((workflow) => workflow.status === "running").length,
    0,
  );

  if (sources.length === 0) {
    if (!showEmpty && !failed) return null;
    return (
      <section className={`s-observed-topology s-observed-topology--${size}`}>
        {!isRail && (
          <header className="s-observed-topology-head">
            <div>
              <div className="s-observed-topology-kicker">Harness observed</div>
              <h3>{title}</h3>
            </div>
          </header>
        )}
        <div className="s-observed-topology-empty">
          {failed ? "Topology is unavailable right now." : "No interacted agents observed yet."}
        </div>
      </section>
    );
  }

  return (
    <section className={`s-observed-topology s-observed-topology--${size}`}>
      {!isRail ? (
        <header className="s-observed-topology-head">
          <div>
            <div className="s-observed-topology-kicker">Harness observed</div>
            <h3>{title}</h3>
          </div>
          <div className="s-observed-topology-counts">
            {totals.workflows > 0 && <span>{totals.workflows} workflows</span>}
            <span>{totals.subagents} workers</span>
            <span>{totals.tasks} tasks</span>
            {totals.activeTasks > 0
              ? <span>{totals.activeTasks} active</span>
              : <span>{totals.spawned} spawn links</span>}
          </div>
        </header>
      ) : totals.workflows > 0 && (
        <div className="s-observed-topology-rail-summary">
          {runningWorkflowCount > 0
            ? `${runningWorkflowCount} running`
            : "No active workflows"}
          {totals.workflows > 0 && ` · ${totals.workflows} total`}
        </div>
      )}

      <div className="s-observed-topology-sources">
        {sources.map((source) => (
          <TopologySource
            key={`${source.source}:${source.topology.observedAt}`}
            source={source}
            maxAgents={maxAgents}
            maxTasks={maxTasks}
            size={size}
          />
        ))}
      </div>
    </section>
  );
}

function WorkflowRailRow({ workflow }: { workflow: WorkflowSummaryModel }) {
  const stats = workflowStatsLine(workflow);
  return (
    <div
      className={`s-observed-topology-rail-row s-observed-topology-rail-row--${workflow.status}`}
      title={workflowTooltip(workflow)}
    >
      <span
        className={`s-observed-topology-rail-dot s-observed-topology-rail-dot--${workflow.status}`}
        aria-label={workflow.status}
      />
      <span className="s-observed-topology-rail-name">{workflow.label}</span>
      {stats && <span className="s-observed-topology-rail-stats">{stats}</span>}
    </div>
  );
}

function TopologySource({
  source,
  maxAgents,
  maxTasks,
  size = "full",
}: {
  source: TopologySourceModel;
  maxAgents: number;
  maxTasks: number;
  size?: TopologyPanelSize;
}) {
  const isRail = size === "rail";
  const { topology } = source;
  const agentById = new Map(topology.agents.map((agent) => [agent.id, agent]));
  const workflows = buildWorkflowSummaries(topology, source.observedAt);
  const visibleWorkflows = workflows.slice(0, maxAgents);
  const hiddenWorkflowCount = workflows.length - visibleWorkflows.length;
  const byStatus = (left: ObservedHarnessAgent, right: ObservedHarnessAgent) =>
    statusRank(left.status) - statusRank(right.status) || displayAgentName(left).localeCompare(displayAgentName(right));
  const subagents = topology.agents.filter((agent) => agent.role === "subagent").sort(byStatus);
  const leadAgents = topology.agents.filter((agent) => agent.role === "lead").sort(byStatus);
  const otherAgents = topology.agents.filter((agent) => agent.role !== "subagent" && agent.role !== "lead").sort(byStatus);
  const visibleAgents = [...leadAgents, ...subagents, ...otherAgents].slice(0, maxAgents);
  const activeTasks = topology.tasks
    .filter((task) => task.state !== "completed")
    .sort((left, right) => statusRank(left.state) - statusRank(right.state) || (left.title ?? left.id).localeCompare(right.title ?? right.id))
    .slice(0, maxTasks);

  return (
    <div className="s-observed-topology-source">
      {!isRail && (
        <div className="s-observed-topology-source-head">
          <span>{sourceLabel(source.source)}</span>
          <span>{timeAgoWithSuffix(source.observedAt) || "observed"}</span>
        </div>
      )}

      {workflows.length > 0 ? (
        isRail ? (
          <div className="s-observed-topology-rail-list">
            {visibleWorkflows.map((workflow) => (
              <WorkflowRailRow key={workflow.id} workflow={workflow} />
            ))}
            {hiddenWorkflowCount > 0 && (
              <div className="s-observed-topology-rail-more">
                +{hiddenWorkflowCount} more workflow{hiddenWorkflowCount === 1 ? "" : "s"}
              </div>
            )}
          </div>
        ) : (
          <div className="s-observed-topology-workflow-list">
            {visibleWorkflows.map((workflow) => (
              <div key={workflow.id} className="s-observed-topology-workflow">
                <div className="s-observed-topology-workflow-main">
                  <span className={`s-observed-topology-workflow-state s-observed-topology-workflow-state--${workflow.status}`}>
                    {workflow.status}
                  </span>
                  <span className="s-observed-topology-workflow-name" title={workflowTooltip(workflow)}>
                    {workflow.label}
                  </span>
                  <span className="s-observed-topology-workflow-age">
                    {timeAgoWithSuffix(workflow.latestAt) || "observed"}
                  </span>
                </div>
                <div className="s-observed-topology-workflow-meta">
                  <span>{workflow.workerCount} workers</span>
                  {workflow.taskCount > 0 && (
                    <span>{workflow.completedTaskCount}/{workflow.taskCount} tasks</span>
                  )}
                  {workflow.eventCount > 0 && <span>{workflow.eventCount} events</span>}
                  {workflow.parentSessionId && <span>parent {shortId(workflow.parentSessionId)}</span>}
                </div>
                {workflow.description && (
                  <div className="s-observed-topology-workflow-description">
                    {workflow.description}
                  </div>
                )}
                {workflow.taskPreview.length > 0 && (
                  <div className="s-observed-topology-workflow-tasks">
                    {workflow.taskPreview.map((task) => (
                      <span key={task.id}>{task.title ?? task.id.replace(/^.*:/, "")}</span>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {hiddenWorkflowCount > 0 && (
              <div className="s-observed-topology-more">
                {hiddenWorkflowCount} more workflow{hiddenWorkflowCount === 1 ? "" : "s"}
              </div>
            )}
          </div>
        )
      ) : (
        <div className="s-observed-topology-agent-list">
          {visibleAgents.map((agent) => {
            const parents = findSpawnParents(agent, topology.relationships, agentById);
            const task = taskForAgent(agent, topology.tasks);
            return (
              <div key={agent.id} className="s-observed-topology-agent">
                <div className="s-observed-topology-agent-main">
                  <span className={`s-observed-topology-agent-role s-observed-topology-agent-role--${agent.role ?? "observed"}`}>
                    {agent.role ?? "observed"}
                  </span>
                  <span className="s-observed-topology-agent-name">{displayAgentName(agent)}</span>
                  <span className="s-observed-topology-agent-status">{agentStatus(agent)}</span>
                </div>
                {(parents.length > 0 || task?.title) && (
                  <div className="s-observed-topology-agent-detail">
                    {parents.length > 0 && <span>spawned by {parents.join(", ")}</span>}
                    {task?.title && <span>{task.title}</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {workflows.length === 0 && activeTasks.length > 0 && (
        <div className="s-observed-topology-task-list">
          {activeTasks.map((task) => (
            <div key={task.id} className="s-observed-topology-task">
              <span>{task.state ?? "task"}</span>
              <strong>{task.title ?? task.id.replace(/^.*:/, "")}</strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
