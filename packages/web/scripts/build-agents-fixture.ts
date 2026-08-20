/**
 * One-off: run the REAL agents-directory model over a live broker snapshot and
 * emit a compact fixture for the studio `/studies/agents-project` design study.
 * Run: bun packages/web/scripts/build-agents-fixture.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  buildDirProjects,
  buildNativeSessionRows,
  canonicalProjectRoot,
  directSessionMaps,
  dirProjectHarnesses,
  dirProjectNeeds,
  dirProjectSessionCount,
  dirProjectWorking,
  rowForAgentInventory,
  type DirProject,
} from "../client/screens/agents/model.ts";
import type { Agent, FleetAsk, FleetState, SessionEntry, TailDiscoverySnapshot } from "../client/lib/types.ts";

const SNAP = "/tmp/scout-snap";
const read = <T>(name: string): T => JSON.parse(readFileSync(`${SNAP}/${name}`, "utf8")) as T;

const agents = read<Agent[]>("agents.json");
const sessions = read<SessionEntry[]>("conversations.json");
const discover = read<TailDiscoverySnapshot>("discover.json");
const fleet = read<FleetState>("fleet.json");

const now = Date.now();
const { sessionByAgentId } = directSessionMaps(sessions);
const asksByAgent = new Map<string, FleetAsk[]>();
for (const ask of fleet.activeAsks ?? []) {
  const list = asksByAgent.get(ask.agentId) ?? [];
  list.push(ask);
  asksByAgent.set(ask.agentId, list);
}
const rows = agents.map((a) =>
  rowForAgentInventory(a, sessionByAgentId.get(a.id) ?? null, asksByAgent.get(a.id) ?? []),
);
const native = buildNativeSessionRows(discover, now);
const projects: DirProject[] = buildDirProjects(rows, sessions, native);

// Real "working" signal: live harness processes, grouped by canonical repo root.
const liveByRoot = new Map<string, { count: number; harnesses: Set<string> }>();
for (const proc of discover.processes ?? []) {
  const root = canonicalProjectRoot(proc.cwd);
  if (!root) continue;
  const entry = liveByRoot.get(root) ?? { count: 0, harnesses: new Set<string>() };
  entry.count += 1;
  if (proc.harness) entry.harnesses.add(proc.harness);
  liveByRoot.set(root, entry);
}

const fixture = projects.map((p) => ({
  slug: p.slice.slug,
  title: p.slice.title,
  root: p.slice.root,
  status: p.slice.status,
  harnesses: dirProjectHarnesses(p),
  working: dirProjectWorking(p),
  needs: dirProjectNeeds(p),
  sessionCount: dirProjectSessionCount(p),
  lastActivityAt: p.lastActivityAt,
  liveProcesses: p.slice.root ? (liveByRoot.get(p.slice.root)?.count ?? 0) : 0,
  liveHarnesses: p.slice.root ? [...(liveByRoot.get(p.slice.root)?.harnesses ?? [])] : [],
  agents: p.agents.map((node) => ({
    name: node.row.agent.name,
    harness: node.row.harness,
    status: node.row.status,
    stateLabel: node.row.stateLabel,
    branch: node.row.branch,
    activeTask: node.row.activeTask,
    activeAskCount: node.row.activeAskCount,
    lastActivityAt: node.row.lastActivityAt,
    model: node.row.agent.model ?? null,
    sessions: node.sessions.map((s) => ({
      kind: s.kind,
      status: s.status,
      harness: s.harness,
      label: s.label,
      detail: s.detail,
      lastActivityAt: s.lastActivityAt,
    })),
  })),
  unassigned: p.unassigned.map((s) => ({
    kind: s.kind,
    status: s.status,
    harness: s.harness,
    label: s.label,
    detail: s.detail,
    lastActivityAt: s.lastActivityAt,
  })),
}));

const recentCompleted = (fleet.recentCompleted ?? []).map((r) => ({
  agentName: r.agentName,
  agentId: r.agentId,
  task: r.task,
  conversationId: r.conversationId,
  completedAt: r.completedAt ?? null,
}));

writeFileSync(
  `${SNAP}/agents-project-fixture.json`,
  JSON.stringify({ generatedAt: now, projects: fixture, recentCompleted }, null, 2),
);
console.log(`projects: ${fixture.length}`);
for (const p of fixture.slice(0, 20)) {
  console.log(
    `  ${p.slug.padEnd(22)} agents=${String(p.agents.length).padStart(2)} sess=${String(p.sessionCount).padStart(3)} work=${p.working} needs=${p.needs} ${p.harnesses.join("/")} :: ${p.root ?? "—"}`,
  );
}
