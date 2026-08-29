/* Crew & Workspaces — the agent-first projection over the inbox model.

   The inbox model (projects-inbox-model.ts) collapses agents PER PROJECT —
   the same crew member working two repos shows up as two InboxThread rows.
   Crew & Workspaces re-collapses those rows by agent identity so a crew
   member is one card with N attached project substrates, and offers the
   inverse projection (one workspace, its stationed crew) for free from the
   same source rows. Pure + dependency-light, mirroring the inbox model. */

import type { Agent } from "../../lib/types.ts";
import { CREW_ART, resolveCastSlug } from "../../lib/crew-registry.ts";
import { agentSpecialization } from "./agent-specialization.ts";
import type { InboxProject, InboxThread } from "./projects-inbox-model.ts";

export type CrewStatus = "needs" | "working" | "thinking" | "idle";

export type CrewSubstrate = {
  threadId: string;
  projectSlug: string;
  projectTitle: string;
  projectRoot: string | null;
  branch: string | null;
  working: boolean;
  needs: boolean;
  lastActivityAt: number;
  sessionCount: number;
  work: string;
  conversationId: string | null;
};

export type CrewMember = {
  /** Stable across refreshes — agent id when known, else a name+harness fallback. */
  key: string;
  agentId: string | null;
  name: string;
  harness: string;
  model: string | null;
  effort: string | null;
  castSlug: string;
  kernel: string | null;
  headline: string;
  status: CrewStatus;
  needs: boolean;
  working: boolean;
  /** Attached project substrates, most active/recent first. */
  substrates: CrewSubstrate[];
  /** The substrate driving `status` — the card's headline task. */
  primary: CrewSubstrate;
  lastActivityAt: number;
  sessionCount: number;
};

export type WorkspaceCrewStation = {
  member: CrewMember;
  substrate: CrewSubstrate;
};

export type WorkspaceEntry = {
  slug: string;
  title: string;
  root: string | null;
  crew: WorkspaceCrewStation[];
  needs: number;
  working: number;
  agentCount: number;
  sessionCount: number;
  lastActivityAt: number;
};

export type RuntimeCrewStation = {
  member: CrewMember;
  substrate: CrewSubstrate;
};

export type RuntimeEntry = {
  harness: string;
  title: string;
  crew: RuntimeCrewStation[];
  needs: number;
  working: number;
  agentCount: number;
  sessionCount: number;
  lastActivityAt: number;
};

function crewKey(thread: InboxThread): string {
  return thread.agentId ? `agent:${thread.agentId}` : `named:${thread.harness}:${thread.agentName.toLowerCase()}`;
}

function crewStatus(needs: boolean, working: boolean, rawState: string | null | undefined): CrewStatus {
  if (needs) return "needs";
  if ((rawState ?? "").toLowerCase().includes("think")) return "thinking";
  if (working) return "working";
  return "idle";
}

function crewRank(member: CrewMember): number {
  switch (member.status) {
    case "needs":
      return 3;
    case "working":
      return 2;
    case "thinking":
      return 1;
    case "idle":
      return 0;
  }
}

/** Re-collapse per-project agent threads into one card per crew identity. */
export function buildCrewMembers(threads: InboxThread[], agentsById: Map<string, Agent>): CrewMember[] {
  const byKey = new Map<string, CrewMember & { rawState: string | null }>();

  for (const thread of threads) {
    if (thread.kind !== "agent") continue;
    const key = crewKey(thread);
    const substrate: CrewSubstrate = {
      threadId: thread.id,
      projectSlug: thread.projectSlug,
      projectTitle: thread.projectTitle,
      projectRoot: thread.projectRoot,
      branch: thread.branch,
      working: thread.working,
      needs: thread.needs,
      lastActivityAt: thread.lastActivityAt,
      sessionCount: thread.sessionCount,
      work: thread.work,
      conversationId: thread.conversationId,
    };

    const existing = byKey.get(key);
    if (existing) {
      existing.substrates.push(substrate);
      existing.needs = existing.needs || thread.needs;
      existing.working = existing.working || thread.working;
      existing.lastActivityAt = Math.max(existing.lastActivityAt, thread.lastActivityAt);
      existing.sessionCount += thread.sessionCount;
      continue;
    }

    const agent = thread.agentId ? agentsById.get(thread.agentId) ?? null : null;
    const castSlug = resolveCastSlug(thread.agentName, true) ?? "milo";
    const headline = agent ? agentSpecialization(agent).headline : "Generalist";
    byKey.set(key, {
      key,
      agentId: thread.agentId,
      name: thread.agentName,
      harness: thread.harness,
      model: agent?.model ?? null,
      effort: agent?.reasoningEffort ?? null,
      castSlug,
      kernel: CREW_ART[castSlug]?.kernel ?? null,
      headline,
      status: "idle",
      needs: thread.needs,
      working: thread.working,
      substrates: [substrate],
      primary: substrate,
      lastActivityAt: thread.lastActivityAt,
      sessionCount: thread.sessionCount,
      rawState: agent?.state ?? null,
    });
  }

  const members = [...byKey.values()].map((member) => {
    const substrates = [...member.substrates].sort(
      (a, b) => Number(b.working) - Number(a.working) || Number(b.needs) - Number(a.needs) || b.lastActivityAt - a.lastActivityAt,
    );
    const { rawState, ...rest } = member;
    return {
      ...rest,
      substrates,
      primary: substrates[0] ?? member.primary,
      status: crewStatus(member.needs, member.working, rawState),
    };
  });

  members.sort(
    (a, b) => crewRank(b) - crewRank(a) || b.lastActivityAt - a.lastActivityAt || a.name.localeCompare(b.name),
  );
  return members;
}

/** The inverse projection — group the same rows by their project substrate. */
export function buildWorkspaceLens(members: CrewMember[], projects: InboxProject[]): WorkspaceEntry[] {
  const stationsBySlug = new Map<string, WorkspaceCrewStation[]>();
  for (const member of members) {
    for (const substrate of member.substrates) {
      const list = stationsBySlug.get(substrate.projectSlug) ?? [];
      list.push({ member, substrate });
      stationsBySlug.set(substrate.projectSlug, list);
    }
  }

  return projects
    .map((project) => {
      const crew = (stationsBySlug.get(project.slug) ?? []).sort(
        (a, b) =>
          Number(b.substrate.working) - Number(a.substrate.working)
          || Number(b.substrate.needs) - Number(a.substrate.needs)
          || b.substrate.lastActivityAt - a.substrate.lastActivityAt,
      );
      return {
        slug: project.slug,
        title: project.title,
        root: project.root,
        crew,
        needs: project.needs,
        working: project.working,
        agentCount: project.agentCount,
        sessionCount: project.sessionCount,
        lastActivityAt: project.lastActivityAt,
      };
    })
    .sort(
      (a, b) => Number(b.needs > 0) - Number(a.needs > 0)
        || Number(b.working > 0) - Number(a.working > 0)
        || b.lastActivityAt - a.lastActivityAt
        || a.title.localeCompare(b.title),
    );
}

/** The runtime projection — group the crew members by engine (harness). */
export function buildRuntimeLens(members: CrewMember[]): RuntimeEntry[] {
  const byHarness = new Map<string, RuntimeCrewStation[]>();
  for (const member of members) {
    const normHarness = member.harness.toLowerCase();
    const list = byHarness.get(normHarness) ?? [];
    list.push({ member, substrate: member.primary });
    byHarness.set(normHarness, list);
  }

  return [...byHarness.entries()]
    .map(([harness, stations]) => {
      const crew = stations.sort(
        (a, b) =>
          Number(b.member.status === "needs") - Number(a.member.status === "needs")
          || Number(b.member.status === "working") - Number(a.member.status === "working")
          || b.member.lastActivityAt - a.member.lastActivityAt
          || a.member.name.localeCompare(b.member.name),
      );
      const needs = crew.filter((s) => s.member.status === "needs").length;
      const working = crew.filter((s) => s.member.status === "working" || s.member.status === "thinking").length;
      const sessionCount = crew.reduce((sum, s) => sum + s.member.sessionCount, 0);
      const lastActivityAt = crew.reduce((max, s) => Math.max(max, s.member.lastActivityAt), 0);
      const title = harness ? harness.charAt(0).toUpperCase() + harness.slice(1) : "Unknown";
      return {
        harness,
        title,
        crew,
        needs,
        working,
        agentCount: crew.length,
        sessionCount,
        lastActivityAt,
      };
    })
    .sort(
      (a, b) =>
        Number(b.needs > 0) - Number(a.needs > 0)
        || Number(b.working > 0) - Number(a.working > 0)
        || b.lastActivityAt - a.lastActivityAt
        || a.title.localeCompare(b.title),
    );
}

export type CrewStatusFilter = "all" | "active" | "needs" | "idle";

export function memberMatchesStatus(member: CrewMember, filter: CrewStatusFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "active":
      return member.status === "working" || member.status === "thinking";
    case "needs":
      return member.status === "needs";
    case "idle":
      return member.status === "idle";
  }
}

export function memberMatchesHarness(member: CrewMember, harness: string): boolean {
  return harness === "all" || member.harness.toLowerCase() === harness.toLowerCase();
}

export function memberMatchesQuery(member: CrewMember, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (member.name.toLowerCase().includes(needle)) return true;
  if (member.headline.toLowerCase().includes(needle)) return true;
  if (member.harness.toLowerCase().includes(needle)) return true;
  if (member.model?.toLowerCase().includes(needle)) return true;
  if (member.castSlug.toLowerCase().includes(needle)) return true;
  return member.substrates.some(
    (substrate) => substrate.projectTitle.toLowerCase().includes(needle) || substrate.work.toLowerCase().includes(needle),
  );
}

export function crewHarnesses(members: CrewMember[]): string[] {
  return [...new Set(members.map((member) => member.harness.toLowerCase()))].sort();
}

export function crewStatusLabel(status: CrewStatus): string {
  switch (status) {
    case "needs":
      return "Needs attention";
    case "working":
      return "Working";
    case "thinking":
      return "Thinking";
    case "idle":
      return "Idle";
  }
}
