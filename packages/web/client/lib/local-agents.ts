import { useEffect, useMemo, useState } from "react";
import { api } from "./api.ts";
import { useScout } from "../scout/Provider.tsx";
import type { Agent } from "./types.ts";

export type HarnessAttribution = "scout-managed" | "hudson-managed" | "unattributed";

export type DiscoveredProcess = {
  pid: number;
  ppid: number;
  command: string;
  etime: string;
  cwd: string | null;
  harness: HarnessAttribution;
  source: string;
  parentChain: { pid: number; command: string }[];
};

export type DiscoveredTranscript = {
  source: string;
  transcriptPath: string;
  sessionId: string | null;
  cwd: string | null;
  project: string;
  harness: HarnessAttribution;
  lastEventAt?: number | null;
  mtimeMs: number;
  size: number;
};

export type DiscoverySnapshot = {
  generatedAt: number;
  processes: DiscoveredProcess[];
  transcripts: DiscoveredTranscript[];
  totals: {
    total: number;
    scoutManaged: number;
    hudsonManaged: number;
    unattributed: number;
    transcripts: number;
  };
};

function projectFromPath(p: string | null): string | null {
  if (!p) return null;
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

export function synthesizeOrganicAgents(
  discovery: DiscoverySnapshot | null,
  scoutAgents: Agent[],
): Agent[] {
  if (!discovery) return [];

  const scoutCwds = new Set<string>();
  for (const a of scoutAgents) {
    if (a.cwd) scoutCwds.add(a.cwd);
    if (a.projectRoot) scoutCwds.add(a.projectRoot);
  }

  const transcriptByCwd = new Map<string, DiscoveredTranscript>();
  for (const t of discovery.transcripts) {
    if (!t.cwd) continue;
    const existing = transcriptByCwd.get(t.cwd);
    const activityAt = t.lastEventAt ?? t.mtimeMs;
    const existingActivityAt = existing?.lastEventAt ?? existing?.mtimeMs ?? 0;
    if (!existing || activityAt > existingActivityAt) transcriptByCwd.set(t.cwd, t);
  }

  const synthetic: Agent[] = [];
  for (const p of discovery.processes) {
    if (p.harness === "scout-managed") continue;
    if (p.cwd && scoutCwds.has(p.cwd)) continue;

    const transcript = p.cwd ? transcriptByCwd.get(p.cwd) : undefined;
    const project = transcript?.project ?? projectFromPath(p.cwd) ?? null;
    const updatedAt = transcript?.lastEventAt ?? transcript?.mtimeMs ?? discovery.generatedAt;
    const sessionId = transcript?.sessionId ?? null;

    synthetic.push({
      id: `harness:${p.source}:${p.pid}`,
      definitionId: `harness:${p.source}:${p.pid}`,
      name: p.source,
      handle: null,
      agentClass: "organic",
      harness: p.source,
      state: "working",
      projectRoot: p.cwd,
      cwd: p.cwd,
      updatedAt,
      createdAt: null,
      transport: null,
      selector: null,
      defaultSelector: null,
      nodeQualifier: null,
      workspaceQualifier: null,
      wakePolicy: null,
      capabilities: [],
      project,
      branch: null,
      role: null,
      model: null,
      harnessSessionId: sessionId,
      terminalSurface: null,
      harnessLogPath: transcript?.transcriptPath ?? null,
      conversationId: sessionId ?? `harness:${p.pid}`,
      homeNodeId: null,
      homeNodeName: null,
      ownerId: null,
      ownerName: null,
      ownerHandle: null,
      staleLocalRegistration: false,
      retiredFromFleet: false,
      replacedByAgentId: null,
    });
  }
  return synthetic;
}

export function useLocalAgents(): {
  agents: Agent[];
  scoutAgents: Agent[];
  organicAgents: Agent[];
  discovery: DiscoverySnapshot | null;
} {
  const { agents: scoutAgents } = useScout();
  const [discovery, setDiscovery] = useState<DiscoverySnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const data = await api<DiscoverySnapshot>("/api/tail/discover").catch(() => null);
      if (!cancelled) setDiscovery(data);
    };
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  const organicAgents = useMemo(
    () => synthesizeOrganicAgents(discovery, scoutAgents),
    [discovery, scoutAgents],
  );

  const agents = useMemo(
    () => [...scoutAgents, ...organicAgents],
    [scoutAgents, organicAgents],
  );

  return { agents, scoutAgents, organicAgents, discovery };
}
